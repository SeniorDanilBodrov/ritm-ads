import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { AppError } from "./db.js";
import { abPlanSchema } from "./direct-ab.js";
import { audienceExperimentSchema } from "./audience-experiments.js";
import { heldCampaign } from "./direct.js";
import { wilson } from "./engine.js";

const digest = (value) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const ACTIVE = "('checking','sending','needs_reconciliation')";
const CAMPAIGN_ACTION_TABLES = [
  "direct_lifecycle_actions",
  "direct_archive_actions",
  "direct_moderation_actions",
  "direct_resume_actions",
  "direct_budget_actions",
];

const observationSchema = z
  .object({
    snapshotKey: z.string().trim().min(1).max(200),
    periodFrom: z.iso.date(),
    periodTo: z.iso.date(),
    control: z
      .object({
        clicks: z.number().int().nonnegative(),
        goals: z.number().int().nonnegative(),
      })
      .strict(),
    variant: z
      .object({
        clicks: z.number().int().nonnegative(),
        goals: z.number().int().nonnegative(),
      })
      .strict(),
    source: z
      .object({
        directReportId: z.string().min(1),
        metricaSnapshotId: z.string().min(1),
      })
      .strict(),
  })
  .strict()
  .superRefine((value, context) => {
    for (const key of ["control", "variant"])
      if (value[key].goals > value[key].clicks)
        context.addIssue({
          code: "custom",
          path: [key, "goals"],
          message: "Целей не может быть больше кликов.",
        });
    if (value.periodTo < value.periodFrom)
      context.addIssue({
        code: "custom",
        path: ["periodTo"],
        message: "Некорректный период наблюдения.",
      });
  });

const audienceBindingSchema = z
  .object({
    controlCampaignId: z.string().regex(/^[1-9]\d*$/),
    variantCampaignId: z.string().regex(/^[1-9]\d*$/),
    controlAdId: z.string().regex(/^[1-9]\d*$/),
    variantAdId: z.string().regex(/^[1-9]\d*$/),
    budgetPerVariantKopecks: z.number().int().positive(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.controlCampaignId === value.variantCampaignId)
      context.addIssue({
        code: "custom",
        path: ["variantCampaignId"],
        message: "Для теста нужны две разные кампании.",
      });
    if (value.controlAdId === value.variantAdId)
      context.addIssue({
        code: "custom",
        path: ["variantAdId"],
        message: "Для теста нужны два разных объявления.",
      });
  });

function moscowDate(now = Date.now()) {
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Europe/Moscow",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(now));
}

function inclusiveDays(from, to) {
  return (
    Math.floor(
      (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) /
        86400000,
    ) + 1
  );
}

async function ownedBusiness(db, userId, businessId) {
  const row = await db
    .prepare("SELECT * FROM businesses WHERE id=? AND user_id=?")
    .get(businessId, userId);
  if (!row) throw new AppError(404, "Бизнес не найден.", "business_missing");
  return { ...row, state: JSON.parse(row.state) };
}

async function addEvent(db, businessId, payload) {
  const value = { id: randomUUID(), at: new Date().toISOString(), ...payload };
  await db
    .prepare("INSERT INTO events VALUES(?,?,?,?)")
    .run(value.id, businessId, value.at, JSON.stringify(value));
}

async function connectionId(db, businessId) {
  const row = await db
    .prepare(
      "SELECT metadata FROM connections WHERE business_id=? AND provider='yandex'",
    )
    .get(businessId);
  return row ? JSON.parse(row.metadata).connectionId || null : null;
}

async function assertNoOtherCampaignAction(
  db,
  businessId,
  campaignId,
  { includeVariant = true, includeDecision = true } = {},
) {
  const tables = [
    ...CAMPAIGN_ACTION_TABLES,
    ...(includeVariant ? ["direct_ab_actions"] : []),
    ...(includeDecision ? ["direct_ab_decision_actions"] : []),
  ];
  for (const table of tables) {
    const active = await db
      .prepare(
        `SELECT 1 AS found FROM ${table}
         WHERE business_id=? AND campaign_id=? AND status IN ${ACTIVE}`,
      )
      .get(businessId, campaignId);
    if (active)
      throw new AppError(
        409,
        "Другое действие с кампанией ещё не завершено или требует сверки.",
      );
  }
  const optimizer = await db
    .prepare(
      `SELECT 1 AS found FROM optimizer_actions
       WHERE business_id=? AND status IN
       ('proposed','dispatching','needs_reconciliation','rollback_dispatching','rollback_needs_reconciliation')`,
    )
    .get(businessId);
  if (optimizer)
    throw new AppError(
      409,
      "Автопилот уже подготовил или выполняет другое действие. Сначала завершите его сверку.",
    );
}

async function changeContext(db, userId, businessId, changeId) {
  const business = await ownedBusiness(db, userId, businessId);
  const [change, execution] = await Promise.all([
    db
      .prepare("SELECT * FROM direct_changes WHERE id=? AND business_id=?")
      .get(changeId, businessId),
    db
      .prepare(
        "SELECT * FROM direct_executions WHERE change_id=? AND business_id=?",
      )
      .get(changeId, businessId),
  ]);
  if (!change) throw new AppError(404, "Подготовленный план не найден.");
  return {
    business,
    change: { ...change, plan: JSON.parse(change.plan_json) },
    execution: execution
      ? { ...execution, calls: JSON.parse(execution.calls_json) }
      : null,
  };
}

function callId(execution, key) {
  return execution?.calls?.find((item) => item.key === key)?.ids?.[0];
}

function remoteCopy(ad) {
  const titles =
    ad?.ResponsiveAd?.Titles?.map((item) => item.Title) ||
    (ad?.TextAd ? [ad.TextAd.Title] : []);
  const texts =
    ad?.ResponsiveAd?.Texts?.map((item) => item.Text) ||
    (ad?.TextAd ? [ad.TextAd.Text] : []);
  return {
    title: titles[0] || null,
    text: texts[0] || null,
    href: ad?.ResponsiveAd?.Href || ad?.TextAd?.Href || null,
    adImageHash: ad?.TextAd?.AdImageHash || null,
  };
}

function exactAd(ad, expected, adGroupId) {
  const copy = remoteCopy(ad);
  return (
    String(ad?.AdGroupId) === String(adGroupId) &&
    copy.title === expected.title &&
    copy.text === expected.text &&
    copy.href === expected.href &&
    (!expected.adImageHash || copy.adImageHash === expected.adImageHash)
  );
}

function actionView(row) {
  if (!row) return null;
  return {
    id: row.id,
    planId: row.plan_id,
    changeId: row.change_id,
    campaignId: String(row.campaign_id),
    adGroupId: row.ad_group_id ? String(row.ad_group_id) : null,
    controlAdId: row.control_ad_id ? String(row.control_ad_id) : null,
    variantAdId: row.variant_ad_id ? String(row.variant_ad_id) : null,
    targetAdId: row.target_ad_id ? String(row.target_ad_id) : null,
    operation: row.operation || null,
    status: row.status,
    writeAttempted: !!row.write_attempted,
    errorCode: row.error_code,
    beforeState: row.before_state || null,
    afterState: row.after_state || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function latestAbEvidence(db, row, plan) {
  const snapshots = await db
    .prepare(
      `SELECT rs.*,j.payload AS job_payload
       FROM report_snapshots rs JOIN jobs j ON j.id=rs.job_id
       WHERE rs.business_id=? ORDER BY rs.received_at DESC LIMIT 30`,
    )
    .all(row.business_id);
  const snapshot = snapshots.find((candidate) => {
    const payload = JSON.parse(candidate.job_payload);
    return payload.reportType === "ad" && payload.abPlanId === row.id;
  });
  if (!snapshot)
    return {
      status: "unavailable",
      verdict: "Статистика по двум объявлениям ещё не получена.",
      reportId: null,
      dateTo: null,
      days: 0,
      allocationBalanced: false,
      sampleMet: false,
      control: { impressions: 0, clicks: 0, ctr: null, interval: null },
      variant: { impressions: 0, clicks: 0, ctr: null, interval: null },
    };
  const rows = JSON.parse(snapshot.rows_json);
  const summarize = (adId) =>
    rows
      .filter((item) => String(item.AdId) === String(adId))
      .reduce(
        (total, item) => ({
          impressions: total.impressions + Number(item.impressions || 0),
          clicks: total.clicks + Number(item.clicks || 0),
        }),
        { impressions: 0, clicks: 0 },
      );
  const decorate = (result) => ({
    ...result,
    ctr: result.impressions ? result.clicks / result.impressions : null,
    interval: result.impressions
      ? wilson(result.clicks, result.impressions)
      : null,
  });
  const control = decorate(summarize(plan.control.adId));
  const variant = decorate(summarize(plan.variant.adId));
  const totalImpressions = control.impressions + variant.impressions;
  const controlShare = totalImpressions
    ? control.impressions / totalImpressions
    : null;
  const allocationBalanced =
    controlShare !== null && controlShare >= 0.4 && controlShare <= 0.6;
  const sampleMet = [control, variant].every((item) => item.impressions > 0);
  const days = inclusiveDays(plan.periodStart, snapshot.date_to);
  let status = "collecting";
  let verdict = "Анализ начнётся, когда оба объявления получат показы.";
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

async function directAbView(db, row) {
  const plan = JSON.parse(row.plan_json);
  const [variantAction, decision, evidence] = await Promise.all([
    db
      .prepare(
        "SELECT * FROM direct_ab_actions WHERE plan_id=? ORDER BY created_at DESC LIMIT 1",
      )
      .get(row.id),
    db
      .prepare(
        "SELECT * FROM direct_ab_decision_actions WHERE plan_id=? ORDER BY created_at DESC LIMIT 1",
      )
      .get(row.id),
    latestAbEvidence(db, row, plan),
  ]);
  const blockers = [];
  if (!plan.variant.adId)
    blockers.push("Вариант Б ещё не создан и не сверён в Директе.");
  if (!evidence.reportId) {
    blockers.push("Нет отчёта по двум объявлениям за весь срок теста.");
  } else {
    if (!evidence.allocationBalanced)
      blockers.push(
        "Распределение показов между вариантами не близко к 50/50.",
      );
  }
  return {
    id: row.id,
    changeId: row.change_id,
    campaignId: String(row.campaign_id),
    ...plan,
    outcome: evidence.status,
    verdict: evidence.verdict,
    evidence,
    blockers,
    createdAt: row.created_at,
    status:
      decision?.status === "succeeded"
        ? decision.operation === "rollback_variant"
          ? "variant_rolled_back"
          : "outcome_applied"
        : plan.variant.adId
          ? "variant_created_held"
          : "planned_unpublished",
    action: actionView(variantAction),
    decision: actionView(decision),
  };
}

export async function postgresDirectAbPlans(db, userId, businessId) {
  await ownedBusiness(db, userId, businessId);
  const rows = await db
    .prepare(
      "SELECT * FROM direct_ab_plans WHERE business_id=? ORDER BY created_at DESC LIMIT 20",
    )
    .all(businessId);
  return Promise.all(rows.map((row) => directAbView(db, row)));
}

export async function postgresDirectAbActions(
  db,
  userId,
  businessId,
  changeId,
) {
  await ownedBusiness(db, userId, businessId);
  const change = await db
    .prepare("SELECT id FROM direct_changes WHERE id=? AND business_id=?")
    .get(changeId, businessId);
  if (!change) throw new AppError(404, "Подготовленный план не найден.");
  const rows = await db
    .prepare(
      `SELECT * FROM direct_ab_actions
       WHERE business_id=? AND change_id=? ORDER BY created_at DESC LIMIT 10`,
    )
    .all(businessId, changeId);
  return rows.map(actionView);
}

export async function postgresDirectAbDecisionActions(
  db,
  userId,
  businessId,
  planId,
) {
  await ownedBusiness(db, userId, businessId);
  const plan = await db
    .prepare("SELECT id FROM direct_ab_plans WHERE id=? AND business_id=?")
    .get(planId, businessId);
  if (!plan) throw new AppError(404, "A/B-план не найден.");
  const rows = await db
    .prepare(
      `SELECT * FROM direct_ab_decision_actions
       WHERE business_id=? AND plan_id=? ORDER BY created_at DESC LIMIT 10`,
    )
    .all(businessId, planId);
  return rows.map(actionView);
}

export async function postgresDirectAbPlanView(db, userId, businessId, planId) {
  await ownedBusiness(db, userId, businessId);
  const row = await db
    .prepare("SELECT * FROM direct_ab_plans WHERE id=? AND business_id=?")
    .get(planId, businessId);
  if (!row) throw new AppError(404, "A/B-план не найден.");
  return directAbView(db, row);
}

export async function createPostgresDirectAbPlan(
  db,
  userId,
  businessId,
  changeId,
  idempotencyKey,
  rawInput,
  { now = Date.now() } = {},
) {
  const input = abPlanSchema.parse(rawInput);
  const fingerprint = digest({ changeId, input });
  return db.transaction(async (tx) => {
    const context = await changeContext(tx, userId, businessId, changeId);
    if (context.business.state.mode !== "live")
      throw new AppError(
        409,
        "A/B-план доступен только подключенному бизнесу.",
      );
    const previous = await tx
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
          "Ключ уже использован для другой A/B-гипотезы.",
          "idempotency_conflict",
        );
      return directAbView(tx, previous);
    }
    if (
      await tx
        .prepare(
          "SELECT 1 AS found FROM direct_ab_plans WHERE business_id=? AND change_id=?",
        )
        .get(businessId, changeId)
    )
      throw new AppError(409, "Для этой кампании A/B-план уже зафиксирован.");
    const execution = context.execution;
    if (execution?.status !== "succeeded" || !execution.suspend_verified)
      throw new AppError(
        409,
        "Сначала создайте и сверьте выключенную кампанию.",
      );
    const campaignId = callId(execution, "campaign");
    const controlAdId = callId(execution, "ads");
    const adIds = execution.calls.find((item) => item.key === "ads")?.ids || [];
    if (
      !/^[1-9]\d*$/.test(String(campaignId || "")) ||
      !/^[1-9]\d*$/.test(String(controlAdId || "")) ||
      !adIds.length ||
      !context.change.plan.ads?.length
    )
      throw new AppError(
        409,
        "В созданной кампании нет контрольного объявления.",
      );
    const currentConnectionId = await connectionId(tx, businessId);
    if (!currentConnectionId || currentConnectionId !== execution.connection_id)
      throw new AppError(
        409,
        "Подключение Яндекса изменилось после создания кампании.",
      );
    if (moscowDate(now) >= context.change.plan.periodStart)
      throw new AppError(409, "Гипотезу нужно зафиксировать до начала теста.");
    if (
      inclusiveDays(
        context.change.plan.periodStart,
        context.change.plan.periodEnd,
      ) < input.minDays
    )
      throw new AppError(
        409,
        "Период кампании короче минимального срока теста.",
      );
    const control = context.change.plan.ads[0];
    if (
      control.title === input.variant.title &&
      control.text === input.variant.text
    )
      throw new AppError(409, "Вариант Б должен отличаться от контроля.");
    const plan = {
      hypothesis: input.hypothesis,
      metric: "ctr",
      minDays: input.minDays,
      minImpressionsPerVariant: input.minImpressionsPerVariant,
      periodStart: context.change.plan.periodStart,
      periodEnd: context.change.plan.periodEnd,
      control: {
        adId: String(controlAdId),
        title: control.title,
        text: control.text,
        href: control.href,
        ...(control.adImageHash ? { adImageHash: control.adImageHash } : {}),
      },
      variant: {
        adId: null,
        title: input.variant.title,
        text: input.variant.text,
        href: control.href,
        ...(control.adImageHash ? { adImageHash: control.adImageHash } : {}),
      },
      allocation: "50/50 target; verified from impressions",
      noEarlyWinner: false,
    };
    const id = randomUUID();
    const at = new Date(now).toISOString();
    await tx
      .prepare(
        `INSERT INTO direct_ab_plans(
          id,business_id,change_id,connection_id,campaign_id,control_ad_id,
          idempotency_key,fingerprint,plan_json,created_at
        ) VALUES(?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        id,
        businessId,
        changeId,
        currentConnectionId,
        String(campaignId),
        String(controlAdId),
        idempotencyKey,
        fingerprint,
        JSON.stringify(plan),
        at,
      );
    await addEvent(tx, businessId, {
      kind: "direct_ab_plan",
      title: "A/B-гипотеза зафиксирована",
      reason: `До начала показов зафиксированы контроль ${controlAdId}, срок и минимальная выборка.`,
      rule: "direct/ab-plan@2",
      jobId: id,
    });
    const row = await tx
      .prepare("SELECT * FROM direct_ab_plans WHERE id=?")
      .get(id);
    return directAbView(tx, row);
  });
}

function payloadFor(type, action, plan) {
  if (type === "UNIFIED_CAMPAIGN")
    return {
      AdGroupId: Number(action.adGroupId),
      ResponsiveAd: {
        Titles: [plan.variant.title],
        Texts: [plan.variant.text],
        Href: plan.variant.href,
      },
    };
  return {
    AdGroupId: Number(action.adGroupId),
    TextAd: {
      Title: plan.variant.title,
      Text: plan.variant.text,
      Href: plan.variant.href,
      Mobile: "NO",
      ...(plan.variant.adImageHash
        ? { AdImageHash: plan.variant.adImageHash }
        : {}),
    },
  };
}

async function campaignHeld(client, campaignId) {
  const response = await client.campaignBudgetById(campaignId);
  const item = response?.Campaigns?.find(
    (candidate) => String(candidate.Id) === String(campaignId),
  );
  if (!item || !heldCampaign(item))
    throw new AppError(409, "Кампания больше не выключена.");
  if (!["TEXT_CAMPAIGN", "UNIFIED_CAMPAIGN"].includes(item.Type))
    throw new AppError(409, "Тип кампании не поддерживает A/B-тест.");
  return item;
}

function verifiedAudienceBudget(
  response,
  campaignId,
  criteria,
  expectedKopecks,
) {
  const campaign = response?.Campaigns?.find(
    (item) => String(item.Id) === String(campaignId),
  );
  const strategy = campaign?.TextCampaign?.BiddingStrategy;
  const period = strategy?.Search?.WbMaximumClicks?.CustomPeriodBudget;
  const spendLimit = period?.SpendLimit;
  if (
    !campaign ||
    campaign.Type !== "TEXT_CAMPAIGN" ||
    !heldCampaign(campaign) ||
    strategy?.Search?.BiddingStrategyType !== "WB_MAXIMUM_CLICKS" ||
    strategy?.Network?.BiddingStrategyType !== "SERVING_OFF" ||
    !Number.isSafeInteger(spendLimit) ||
    spendLimit / 10_000 !== expectedKopecks ||
    period.StartDate !== criteria.periodStart ||
    period.EndDate !== criteria.periodEnd ||
    period.AutoContinue !== "NO"
  )
    throw new AppError(
      409,
      "Кампании теста должны быть выключены и иметь одинаковый подтверждённый лимит и период.",
    );
  return campaign;
}

async function matchingVariant(client, action, plan) {
  const response = await client.adsByAdGroupId(action.adGroupId);
  if (!Array.isArray(response?.Ads))
    throw new AppError(502, "Не удалось прочитать объявления группы.");
  const matches = response.Ads.filter(
    (ad) =>
      String(ad.Id) !== String(plan.control.adId) &&
      exactAd(ad, plan.variant, action.adGroupId),
  );
  if (matches.length > 1)
    throw new AppError(
      409,
      "Найдено несколько одинаковых вариантов Б; автоматическая сверка остановлена.",
    );
  return matches.length === 1 ? String(matches[0].Id) : null;
}

async function updateVariantAction(
  db,
  businessId,
  actionId,
  expected,
  status,
  values = {},
) {
  return db.transaction(async (tx) => {
    const row = await tx
      .prepare("SELECT * FROM direct_ab_actions WHERE id=? AND business_id=?")
      .get(actionId, businessId);
    if (!row) throw new AppError(404, "Действие A/B-теста не найдено.");
    if ((await connectionId(tx, businessId)) !== row.connection_id)
      throw new AppError(409, "Подключение изменилось во время операции.");
    if (row.status !== expected)
      throw new AppError(409, "Состояние операции изменилось.");
    const at = new Date().toISOString();
    await tx
      .prepare(
        `UPDATE direct_ab_actions SET status=?,write_attempted=?,variant_ad_id=?,
         error_code=?,updated_at=? WHERE id=?`,
      )
      .run(
        status,
        values.writeAttempted ? 1 : row.write_attempted,
        values.variantAdId ? String(values.variantAdId) : row.variant_ad_id,
        values.errorCode ?? null,
        at,
        actionId,
      );
    if (status === "succeeded" && values.variantAdId) {
      const saved = await tx
        .prepare("SELECT plan_json FROM direct_ab_plans WHERE id=?")
        .get(row.plan_id);
      const plan = JSON.parse(saved.plan_json);
      plan.variant.adId = String(values.variantAdId);
      await tx
        .prepare("UPDATE direct_ab_plans SET plan_json=? WHERE id=?")
        .run(JSON.stringify(plan), row.plan_id);
    }
    if (["succeeded", "not_applied", "needs_reconciliation"].includes(status))
      await addEvent(tx, businessId, {
        kind:
          status === "succeeded"
            ? "direct_ab_variant_created"
            : "direct_ab_variant_uncertain",
        title:
          status === "succeeded"
            ? "Вариант Б создан выключенным"
            : status === "not_applied"
              ? "Вариант Б не создан"
              : "Создание варианта Б требует сверки",
        reason:
          status === "succeeded"
            ? `Объявление ${values.variantAdId} подтверждено чтением API. Показы не включались.`
            : "Неопределённая запись не повторяется автоматически.",
        rule: "direct/ab-variant@2",
        jobId: actionId,
      });
    const updated = await tx
      .prepare("SELECT * FROM direct_ab_actions WHERE id=?")
      .get(actionId);
    return actionView(updated);
  });
}

async function beginVariantAction(
  db,
  userId,
  businessId,
  changeId,
  requestKey,
  expectedConnectionId,
  now,
) {
  return db.transaction(async (tx) => {
    const context = await changeContext(tx, userId, businessId, changeId);
    const planRow = await tx
      .prepare(
        "SELECT * FROM direct_ab_plans WHERE business_id=? AND change_id=? FOR UPDATE",
      )
      .get(businessId, changeId);
    if (!planRow) throw new AppError(404, "Сначала сохраните A/B-план.");
    const plan = JSON.parse(planRow.plan_json);
    const previous = await tx
      .prepare(
        "SELECT * FROM direct_ab_actions WHERE business_id=? AND idempotency_key=?",
      )
      .get(businessId, requestKey);
    if (previous) {
      if (previous.plan_id !== planRow.id)
        throw new AppError(409, "Ключ уже использован другим действием.");
      return { action: actionView(previous), plan, created: false };
    }
    if (plan.variant.adId)
      throw new AppError(409, "Вариант Б уже создан и подтверждён.");
    if (
      planRow.connection_id !== expectedConnectionId ||
      (await connectionId(tx, businessId)) !== expectedConnectionId
    )
      throw new AppError(409, "Подключение Яндекса изменилось после плана.");
    if (moscowDate(now) >= plan.periodStart)
      throw new AppError(409, "Вариант Б нужно создать до начала теста.");
    const campaignId = callId(context.execution, "campaign");
    const adGroupId = callId(context.execution, "adgroup");
    const controlAdId = callId(context.execution, "ads");
    if (
      context.execution?.status !== "succeeded" ||
      !context.execution.suspend_verified ||
      String(campaignId) !== String(planRow.campaign_id) ||
      String(controlAdId) !== String(plan.control.adId) ||
      !/^[1-9]\d*$/.test(String(adGroupId || ""))
    )
      throw new AppError(409, "Исходная кампания или контроль изменились.");
    const active = await tx
      .prepare(
        `SELECT 1 AS found FROM direct_ab_actions
         WHERE plan_id=? AND status IN ${ACTIVE}`,
      )
      .get(planRow.id);
    if (active)
      throw new AppError(409, "Предыдущее создание варианта требует сверки.");
    await assertNoOtherCampaignAction(tx, businessId, campaignId, {
      includeVariant: false,
      includeDecision: true,
    });
    const id = randomUUID();
    const at = new Date(now).toISOString();
    await tx
      .prepare(
        `INSERT INTO direct_ab_actions(
          id,business_id,plan_id,change_id,connection_id,campaign_id,ad_group_id,
          control_ad_id,idempotency_key,status,created_at,updated_at
        ) VALUES(?,?,?,?,?,?,?,?,?,'checking',?,?)`,
      )
      .run(
        id,
        businessId,
        planRow.id,
        changeId,
        expectedConnectionId,
        String(campaignId),
        String(adGroupId),
        String(controlAdId),
        requestKey,
        at,
        at,
      );
    const row = await tx
      .prepare("SELECT * FROM direct_ab_actions WHERE id=?")
      .get(id);
    return { action: actionView(row), plan, created: true };
  });
}

export async function createVerifiedPostgresAbVariant(
  db,
  userId,
  businessId,
  changeId,
  requestKey,
  client,
  expectedConnectionId,
  {
    enabled = false,
    confirmCampaignId,
    confirmControlAdId,
    variantConfirmed = false,
    now = Date.now(),
  } = {},
) {
  if (!enabled)
    throw new AppError(409, "Создание варианта Б отключено.", "live_gate");
  if (!/^[0-9a-f-]{36}$/i.test(requestKey))
    throw new AppError(400, "Некорректный ключ запроса.");
  const { action, plan, created } = await beginVariantAction(
    db,
    userId,
    businessId,
    changeId,
    requestKey,
    expectedConnectionId,
    now,
  );
  if (!created) return action;
  if (
    !variantConfirmed ||
    String(confirmCampaignId) !== action.campaignId ||
    String(confirmControlAdId) !== action.controlAdId
  )
    return updateVariantAction(
      db,
      businessId,
      action.id,
      "checking",
      "failed_no_write",
      { errorCode: "confirmation_mismatch" },
    );
  let sending = false;
  try {
    const remoteCampaign = await campaignHeld(client, action.campaignId);
    const control = await client.adsByIds([action.controlAdId]);
    if (
      control?.Ads?.length !== 1 ||
      !exactAd(control.Ads[0], plan.control, action.adGroupId)
    )
      throw new AppError(409, "Контрольное объявление изменилось.");
    const existing = await matchingVariant(client, action, plan);
    if (existing)
      return updateVariantAction(
        db,
        businessId,
        action.id,
        "checking",
        "succeeded",
        { variantAdId: existing },
      );
    await updateVariantAction(
      db,
      businessId,
      action.id,
      "checking",
      "sending",
      { writeAttempted: true },
    );
    sending = true;
    const response = await client.createAds([
      payloadFor(remoteCampaign.Type, action, plan),
    ]);
    const result = response?.AddResults?.[0];
    if (
      response?.AddResults?.length !== 1 ||
      !result?.Id ||
      result.Errors?.length
    )
      throw new AppError(502, "Директ не подтвердил создание варианта Б.");
    const readBack = await client.adsByIds([result.Id]);
    if (
      readBack?.Ads?.length !== 1 ||
      !exactAd(readBack.Ads[0], plan.variant, action.adGroupId)
    )
      throw new AppError(502, "Вариант Б не подтверждён повторным чтением.");
    await campaignHeld(client, action.campaignId);
    return updateVariantAction(
      db,
      businessId,
      action.id,
      "sending",
      "succeeded",
      { writeAttempted: true, variantAdId: result.Id },
    );
  } catch {
    if (!sending)
      return updateVariantAction(
        db,
        businessId,
        action.id,
        "checking",
        "failed_no_write",
        { errorCode: "precheck_failed" },
      );
    try {
      const confirmed = await matchingVariant(client, action, plan);
      if (confirmed)
        return updateVariantAction(
          db,
          businessId,
          action.id,
          "sending",
          "succeeded",
          { writeAttempted: true, variantAdId: confirmed },
        );
    } catch {}
    return updateVariantAction(
      db,
      businessId,
      action.id,
      "sending",
      "needs_reconciliation",
      { writeAttempted: true, errorCode: "unknown_result" },
    );
  }
}

export async function inspectPostgresAbVariantAction(
  db,
  userId,
  businessId,
  changeId,
  actionId,
  client,
) {
  await ownedBusiness(db, userId, businessId);
  const row = await db
    .prepare(
      "SELECT * FROM direct_ab_actions WHERE id=? AND business_id=? AND change_id=?",
    )
    .get(actionId, businessId, changeId);
  if (!row) throw new AppError(404, "Действие A/B-теста не найдено.");
  if ((await connectionId(db, businessId)) !== row.connection_id)
    throw new AppError(409, "Подключение изменилось после операции.");
  if (row.status !== "needs_reconciliation") return actionView(row);
  const saved = await db
    .prepare(
      "SELECT plan_json FROM direct_ab_plans WHERE id=? AND business_id=?",
    )
    .get(row.plan_id, businessId);
  if (!saved) throw new AppError(404, "A/B-план не найден.");
  const confirmed = await matchingVariant(
    client,
    actionView(row),
    JSON.parse(saved.plan_json),
  );
  return updateVariantAction(
    db,
    businessId,
    actionId,
    "needs_reconciliation",
    confirmed ? "succeeded" : "not_applied",
    {
      writeAttempted: true,
      variantAdId: confirmed || undefined,
      errorCode: confirmed ? null : "write_not_applied",
    },
  );
}

export async function enqueuePostgresAbReport(
  db,
  userId,
  businessId,
  idempotencyKey,
  planId,
  now = Date.now(),
) {
  return db.transaction(async (tx) => {
    const business = await ownedBusiness(tx, userId, businessId);
    const plan = await postgresDirectAbPlanView(tx, userId, businessId, planId);
    if (!plan.variant.adId)
      throw new AppError(409, "Сначала создайте и сверьте вариант Б.");
    const fingerprint = digest({ action: "ab_report", planId });
    const previous = await tx
      .prepare("SELECT * FROM commands WHERE business_id=? AND key=?")
      .get(businessId, idempotencyKey);
    if (previous) {
      if (previous.fingerprint !== fingerprint)
        throw new AppError(409, "Ключ уже использован другой операцией.");
      return JSON.parse(previous.response);
    }
    const active = await tx
      .prepare(
        "SELECT id FROM jobs WHERE business_id=? AND kind='report_sync' AND status IN ('pending','running')",
      )
      .get(businessId);
    if (active) throw new AppError(409, "Сначала дождитесь текущего отчёта.");
    const metadataRow = await tx
      .prepare(
        "SELECT metadata FROM connections WHERE business_id=? AND provider='yandex'",
      )
      .get(businessId);
    if (!metadataRow) throw new AppError(409, "Сначала подключите Яндекс.");
    const metadata = JSON.parse(metadataRow.metadata);
    const login = JSON.parse(
      (
        await tx
          .prepare("SELECT plan_json FROM direct_changes WHERE id=?")
          .get(plan.changeId)
      ).plan_json,
    ).login;
    const account = (metadata.clients || []).find(
      (item) => item.Login === login,
    );
    if (!account) throw new AppError(409, "Кабинет больше не доступен.");
    if (account.Currency !== "RUB")
      throw new AppError(409, "A/B-отчёт поддерживает только RUB.");
    const id = randomUUID();
    const payload = {
      source: "yandex",
      login,
      dateFrom: plan.periodStart,
      dateTo: plan.periodEnd,
      reportType: "ad",
      abPlanId: plan.id,
      adIds: [plan.control.adId, plan.variant.adId],
      failures: 0,
    };
    await tx
      .prepare(
        "INSERT INTO jobs(id,business_id,kind,status,available_at,attempts,payload,error) VALUES(?,?,'report_sync','pending',?,0,?,NULL)",
      )
      .run(id, businessId, now, JSON.stringify(payload));
    const response = {
      ok: true,
      jobId: id,
      message: "Отчёт по вариантам поставлен в очередь.",
    };
    await tx
      .prepare("INSERT INTO commands VALUES(?,?,?,?)")
      .run(businessId, idempotencyKey, fingerprint, JSON.stringify(response));
    return response;
  });
}

function decisionRemoteAd(response, adId) {
  if (!Array.isArray(response?.Ads))
    throw new AppError(502, "Не удалось прочитать объявление.");
  return response.Ads.find((item) => String(item.Id) === String(adId)) || null;
}

async function inspectDecisionRemote(client, action) {
  const ad = decisionRemoteAd(
    await client.adsByIds([action.targetAdId]),
    action.targetAdId,
  );
  if (ad && String(ad.CampaignId) !== action.campaignId)
    throw new AppError(409, "Объявление больше не принадлежит кампании.");
  if (action.operation === "rollback_variant")
    return ad
      ? { applied: false, state: ad.State || "UNKNOWN" }
      : { applied: true, state: "DELETED" };
  return ad?.State === "SUSPENDED"
    ? { applied: true, state: "SUSPENDED" }
    : { applied: false, state: ad?.State || "MISSING" };
}

async function updateDecision(
  db,
  businessId,
  actionId,
  expected,
  status,
  values = {},
) {
  return db.transaction(async (tx) => {
    const row = await tx
      .prepare(
        "SELECT * FROM direct_ab_decision_actions WHERE id=? AND business_id=?",
      )
      .get(actionId, businessId);
    if (!row) throw new AppError(404, "A/B-решение не найдено.");
    if ((await connectionId(tx, businessId)) !== row.connection_id)
      throw new AppError(409, "Подключение изменилось во время операции.");
    if (row.status !== expected)
      throw new AppError(409, "Состояние A/B-решения изменилось.");
    await tx
      .prepare(
        `UPDATE direct_ab_decision_actions SET status=?,write_attempted=?,
         error_code=?,before_state=COALESCE(?,before_state),after_state=?,updated_at=?
         WHERE id=?`,
      )
      .run(
        status,
        values.writeAttempted ? 1 : row.write_attempted,
        values.errorCode ?? null,
        values.beforeState ?? null,
        values.afterState ?? null,
        new Date().toISOString(),
        actionId,
      );
    if (["succeeded", "needs_reconciliation"].includes(status))
      await addEvent(tx, businessId, {
        kind:
          status === "succeeded"
            ? "direct_ab_decision_applied"
            : "direct_ab_decision_uncertain",
        title:
          status === "succeeded"
            ? row.operation === "rollback_variant"
              ? "Вариант Б удалён"
              : "Результат A/B-теста применён"
            : "A/B-решение требует сверки",
        reason:
          status === "succeeded"
            ? `Объявление ${row.target_ad_id}: подтверждено состояние ${values.afterState}.`
            : "Неопределённая запись не повторяется автоматически.",
        rule: "direct/ab-decision@2",
        jobId: actionId,
      });
    const updated = await tx
      .prepare("SELECT * FROM direct_ab_decision_actions WHERE id=?")
      .get(actionId);
    return actionView(updated);
  });
}

export async function applyPostgresDirectAbDecision(
  db,
  userId,
  businessId,
  planId,
  requestKey,
  client,
  expectedConnectionId,
  {
    enabled = false,
    operation,
    confirmCampaignId,
    confirmTargetAdId,
    confirmed = false,
    now = Date.now(),
  } = {},
) {
  if (!enabled)
    throw new AppError(409, "Применение A/B-решений отключено.", "live_gate");
  if (!confirmed)
    throw new AppError(409, "Подтвердите последствие A/B-операции.");
  if (!/^[0-9a-f-]{36}$/i.test(requestKey))
    throw new AppError(400, "Некорректный ключ запроса.");
  if (!["rollback_variant", "apply_outcome"].includes(operation))
    throw new AppError(400, "Некорректная A/B-операция.");
  const prepared = await db.transaction(async (tx) => {
    await ownedBusiness(tx, userId, businessId);
    const row = await tx
      .prepare(
        "SELECT * FROM direct_ab_plans WHERE id=? AND business_id=? FOR UPDATE",
      )
      .get(planId, businessId);
    if (!row) throw new AppError(404, "A/B-план не найден.");
    const plan = await directAbView(tx, row);
    const previous = await tx
      .prepare(
        "SELECT * FROM direct_ab_decision_actions WHERE business_id=? AND idempotency_key=?",
      )
      .get(businessId, requestKey);
    const targetAdId =
      operation === "rollback_variant"
        ? plan.variant.adId
        : plan.outcome === "control_wins"
          ? plan.variant.adId
          : plan.outcome === "variant_wins"
            ? plan.control.adId
            : null;
    if (!targetAdId)
      throw new AppError(409, "Победитель A/B-теста ещё не подтверждён.");
    if (operation === "rollback_variant") {
      if (plan.evidence.reportId || moscowDate(now) >= plan.periodStart)
        throw new AppError(
          409,
          "Черновой откат доступен только до начала теста.",
        );
    }
    if (previous) {
      if (
        previous.plan_id !== planId ||
        previous.operation !== operation ||
        previous.target_ad_id !== String(targetAdId)
      )
        throw new AppError(
          409,
          "Ключ уже использован другим A/B-решением.",
          "idempotency_conflict",
        );
      return { action: actionView(previous), created: false };
    }
    if (
      row.connection_id !== expectedConnectionId ||
      (await connectionId(tx, businessId)) !== expectedConnectionId
    )
      throw new AppError(409, "Подключение Яндекса изменилось после плана.");
    if (
      String(confirmCampaignId) !== String(row.campaign_id) ||
      String(confirmTargetAdId) !== String(targetAdId)
    )
      throw new AppError(409, "Подтвердите точные ID кампании и объявления.");
    const succeeded = await tx
      .prepare(
        "SELECT 1 AS found FROM direct_ab_decision_actions WHERE plan_id=? AND status='succeeded'",
      )
      .get(planId);
    if (succeeded) throw new AppError(409, "A/B-решение уже применено.");
    const active = await tx
      .prepare(
        `SELECT 1 AS found FROM direct_ab_decision_actions
         WHERE plan_id=? AND status IN ${ACTIVE}`,
      )
      .get(planId);
    if (active) throw new AppError(409, "Предыдущее решение требует сверки.");
    await assertNoOtherCampaignAction(tx, businessId, row.campaign_id, {
      includeVariant: true,
      includeDecision: false,
    });
    const id = randomUUID();
    const at = new Date(now).toISOString();
    await tx
      .prepare(
        `INSERT INTO direct_ab_decision_actions(
          id,business_id,plan_id,change_id,connection_id,campaign_id,target_ad_id,
          operation,idempotency_key,status,created_at,updated_at
        ) VALUES(?,?,?,?,?,?,?,?,?,'checking',?,?)`,
      )
      .run(
        id,
        businessId,
        planId,
        row.change_id,
        expectedConnectionId,
        String(row.campaign_id),
        String(targetAdId),
        operation,
        requestKey,
        at,
        at,
      );
    const action = await tx
      .prepare("SELECT * FROM direct_ab_decision_actions WHERE id=?")
      .get(id);
    return { action: actionView(action), created: true };
  });
  if (!prepared.created) return prepared.action;
  const action = prepared.action;
  let sending = false;
  try {
    const before = decisionRemoteAd(
      await client.adsByIds([action.targetAdId]),
      action.targetAdId,
    );
    if (before && String(before.CampaignId) !== action.campaignId)
      throw new AppError(409, "Объявление больше не принадлежит кампании.");
    if (operation === "rollback_variant") {
      if (!before)
        return updateDecision(
          db,
          businessId,
          action.id,
          "checking",
          "succeeded",
          { beforeState: "DELETED", afterState: "DELETED" },
        );
      if (before.Status !== "DRAFT" || before.State !== "OFF")
        return updateDecision(
          db,
          businessId,
          action.id,
          "checking",
          "failed_no_write",
          {
            beforeState: before.State || "UNKNOWN",
            errorCode: "variant_not_draft",
          },
        );
    } else if (!before || !["ON", "SUSPENDED"].includes(before.State)) {
      return updateDecision(
        db,
        businessId,
        action.id,
        "checking",
        "failed_no_write",
        {
          beforeState: before?.State || "MISSING",
          errorCode: "loser_not_serving",
        },
      );
    } else if (before.State === "SUSPENDED") {
      return updateDecision(
        db,
        businessId,
        action.id,
        "checking",
        "succeeded",
        { beforeState: "SUSPENDED", afterState: "SUSPENDED" },
      );
    }
    await updateDecision(db, businessId, action.id, "checking", "sending", {
      beforeState: before.State,
      writeAttempted: true,
    });
    sending = true;
    const response =
      operation === "rollback_variant"
        ? await client.deleteAds([action.targetAdId])
        : await client.suspendAds([action.targetAdId]);
    const results =
      operation === "rollback_variant"
        ? response?.DeleteResults
        : response?.SuspendResults;
    if (
      !Array.isArray(results) ||
      results.length !== 1 ||
      String(results[0].Id) !== action.targetAdId ||
      results[0].Errors?.length
    )
      throw new AppError(502, "Директ не подтвердил A/B-операцию.");
    const inspected = await inspectDecisionRemote(client, action);
    if (!inspected.applied)
      throw new AppError(502, "A/B-операция не подтверждена чтением.");
    return updateDecision(db, businessId, action.id, "sending", "succeeded", {
      writeAttempted: true,
      afterState: inspected.state,
    });
  } catch {
    if (!sending)
      return updateDecision(
        db,
        businessId,
        action.id,
        "checking",
        "failed_no_write",
        { errorCode: "precheck_failed" },
      );
    try {
      const inspected = await inspectDecisionRemote(client, action);
      if (inspected.applied)
        return updateDecision(
          db,
          businessId,
          action.id,
          "sending",
          "succeeded",
          { writeAttempted: true, afterState: inspected.state },
        );
    } catch {}
    return updateDecision(
      db,
      businessId,
      action.id,
      "sending",
      "needs_reconciliation",
      { writeAttempted: true, errorCode: "write_outcome_unknown" },
    );
  }
}

export async function inspectPostgresDirectAbDecision(
  db,
  userId,
  businessId,
  planId,
  actionId,
  client,
) {
  await ownedBusiness(db, userId, businessId);
  const row = await db
    .prepare(
      `SELECT * FROM direct_ab_decision_actions
       WHERE id=? AND business_id=? AND plan_id=?`,
    )
    .get(actionId, businessId, planId);
  if (!row) throw new AppError(404, "A/B-решение не найдено.");
  if ((await connectionId(db, businessId)) !== row.connection_id)
    throw new AppError(409, "Подключение изменилось после операции.");
  const action = actionView(row);
  if (action.status !== "needs_reconciliation") return action;
  const inspected = await inspectDecisionRemote(client, action);
  return updateDecision(
    db,
    businessId,
    actionId,
    "needs_reconciliation",
    inspected.applied ? "succeeded" : "not_applied",
    {
      afterState: inspected.state,
      writeAttempted: true,
      errorCode: inspected.applied ? null : "not_applied_after_read",
    },
  );
}

function erf(value) {
  const sign = value < 0 ? -1 : 1;
  const x = Math.abs(value);
  const t = 1 / (1 + 0.3275911 * x);
  const result =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) *
      t +
      0.254829592) *
      t *
      Math.exp(-x * x);
  return sign * result;
}

function betaSummary(goals, clicks) {
  const alpha = goals + 1;
  const beta = clicks - goals + 1;
  const total = alpha + beta;
  return {
    mean: alpha / total,
    variance: (alpha * beta) / (total * total * (total + 1)),
  };
}

function audienceAnalysis(row, observation) {
  const criteria = JSON.parse(row.criteria_json);
  if (!observation)
    return {
      status: row.status === "collecting" ? "collecting" : "planned",
      conclusion: "Гипотеза зафиксирована, статистика ещё не получена.",
      appliedAction: "none",
    };
  const control = JSON.parse(observation.control_json);
  const variant = JSON.parse(observation.variant_json);
  const totalClicks = control.clicks + variant.clicks;
  const controlShare = totalClicks ? control.clicks / totalClicks : null;
  const allocationBalanced =
    controlShare !== null && controlShare >= 0.4 && controlShare <= 0.6;
  const durationDays = inclusiveDays(
    observation.period_from,
    observation.period_to,
  );
  const durationMet = true;
  const sampleMet = control.clicks > 0 && variant.clicks > 0;
  const a = betaSummary(control.goals, control.clicks);
  const b = betaSummary(variant.goals, variant.clicks);
  const z = (b.mean - a.mean) / Math.sqrt(a.variance + b.variance);
  const probabilityVariantBetter = 0.5 * (1 + erf(z / Math.sqrt(2)));
  const relativeLift = a.mean ? (b.mean - a.mean) / a.mean : null;
  let status = "collecting";
  let conclusion =
    "Анализ начнётся, когда оба сегмента получат хотя бы один переход.";
  if (sampleMet) {
    if (!allocationBalanced) {
      status = "inconclusive";
      conclusion =
        "Предварительный анализ: трафик между сегментами распределён неравномерно.";
    } else if (
      probabilityVariantBetter >= criteria.probabilityThreshold &&
      relativeLift >= criteria.minimumRelativeLift
    ) {
      status = "variant_wins";
      conclusion =
        "Сегмент Б превосходит контроль с заданной вероятностью и практически значимым эффектом.";
    } else if (
      1 - probabilityVariantBetter >= criteria.probabilityThreshold &&
      relativeLift !== null &&
      relativeLift <= -criteria.minimumRelativeLift
    ) {
      status = "control_wins";
      conclusion =
        "Контрольный сегмент превосходит вариант с заданной вероятностью и практически значимым эффектом.";
    } else {
      status = "inconclusive";
      conclusion =
        "Анализ обновлён: преимущество одного из сегментов пока не подтверждено.";
    }
  }
  return {
    status,
    conclusion,
    appliedAction:
      JSON.parse(row.result_json || "null")?.appliedAction || "none",
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

async function audienceView(db, row) {
  const latest = await db
    .prepare(
      "SELECT * FROM audience_experiment_observations WHERE experiment_id=? ORDER BY observed_at DESC LIMIT 1",
    )
    .get(row.id);
  const result = audienceAnalysis(row, latest);
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

export async function postgresAudienceExperiments(db, userId, businessId) {
  await ownedBusiness(db, userId, businessId);
  const rows = await db
    .prepare(
      "SELECT * FROM audience_experiments WHERE business_id=? ORDER BY created_at DESC LIMIT 20",
    )
    .all(businessId);
  return Promise.all(rows.map((row) => audienceView(db, row)));
}

export async function createPostgresAudienceExperiment(
  db,
  userId,
  businessId,
  changeId,
  idempotencyKey,
  rawInput,
  { now = Date.now() } = {},
) {
  const input = audienceExperimentSchema.parse(rawInput);
  if (
    input.control.value.toLocaleLowerCase("ru") ===
    input.variant.value.toLocaleLowerCase("ru")
  )
    throw new AppError(400, "Сегменты должны различаться выбранным признаком.");
  const fingerprint = digest({ changeId, input });
  return db.transaction(async (tx) => {
    const context = await changeContext(tx, userId, businessId, changeId);
    if (context.business.state.mode !== "live")
      throw new AppError(
        409,
        "Тест аудитории доступен только подключенному бизнесу.",
      );
    const previous = await tx
      .prepare(
        "SELECT * FROM audience_experiments WHERE business_id=? AND idempotency_key=?",
      )
      .get(businessId, idempotencyKey);
    if (previous) {
      if (previous.fingerprint !== fingerprint)
        throw new AppError(
          409,
          "Ключ уже использован другим экспериментом.",
          "idempotency_conflict",
        );
      return audienceView(tx, previous);
    }
    if (
      await tx
        .prepare(
          "SELECT 1 AS found FROM audience_experiments WHERE business_id=? AND change_id=?",
        )
        .get(businessId, changeId)
    )
      throw new AppError(409, "Для этой кампании тест аудитории уже создан.");
    if (
      context.execution?.status !== "succeeded" ||
      !context.execution.suspend_verified
    )
      throw new AppError(
        409,
        "Сначала создайте и сверьте выключенную кампанию.",
      );
    const { periodStart, periodEnd } = context.change.plan;
    if (moscowDate(now) >= periodStart)
      throw new AppError(409, "Гипотезу нужно зафиксировать до начала теста.");
    if (inclusiveDays(periodStart, periodEnd) < input.minDays)
      throw new AppError(
        409,
        "Период кампании короче минимального срока теста.",
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
      noEarlyWinner: false,
      fixedMessageFingerprint: digest(
        context.change.plan.ads.map(({ title, text, href }) => ({
          title,
          text,
          href,
        })),
      ),
      connectionId: context.execution.connection_id,
      deployment: null,
    };
    const id = randomUUID();
    const at = new Date(now).toISOString();
    await tx
      .prepare(
        `INSERT INTO audience_experiments(
          id,business_id,change_id,hypothesis,dimension,control_json,variant_json,
          criteria_json,status,result_json,fingerprint,idempotency_key,created_at,updated_at
        ) VALUES(?,?,?,?,?,?,?,?,?,'null',?,?,?,?)`,
      )
      .run(
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
    await addEvent(tx, businessId, {
      kind: "audience_experiment_planned",
      title: "Зафиксирован тест аудитории",
      reason: `Меняется только признак «${input.dimension}»; сообщение и бюджет должны оставаться одинаковыми.`,
      rule: "audience-experiment/2",
      jobId: id,
    });
    const row = await tx
      .prepare("SELECT * FROM audience_experiments WHERE id=?")
      .get(id);
    return audienceView(tx, row);
  });
}

export async function bindPostgresAudienceExperiment(
  db,
  userId,
  businessId,
  experimentId,
  rawBinding,
  client,
) {
  const binding = audienceBindingSchema.parse(rawBinding);
  await ownedBusiness(db, userId, businessId);
  const row = await db
    .prepare("SELECT * FROM audience_experiments WHERE id=? AND business_id=?")
    .get(experimentId, businessId);
  if (!row) throw new AppError(404, "Тест аудитории не найден.");
  const criteria = JSON.parse(row.criteria_json);
  if (criteria.deployment) {
    if (digest(criteria.deployment) !== digest(binding))
      throw new AppError(409, "Эксперимент уже привязан к другой паре.");
    return audienceView(db, row);
  }
  const currentConnectionId = await connectionId(db, businessId);
  if (!currentConnectionId || criteria.connectionId !== currentConnectionId)
    throw new AppError(
      409,
      "Подключение Яндекса изменилось после создания эксперимента.",
    );
  const campaigns = await client.campaignsByIds([
    binding.controlCampaignId,
    binding.variantCampaignId,
  ]);
  const remoteCampaigns = campaigns?.Campaigns || [];
  const controlCampaign = remoteCampaigns.find(
    (item) => String(item.Id) === binding.controlCampaignId,
  );
  const variantCampaign = remoteCampaigns.find(
    (item) => String(item.Id) === binding.variantCampaignId,
  );
  if (!controlCampaign || !variantCampaign || remoteCampaigns.length !== 2)
    throw new AppError(409, "Не удалось подтвердить обе кампании теста.");
  if (
    !heldCampaign(controlCampaign) ||
    !heldCampaign(variantCampaign) ||
    controlCampaign.Type !== variantCampaign.Type
  )
    throw new AppError(
      409,
      "Обе кампании теста должны быть выключены и иметь одинаковый тип.",
    );
  const [controlBudget, variantBudget] = await Promise.all([
    client.campaignBudgetById(binding.controlCampaignId),
    client.campaignBudgetById(binding.variantCampaignId),
  ]);
  verifiedAudienceBudget(
    controlBudget,
    binding.controlCampaignId,
    criteria,
    binding.budgetPerVariantKopecks,
  );
  verifiedAudienceBudget(
    variantBudget,
    binding.variantCampaignId,
    criteria,
    binding.budgetPerVariantKopecks,
  );
  const ads = await client.adsByIds([binding.controlAdId, binding.variantAdId]);
  if (ads?.Ads?.length !== 2)
    throw new AppError(409, "Не удалось подтвердить оба объявления теста.");
  const [controlAd, variantAd] = [
    ads.Ads.find((item) => String(item.Id) === binding.controlAdId),
    ads.Ads.find((item) => String(item.Id) === binding.variantAdId),
  ];
  if (
    !controlAd ||
    !variantAd ||
    String(controlAd.CampaignId) !== binding.controlCampaignId ||
    String(variantAd.CampaignId) !== binding.variantCampaignId ||
    digest(remoteCopy(controlAd)) !== digest(remoteCopy(variantAd))
  )
    throw new AppError(
      409,
      "Для теста аудитории объявления должны быть полностью одинаковыми.",
    );
  criteria.deployment = binding;
  const at = new Date().toISOString();
  await db.transaction(async (tx) => {
    const result = await tx
      .prepare(
        "UPDATE audience_experiments SET criteria_json=?,status='collecting',updated_at=? WHERE id=? AND status='planned'",
      )
      .run(JSON.stringify(criteria), at, experimentId);
    if (result.changes !== 1) {
      const current = await tx
        .prepare(
          "SELECT criteria_json FROM audience_experiments WHERE id=? AND business_id=?",
        )
        .get(experimentId, businessId);
      const deployment = current
        ? JSON.parse(current.criteria_json).deployment
        : null;
      if (!deployment || digest(deployment) !== digest(binding))
        throw new AppError(
          409,
          "Эксперимент одновременно привязан к другой паре кампаний.",
        );
      return;
    }
    await addEvent(tx, businessId, {
      kind: "audience_experiment_bound",
      title: "Тест аудитории готов к сбору данных",
      reason:
        "Подтверждены две кампании с одинаковым объявлением и одинаковым бюджетом. Меняется только аудитория.",
      rule: "audience-experiment/bind@1",
      jobId: experimentId,
    });
  });
  const updated = await db
    .prepare("SELECT * FROM audience_experiments WHERE id=?")
    .get(experimentId);
  return audienceView(db, updated);
}

export async function recordPostgresAudienceObservation(
  db,
  userId,
  businessId,
  experimentId,
  rawObservation,
  { now = Date.now() } = {},
) {
  const input = observationSchema.parse(rawObservation);
  await ownedBusiness(db, userId, businessId);
  const row = await db
    .prepare("SELECT * FROM audience_experiments WHERE id=? AND business_id=?")
    .get(experimentId, businessId);
  if (!row) throw new AppError(404, "Тест аудитории не найден.");
  const criteria = JSON.parse(row.criteria_json);
  if (!criteria.deployment)
    throw new AppError(409, "Сначала привяжите две проверенные кампании.");
  const existing = await db
    .prepare(
      "SELECT * FROM audience_experiment_observations WHERE experiment_id=? AND snapshot_key=?",
    )
    .get(experimentId, input.snapshotKey);
  if (existing) {
    const saved = {
      snapshotKey: existing.snapshot_key,
      periodFrom: existing.period_from,
      periodTo: existing.period_to,
      control: JSON.parse(existing.control_json),
      variant: JSON.parse(existing.variant_json),
      source: JSON.parse(existing.source_json),
    };
    if (digest(saved) !== digest(input))
      throw new AppError(
        409,
        "Снимок с таким ключом уже сохранён с другими данными.",
        "idempotency_conflict",
      );
    return audienceView(db, row);
  }
  return db.transaction(async (tx) => {
    const at = new Date(now).toISOString();
    await tx
      .prepare(
        `INSERT INTO audience_experiment_observations(
          id,experiment_id,snapshot_key,period_from,period_to,control_json,
          variant_json,source_json,observed_at
        ) VALUES(?,?,?,?,?,?,?,?,?)`,
      )
      .run(
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
    const current = await tx
      .prepare("SELECT * FROM audience_experiments WHERE id=?")
      .get(experimentId);
    const updated = await audienceView(tx, current);
    await tx
      .prepare(
        "UPDATE audience_experiments SET status=?,result_json=?,updated_at=? WHERE id=?",
      )
      .run(
        updated.status,
        JSON.stringify({
          conclusion: updated.conclusion,
          evidence: updated.evidence,
          appliedAction: updated.appliedAction,
        }),
        at,
        experimentId,
      );
    return updated;
  });
}

export async function markInterruptedPostgresAbActions(db) {
  const at = new Date().toISOString();
  await db.transaction(async (tx) => {
    await tx
      .prepare(
        `UPDATE direct_ab_actions SET status='failed_no_write',
         error_code='interrupted_before_send',updated_at=? WHERE status='checking'`,
      )
      .run(at);
    await tx
      .prepare(
        `UPDATE direct_ab_actions SET status='needs_reconciliation',
         error_code='interrupted_after_send',write_attempted=1,updated_at=?
         WHERE status='sending'`,
      )
      .run(at);
    await tx
      .prepare(
        `UPDATE direct_ab_decision_actions SET status='failed_no_write',
         error_code='interrupted_before_send',updated_at=? WHERE status='checking'`,
      )
      .run(at);
    await tx
      .prepare(
        `UPDATE direct_ab_decision_actions SET status='needs_reconciliation',
         error_code='interrupted_after_send',write_attempted=1,updated_at=?
         WHERE status='sending'`,
      )
      .run(at);
  });
}
