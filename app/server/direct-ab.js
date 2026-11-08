import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { AppError, event, requireBusiness, transaction } from "./db.js";
import { directChangeForPreflight } from "./direct.js";
import { directExecution } from "./direct-execution.js";
import { wilson } from "./engine.js";

export const abPlanSchema = z
  .object({
    hypothesis: z.string().trim().min(12).max(500),
    variant: z
      .object({
        title: z.string().trim().min(2).max(56),
        text: z.string().trim().min(2).max(81),
      })
      .strict(),
    minDays: z.number().int().min(0).max(30).default(0),
    minImpressionsPerVariant: z
      .number()
      .int()
      .min(0)
      .max(100000)
      .default(0),
  })
  .strict();

function observation(db, row, plan) {
  const snapshot = db
    .prepare(
      `SELECT rs.*,j.payload AS job_payload
       FROM report_snapshots rs JOIN jobs j ON j.id=rs.job_id
       WHERE rs.business_id=? ORDER BY rs.rowid DESC LIMIT 20`,
    )
    .all(row.business_id)
    .find((candidate) => {
      const payload = JSON.parse(candidate.job_payload);
      return payload.reportType === "ad" && payload.abPlanId === row.id;
    });
  if (!snapshot)
    return {
      status: "unavailable",
      verdict: "Статистика по объявлениям ещё не получена.",
      reportId: null,
      dateTo: null,
      days: 0,
      allocationBalanced: false,
      sampleMet: false,
      control: { impressions: 0, clicks: 0, ctr: null, interval: null },
      variant: { impressions: 0, clicks: 0, ctr: null, interval: null },
    };
  const rows = JSON.parse(snapshot.rows_json),
    summarize = (adId) =>
      rows
        .filter((item) => String(item.AdId) === String(adId))
        .reduce(
          (total, item) => ({
            impressions: total.impressions + item.impressions,
            clicks: total.clicks + item.clicks,
          }),
          { impressions: 0, clicks: 0 },
        ),
    decorate = (result) => ({
      ...result,
      ctr: result.impressions ? result.clicks / result.impressions : null,
      interval: result.impressions
        ? wilson(result.clicks, result.impressions)
        : null,
    }),
    control = decorate(summarize(plan.control.adId)),
    variant = decorate(summarize(plan.variant.adId)),
    totalImpressions = control.impressions + variant.impressions,
    controlShare = totalImpressions
      ? control.impressions / totalImpressions
      : null,
    allocationBalanced =
      controlShare !== null && controlShare >= 0.4 && controlShare <= 0.6,
    sampleMet = [control, variant].every((item) => item.impressions > 0),
    days = Math.max(
      0,
      Math.floor(
        (Date.parse(snapshot.date_to + "T00:00:00Z") -
          Date.parse(plan.periodStart + "T00:00:00Z")) /
          86400000,
      ) + 1,
    );
  let status = "collecting",
    verdict = "Анализ начнётся, когда оба объявления получат показы.";
  if (sampleMet) {
    if (!allocationBalanced) {
      status = "inconclusive";
      verdict =
        "Предварительный анализ: показы между объявлениями распределены неравномерно.";
    } else if (control.interval[1] < variant.interval[0]) {
      status = "variant_wins";
      verdict =
        "Вариант Б имеет более высокий CTR с непересекающимся 95% интервалом.";
    } else if (variant.interval[1] < control.interval[0]) {
      status = "control_wins";
      verdict =
        "Вариант А имеет более высокий CTR с непересекающимся 95% интервалом.";
    } else {
      status = "inconclusive";
      verdict = "Анализ обновлён: убедительного различия CTR пока нет.";
    }
  }
  return {
    status,
    verdict,
    reportId: snapshot.id,
    dateTo: snapshot.date_to,
    days,
    allocationBalanced,
    sampleMet,
    controlShare,
    control,
    variant,
  };
}

function view(db, row, action = null) {
  const plan = JSON.parse(row.plan_json);
  const decisionRow = db
    .prepare(
      "SELECT * FROM direct_ab_decision_actions WHERE plan_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1",
    )
    .get(row.id);
  const evidence = observation(db, row, plan),
    blockers = [];
  if (!plan.variant.adId)
    blockers.push("Вариант Б ещё не создан и не сверён в Директе.");
  if (!evidence.reportId) {
    blockers.push("Равное распределение показов не подтверждено.");
    blockers.push("Нет статистики по двум объявлениям за весь срок теста.");
  } else {
    if (!evidence.allocationBalanced)
      blockers.push(
        "Распределение показов между вариантами не близко к 50/50.",
      );
  }
  return {
    id: row.id,
    changeId: row.change_id,
    campaignId: row.campaign_id,
    ...plan,
    outcome: evidence.status,
    verdict: evidence.verdict,
    evidence,
    blockers,
    createdAt: row.created_at,
    status:
      decisionRow?.status === "succeeded"
        ? decisionRow.operation === "rollback_variant"
          ? "variant_rolled_back"
          : "outcome_applied"
        : plan.variant.adId
          ? "variant_created_held"
          : "planned_unpublished",
    decision: decisionRow
      ? {
          id: decisionRow.id,
          operation: decisionRow.operation,
          targetAdId: decisionRow.target_ad_id,
          status: decisionRow.status,
          writeAttempted: !!decisionRow.write_attempted,
          errorCode: decisionRow.error_code,
          beforeState: decisionRow.before_state,
          afterState: decisionRow.after_state,
          updatedAt: decisionRow.updated_at,
        }
      : null,
    externalWrites: action?.write_attempted ? 1 : 0,
    action: action
      ? {
          id: action.id,
          status: action.status,
          variantAdId: action.variant_ad_id,
          writeAttempted: !!action.write_attempted,
          errorCode: action.error_code,
          updatedAt: action.updated_at,
        }
      : null,
  };
}

export function directAbPlans(db, userId, businessId) {
  requireBusiness(db, userId, businessId);
  return db
    .prepare(
      "SELECT * FROM direct_ab_plans WHERE business_id=? ORDER BY created_at DESC,rowid DESC LIMIT 20",
    )
    .all(businessId)
    .map((row) =>
      view(
        db,
        row,
        db
          .prepare(
            "SELECT * FROM direct_ab_actions WHERE plan_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1",
          )
          .get(row.id),
      ),
    );
}

export function directAbVariantForChange(db, businessId, changeId) {
  const row = db
    .prepare(
      "SELECT id,plan_json FROM direct_ab_plans WHERE business_id=? AND change_id=?",
    )
    .get(businessId, changeId);
  if (!row) return null;
  const plan = JSON.parse(row.plan_json);
  const retired = plan.variant?.adId
    ? db
        .prepare(
          `SELECT 1 FROM direct_ab_decision_actions
           WHERE plan_id=? AND target_ad_id=? AND status='succeeded'
           AND operation IN ('rollback_variant','apply_outcome')
           ORDER BY rowid DESC LIMIT 1`,
        )
        .get(row.id, String(plan.variant.adId))
    : null;
  return plan.variant?.adId
    ? retired
      ? null
      : {
          adId: String(plan.variant.adId),
          title: plan.variant.title,
          text: plan.variant.text,
          href: plan.variant.href,
        }
    : null;
}

export function directAbPlanView(db, userId, businessId, planId) {
  requireBusiness(db, userId, businessId);
  const row = db
    .prepare("SELECT * FROM direct_ab_plans WHERE id=? AND business_id=?")
    .get(planId, businessId);
  if (!row) throw new AppError(404, "A/B-план не найден.");
  const action = db
    .prepare(
      "SELECT * FROM direct_ab_actions WHERE plan_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1",
    )
    .get(planId);
  return view(db, row, action);
}

function moscowDate(now) {
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Europe/Moscow",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(now));
}

function inclusiveDays(from, to) {
  return (
    (Date.parse(to + "T00:00:00Z") - Date.parse(from + "T00:00:00Z")) /
      86400000 +
    1
  );
}

export function createDirectAbPlan(
  db,
  userId,
  businessId,
  changeId,
  idempotencyKey,
  rawInput,
  { now = Date.now() } = {},
) {
  const input = abPlanSchema.parse(rawInput);
  const fingerprint = createHash("sha256")
    .update(JSON.stringify({ changeId, input }))
    .digest("hex");
  return transaction(db, () => {
    const { business, change } = directChangeForPreflight(
      db,
      userId,
      businessId,
      changeId,
    );
    if (business.state.mode !== "live")
      throw new AppError(
        409,
        "A/B-план доступен только для подключенного бизнеса.",
      );
    const previous = db
      .prepare(
        "SELECT * FROM direct_ab_plans WHERE business_id=? AND idempotency_key=?",
      )
      .get(businessId, idempotencyKey);
    if (previous) {
      if (
        previous.fingerprint !== fingerprint ||
        previous.change_id !== changeId
      )
        throw new AppError(
          409,
          "Ключ уже использован для другого A/B-плана.",
          "idempotency_conflict",
        );
      return view(db, previous);
    }
    if (
      db
        .prepare(
          "SELECT 1 FROM direct_ab_plans WHERE business_id=? AND change_id=?",
        )
        .get(businessId, changeId)
    )
      throw new AppError(409, "Для этой кампании A/B-план уже зафиксирован.");
    const execution = directExecution(db, userId, businessId, changeId);
    if (execution.status !== "succeeded" || !execution.suspendVerified)
      throw new AppError(409, "Сначала завершите и сверьте создание кампании.");
    const campaignId = execution.calls.find((call) => call.key === "campaign")
      ?.ids[0];
    const adIds = execution.calls.find((call) => call.key === "ads")?.ids;
    if (
      !Number.isSafeInteger(campaignId) ||
      campaignId <= 0 ||
      !Array.isArray(adIds) ||
      adIds.length !== 1 ||
      !/^\d+$/.test(String(adIds[0])) ||
      change.plan.ads.length !== 1
    )
      throw new AppError(
        409,
        "Нужна сверенная кампания с одним контрольным объявлением.",
      );
    const connectionId = db
      .prepare("SELECT connection_id FROM direct_executions WHERE change_id=?")
      .get(changeId)?.connection_id;
    const connection = db
      .prepare(
        "SELECT metadata FROM connections WHERE business_id=? AND provider='yandex'",
      )
      .get(businessId);
    if (
      !connectionId ||
      !connection ||
      JSON.parse(connection.metadata).connectionId !== connectionId
    )
      throw new AppError(
        409,
        "Яндекс-кабинет изменился после создания кампании.",
      );
    if (moscowDate(now) >= change.plan.periodStart)
      throw new AppError(
        409,
        "Гипотезу нужно зафиксировать до начала периода кампании.",
      );
    if (
      inclusiveDays(change.plan.periodStart, change.plan.periodEnd) <
      input.minDays
    )
      throw new AppError(
        409,
        "Период кампании короче минимального срока эксперимента.",
      );
    const control = change.plan.ads[0];
    if (
      control.title === input.variant.title &&
      control.text === input.variant.text
    )
      throw new AppError(
        409,
        "Вариант B должен отличаться от контрольного объявления.",
      );
    const plan = {
      hypothesis: input.hypothesis,
      metric: "ctr",
      minDays: input.minDays,
      minImpressionsPerVariant: input.minImpressionsPerVariant,
      periodStart: change.plan.periodStart,
      periodEnd: change.plan.periodEnd,
      control: {
        adId: String(adIds[0]),
        title: control.title,
        text: control.text,
        href: control.href,
      },
      variant: {
        title: input.variant.title,
        text: input.variant.text,
        href: control.href,
        adId: null,
      },
      allocation: "50/50 target; not verified",
      outcome: "unavailable",
      blockers: [
        "Вариант B ещё не создан и не сверён в Директе.",
        "Равное распределение показов не подтверждено.",
        "Нет статистики по двум объявлениям за весь срок теста.",
      ],
    };
    const id = randomUUID(),
      at = new Date(now).toISOString();
    db.prepare(
      `INSERT INTO direct_ab_plans(
      id,business_id,change_id,connection_id,campaign_id,control_ad_id,
      idempotency_key,fingerprint,plan_json,created_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      id,
      businessId,
      changeId,
      connectionId,
      campaignId,
      String(adIds[0]),
      idempotencyKey,
      fingerprint,
      JSON.stringify(plan),
      at,
    );
    event(db, businessId, {
      kind: "direct_ab_plan",
      title: "A/B-гипотеза зафиксирована",
      reason: `Кампания ${campaignId}: план с контрольным объявлением ${adIds[0]}; публикации варианта не было.`,
      rule: "direct/ab-plan@1",
      jobId: id,
    });
    return view(
      db,
      db.prepare("SELECT * FROM direct_ab_plans WHERE id=?").get(id),
    );
  });
}
