import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { AppError, event, requireBusiness, transaction } from "./db.js";
import { directChangeForPreflight } from "./direct.js";
import { directExecution } from "./direct-execution.js";

const segmentSchema = z
  .object({ name: z.string().trim().min(2).max(100), value: z.string().trim().min(1).max(200) })
  .strict();

export const audienceExperimentSchema = z
  .object({
    hypothesis: z.string().trim().min(12).max(500),
    dimension: z.enum([
      "geo_radius",
      "search_intent",
      "interest_group",
      "visitor_type",
      "need_wording",
    ]),
    control: segmentSchema,
    variant: segmentSchema,
    minDays: z.number().int().min(7).max(30).default(7),
    minClicksPerVariant: z.number().int().min(100).max(100000).default(100),
    minGoalsPerVariant: z.number().int().min(3).max(10000).default(5),
    probabilityThreshold: z.number().min(0.9).max(0.999).default(0.95),
    minimumRelativeLift: z.number().min(0.05).max(1).default(0.15),
  })
  .strict();

const observationSchema = z
  .object({
    snapshotKey: z.string().trim().min(1).max(200),
    periodFrom: z.iso.date(),
    periodTo: z.iso.date(),
    control: z.object({ clicks: z.number().int().nonnegative(), goals: z.number().int().nonnegative() }).strict(),
    variant: z.object({ clicks: z.number().int().nonnegative(), goals: z.number().int().nonnegative() }).strict(),
    source: z.object({ directReportId: z.string().min(1), metricaSnapshotId: z.string().min(1) }).strict(),
  })
  .strict()
  .superRefine((value, context) => {
    for (const key of ["control", "variant"])
      if (value[key].goals > value[key].clicks)
        context.addIssue({ code: "custom", path: [key, "goals"], message: "Целей не может быть больше кликов." });
    if (value.periodTo < value.periodFrom)
      context.addIssue({ code: "custom", path: ["periodTo"], message: "Некорректный период наблюдения." });
  });

const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const daysInclusive = (from, to) =>
  Math.floor((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000) + 1;
const moscowDate = (now) =>
  new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Europe/Moscow",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(now));

function erf(value) {
  const sign = value < 0 ? -1 : 1,
    x = Math.abs(value),
    t = 1 / (1 + 0.3275911 * x),
    result =
      1 -
      (((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t -
        0.284496736) *
        t +
        0.254829592) *
        t) *
        Math.exp(-x * x);
  return sign * result;
}

function betaSummary(goals, clicks) {
  const alpha = goals + 1,
    beta = clicks - goals + 1,
    total = alpha + beta;
  return {
    alpha,
    beta,
    mean: alpha / total,
    variance: (alpha * beta) / (total * total * (total + 1)),
  };
}

function analyse(row, observation) {
  const criteria = JSON.parse(row.criteria_json);
  if (!observation)
    return {
      status: "planned",
      conclusion: "Эксперимент зафиксирован, статистика ещё не получена.",
      appliedAction: "none",
    };
  const control = JSON.parse(observation.control_json),
    variant = JSON.parse(observation.variant_json),
    totalClicks = control.clicks + variant.clicks,
    controlShare = totalClicks ? control.clicks / totalClicks : null,
    allocationBalanced = controlShare !== null && controlShare >= 0.4 && controlShare <= 0.6,
    durationDays = daysInclusive(observation.period_from, observation.period_to),
    durationMet = durationDays >= criteria.minDays,
    sampleMet =
      control.clicks >= criteria.minClicksPerVariant &&
      variant.clicks >= criteria.minClicksPerVariant &&
      control.goals >= criteria.minGoalsPerVariant &&
      variant.goals >= criteria.minGoalsPerVariant,
    final = observation.period_to >= criteria.periodEnd,
    a = betaSummary(control.goals, control.clicks),
    b = betaSummary(variant.goals, variant.clicks),
    z = (b.mean - a.mean) / Math.sqrt(a.variance + b.variance),
    probabilityVariantBetter = 0.5 * (1 + erf(z / Math.sqrt(2))),
    relativeLift = a.mean ? (b.mean - a.mean) / a.mean : null;
  let status = "collecting",
    conclusion = "Период теста ещё не завершён; ранний выбор победителя запрещён.";
  if (final) {
    if (!durationMet || !sampleMet || !allocationBalanced) {
      status = "inconclusive";
      conclusion = "Тест завершён без вывода: срок, выборка или распределение трафика не соответствуют протоколу.";
    } else if (
      probabilityVariantBetter >= criteria.probabilityThreshold &&
      relativeLift >= criteria.minimumRelativeLift
    ) {
      status = "variant_wins";
      conclusion = "Сегмент Б превосходит контроль с заданной вероятностью и практически значимым эффектом.";
    } else if (
      1 - probabilityVariantBetter >= criteria.probabilityThreshold &&
      relativeLift !== null &&
      relativeLift <= -criteria.minimumRelativeLift
    ) {
      status = "control_wins";
      conclusion = "Контрольный сегмент превосходит вариант с заданной вероятностью и практически значимым эффектом.";
    } else {
      status = "inconclusive";
      conclusion = "Убедительного и практически значимого различия сегментов не обнаружено.";
    }
  }
  return {
    status,
    conclusion,
    appliedAction: "none",
    evidence: {
      snapshotKey: observation.snapshot_key,
      periodFrom: observation.period_from,
      periodTo: observation.period_to,
      durationDays,
      durationMet,
      sampleMet,
      allocationBalanced,
      controlShare,
      probabilityVariantBetter,
      relativeLift,
      control: { ...control, posteriorRate: a.mean },
      variant: { ...variant, posteriorRate: b.mean },
      source: JSON.parse(observation.source_json),
    },
  };
}

function view(db, row) {
  const latest = db
    .prepare("SELECT * FROM audience_experiment_observations WHERE experiment_id=? ORDER BY observed_at DESC,rowid DESC LIMIT 1")
    .get(row.id);
  const result = analyse(row, latest);
  return {
    id: row.id,
    changeId: row.change_id,
    hypothesis: row.hypothesis,
    dimension: row.dimension,
    metric: "goal_rate_per_click",
    allocation: "50/50",
    control: JSON.parse(row.control_json),
    variant: JSON.parse(row.variant_json),
    criteria: JSON.parse(row.criteria_json),
    ...result,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function audienceExperiments(db, userId, businessId) {
  requireBusiness(db, userId, businessId);
  return db
    .prepare("SELECT * FROM audience_experiments WHERE business_id=? ORDER BY created_at DESC,rowid DESC LIMIT 20")
    .all(businessId)
    .map((row) => view(db, row));
}

export function createAudienceExperiment(
  db,
  userId,
  businessId,
  changeId,
  idempotencyKey,
  rawInput,
  { now = Date.now() } = {},
) {
  const input = audienceExperimentSchema.parse(rawInput);
  if (input.control.value.toLocaleLowerCase("ru") === input.variant.value.toLocaleLowerCase("ru"))
    throw new AppError(400, "Сегменты должны различаться одним выбранным признаком.");
  const fingerprint = hash({ changeId, input });
  return transaction(db, () => {
    const { business, change } = directChangeForPreflight(db, userId, businessId, changeId);
    if (business.state.mode !== "live")
      throw new AppError(409, "Тест аудитории доступен только для подключенного бизнеса.");
    const previous = db
      .prepare("SELECT * FROM audience_experiments WHERE business_id=? AND idempotency_key=?")
      .get(businessId, idempotencyKey);
    if (previous) {
      if (previous.fingerprint !== fingerprint)
        throw new AppError(409, "Ключ уже использован для другого эксперимента.", "idempotency_conflict");
      return view(db, previous);
    }
    if (db.prepare("SELECT 1 FROM audience_experiments WHERE business_id=? AND change_id=?").get(businessId, changeId))
      throw new AppError(409, "Для этой кампании тест аудитории уже зафиксирован.");
    const execution = directExecution(db, userId, businessId, changeId);
    if (execution.status !== "succeeded" || !execution.suspendVerified)
      throw new AppError(409, "Сначала создайте и сверьте выключенный черновик кампании.");
    const periodStart = change.plan.periodStart,
      periodEnd = change.plan.periodEnd;
    if (moscowDate(now) >= periodStart)
      throw new AppError(409, "Тест аудитории нужно зафиксировать до начала периода кампании.");
    if (daysInclusive(periodStart, periodEnd) < input.minDays)
      throw new AppError(409, "Период кампании короче минимального срока теста.");
    const messageFingerprint = hash(
      change.plan.ads.map(({ title, text, href }) => ({ title, text, href })),
    );
    const criteria = {
      metric: "goal_rate_per_click",
      periodStart,
      periodEnd,
      minDays: input.minDays,
      minClicksPerVariant: input.minClicksPerVariant,
      minGoalsPerVariant: input.minGoalsPerVariant,
      probabilityThreshold: input.probabilityThreshold,
      minimumRelativeLift: input.minimumRelativeLift,
      trafficShareTolerance: 0.1,
      noEarlyWinner: true,
      fixedMessageFingerprint: messageFingerprint,
    };
    const id = randomUUID(),
      at = new Date(now).toISOString();
    db.prepare(
      `INSERT INTO audience_experiments(
       id,business_id,change_id,hypothesis,dimension,control_json,variant_json,
       criteria_json,status,result_json,fingerprint,idempotency_key,created_at,updated_at
       ) VALUES(?,?,?,?,?,?,?,?,?,'null',?,?,?,?)`,
    ).run(
      id,
      businessId,
      changeId,
      input.hypothesis,
      input.dimension,
      JSON.stringify(input.control),
      JSON.stringify(input.variant),
      JSON.stringify(criteria),
      "planned",
      fingerprint,
      idempotencyKey,
      at,
      at,
    );
    event(db, businessId, {
      kind: "audience_experiment_planned",
      title: "Зафиксирован тест аудитории",
      reason: `Сравнивается только признак «${input.dimension}»; сообщение и бюджет вариантов одинаковы. Публикации не было.`,
      rule: "audience-experiment/1",
      jobId: id,
    });
    return view(db, db.prepare("SELECT * FROM audience_experiments WHERE id=?").get(id));
  });
}

export function recordAudienceObservation(
  db,
  businessId,
  experimentId,
  rawObservation,
  { now = Date.now() } = {},
) {
  const input = observationSchema.parse(rawObservation),
    row = db
      .prepare("SELECT * FROM audience_experiments WHERE id=? AND business_id=?")
      .get(experimentId, businessId);
  if (!row) throw new AppError(404, "Тест аудитории не найден.");
  const existing = db
    .prepare("SELECT * FROM audience_experiment_observations WHERE experiment_id=? AND snapshot_key=?")
    .get(experimentId, input.snapshotKey);
  const payloadHash = hash(input);
  if (existing) {
    const existingInput = {
      snapshotKey: existing.snapshot_key,
      periodFrom: existing.period_from,
      periodTo: existing.period_to,
      control: JSON.parse(existing.control_json),
      variant: JSON.parse(existing.variant_json),
      source: JSON.parse(existing.source_json),
    };
    if (hash(existingInput) !== payloadHash)
      throw new AppError(409, "Снимок с таким ключом уже сохранён с другими данными.", "idempotency_conflict");
    return view(db, row);
  }
  return transaction(db, () => {
    const at = new Date(now).toISOString();
    db.prepare(
      `INSERT INTO audience_experiment_observations(
       id,experiment_id,snapshot_key,period_from,period_to,control_json,variant_json,source_json,observed_at
       ) VALUES(?,?,?,?,?,?,?,?,?)`,
    ).run(
      randomUUID(),
      experimentId,
      input.snapshotKey,
      input.periodFrom,
      input.periodTo,
      JSON.stringify(input.control),
      JSON.stringify(input.variant),
      JSON.stringify(input.source),
      at,
    );
    const updated = view(db, row);
    db.prepare("UPDATE audience_experiments SET status=?,result_json=?,updated_at=? WHERE id=?").run(
      updated.status,
      JSON.stringify({ conclusion: updated.conclusion, evidence: updated.evidence }),
      at,
      experimentId,
    );
    return updated;
  });
}
