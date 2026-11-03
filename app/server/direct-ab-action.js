import { randomUUID } from "node:crypto";
import { AppError, event, requireBusiness, transaction } from "./db.js";
import { directExecution } from "./direct-execution.js";
import { heldCampaign } from "./direct.js";

const active = "('checking','sending','needs_reconciliation')";

function actionView(row) {
  return {
    id: row.id,
    planId: row.plan_id,
    changeId: row.change_id,
    campaignId: row.campaign_id,
    adGroupId: row.ad_group_id,
    controlAdId: row.control_ad_id,
    variantAdId: row.variant_ad_id,
    status: row.status,
    writeAttempted: !!row.write_attempted,
    errorCode: row.error_code,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function connectedId(db, businessId) {
  const row = db
    .prepare(
      "SELECT metadata FROM connections WHERE business_id=? AND provider='yandex'",
    )
    .get(businessId);
  return row ? JSON.parse(row.metadata).connectionId : null;
}

function actionRow(db, businessId, actionId) {
  const row = db
    .prepare("SELECT * FROM direct_ab_actions WHERE business_id=? AND id=?")
    .get(businessId, actionId);
  if (!row) throw new AppError(404, "Действие A/B-теста не найдено.");
  return row;
}

function planRow(db, businessId, changeId) {
  const row = db
    .prepare(
      "SELECT * FROM direct_ab_plans WHERE business_id=? AND change_id=?",
    )
    .get(businessId, changeId);
  if (!row) throw new AppError(404, "Сначала сохраните A/B-план.");
  return row;
}

export function directAbActions(db, userId, businessId, changeId) {
  requireBusiness(db, userId, businessId);
  return db
    .prepare(
      "SELECT * FROM direct_ab_actions WHERE business_id=? AND change_id=? ORDER BY created_at DESC,rowid DESC LIMIT 10",
    )
    .all(businessId, changeId)
    .map(actionView);
}

function assertNoOtherAction(db, businessId, campaignId) {
  for (const table of [
    "direct_lifecycle_actions",
    "direct_archive_actions",
    "direct_moderation_actions",
    "direct_resume_actions",
    "direct_budget_actions",
    "direct_ab_decision_actions",
  ]) {
    if (
      db
        .prepare(
          `SELECT 1 FROM ${table} WHERE business_id=? AND campaign_id=? AND status IN ${active}`,
        )
        .get(businessId, campaignId)
    )
      throw new AppError(
        409,
        "Другое действие с кампанией ещё требует сверки.",
      );
  }
}

function moscowDate(now) {
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Europe/Moscow",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(now));
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
  };
}

function exactAd(ad, expected, adGroupId) {
  const copy = remoteCopy(ad);
  return (
    String(ad?.AdGroupId) === String(adGroupId) &&
    copy.title === expected.title &&
    copy.text === expected.text &&
    copy.href === expected.href
  );
}

function matchingVariantAds(response, plan, adGroupId) {
  if (!Array.isArray(response?.Ads))
    throw new AppError(502, "Не удалось прочитать объявления группы.");
  return response.Ads.filter(
    (ad) =>
      String(ad.Id) !== String(plan.control.adId) &&
      exactAd(ad, plan.variant, adGroupId),
  );
}

function markPlanVariant(db, planId, variantAdId) {
  const row = db
    .prepare("SELECT plan_json FROM direct_ab_plans WHERE id=?")
    .get(planId);
  const plan = JSON.parse(row.plan_json);
  plan.variant.adId = String(variantAdId);
  plan.blockers = plan.blockers.filter(
    (item) => !item.includes("Вариант B ещё не создан"),
  );
  db.prepare("UPDATE direct_ab_plans SET plan_json=? WHERE id=?").run(
    JSON.stringify(plan),
    planId,
  );
}

function transition(
  db,
  userId,
  businessId,
  actionId,
  expected,
  status,
  values = {},
) {
  return transaction(db, () => {
    requireBusiness(db, userId, businessId);
    const row = actionRow(db, businessId, actionId);
    if (connectedId(db, businessId) !== row.connection_id)
      throw new AppError(409, "Подключение изменилось во время операции.");
    if (row.status !== expected)
      throw new AppError(409, "Состояние операции изменилось.");
    db.prepare(
      `UPDATE direct_ab_actions SET status=?,write_attempted=?,variant_ad_id=?,
      error_code=?,updated_at=? WHERE id=?`,
    ).run(
      status,
      values.writeAttempted ? 1 : row.write_attempted,
      values.variantAdId ? String(values.variantAdId) : row.variant_ad_id,
      values.errorCode ?? null,
      new Date().toISOString(),
      actionId,
    );
    if (status === "succeeded" && values.variantAdId)
      markPlanVariant(db, row.plan_id, values.variantAdId);
    if (["succeeded", "not_applied", "needs_reconciliation"].includes(status))
      event(db, businessId, {
        kind:
          status === "succeeded"
            ? "direct_ab_variant_created"
            : "direct_ab_variant_uncertain",
        title:
          status === "succeeded"
            ? "Вариант Б создан выключенным"
            : status === "not_applied"
              ? "Вариант Б не был создан"
              : "Создание варианта Б требует сверки",
        reason: `Кампания ${row.campaign_id}, группа ${row.ad_group_id}; объявление ${values.variantAdId || "не подтверждено"}. Показы не включались.`,
        rule: "direct/ab-variant@1",
        jobId: actionId,
      });
    return actionView(actionRow(db, businessId, actionId));
  });
}

function begin(
  db,
  userId,
  businessId,
  changeId,
  requestKey,
  connectionId,
  now,
) {
  return transaction(db, () => {
    requireBusiness(db, userId, businessId);
    const planRowValue = planRow(db, businessId, changeId);
    const plan = JSON.parse(planRowValue.plan_json);
    const previous = db
      .prepare(
        "SELECT * FROM direct_ab_actions WHERE business_id=? AND idempotency_key=?",
      )
      .get(businessId, requestKey);
    if (previous) {
      if (previous.plan_id !== planRowValue.id)
        throw new AppError(
          409,
          "Ключ уже использован для другого A/B-действия.",
        );
      return { action: actionView(previous), created: false, plan };
    }
    if (
      plan.variant.adId ||
      db
        .prepare(
          "SELECT 1 FROM direct_ab_actions WHERE plan_id=? AND status='succeeded'",
        )
        .get(planRowValue.id)
    )
      throw new AppError(409, "Вариант Б уже создан и подтверждён.");
    if (
      planRowValue.connection_id !== connectionId ||
      connectedId(db, businessId) !== connectionId
    )
      throw new AppError(409, "Яндекс-кабинет изменился после создания плана.");
    if (moscowDate(now) >= plan.periodStart)
      throw new AppError(
        409,
        "Вариант Б нужно создать до начала периода эксперимента.",
      );
    const execution = directExecution(db, userId, businessId, changeId);
    const campaignId = execution.calls.find((item) => item.key === "campaign")
      ?.ids[0];
    const adGroupId = execution.calls.find((item) => item.key === "adgroup")
      ?.ids[0];
    const controlAdId = execution.calls.find((item) => item.key === "ads")
      ?.ids[0];
    if (
      execution.status !== "succeeded" ||
      !execution.suspendVerified ||
      String(campaignId) !== String(planRowValue.campaign_id) ||
      !Number.isSafeInteger(Number(adGroupId)) ||
      String(controlAdId) !== String(plan.control.adId)
    )
      throw new AppError(409, "Исходная кампания или объявление изменились.");
    assertNoOtherAction(db, businessId, campaignId);
    if (
      db
        .prepare(
          `SELECT 1 FROM direct_ab_actions WHERE plan_id=? AND status IN ${active}`,
        )
        .get(planRowValue.id)
    )
      throw new AppError(409, "Предыдущее создание варианта требует сверки.");
    const id = randomUUID();
    const at = new Date(now).toISOString();
    db.prepare(
      `INSERT INTO direct_ab_actions(
      id,business_id,plan_id,change_id,connection_id,campaign_id,ad_group_id,
      control_ad_id,idempotency_key,status,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,'checking',?,?)`,
    ).run(
      id,
      businessId,
      planRowValue.id,
      changeId,
      connectionId,
      Number(campaignId),
      Number(adGroupId),
      String(controlAdId),
      requestKey,
      at,
      at,
    );
    return {
      action: actionView(actionRow(db, businessId, id)),
      created: true,
      plan,
    };
  });
}

async function campaign(client, campaignId) {
  const response = await client.campaignBudgetById(campaignId);
  const item = response?.Campaigns?.find(
    (candidate) => String(candidate.Id) === String(campaignId),
  );
  if (!item || !heldCampaign(item))
    throw new AppError(409, "Кампания больше не выключена.");
  if (!["TEXT_CAMPAIGN", "UNIFIED_CAMPAIGN"].includes(item.Type))
    throw new AppError(409, "Тип кампании не поддерживает этот A/B-пилот.");
  return item;
}

function payloadFor(type, action, plan) {
  if (type === "UNIFIED_CAMPAIGN")
    return {
      AdGroupId: action.adGroupId,
      ResponsiveAd: {
        Titles: [plan.variant.title],
        Texts: [plan.variant.text],
        Href: plan.variant.href,
      },
    };
  return {
    AdGroupId: action.adGroupId,
    TextAd: {
      Title: plan.variant.title,
      Text: plan.variant.text,
      Href: plan.variant.href,
      Mobile: "NO",
    },
  };
}

async function reconcileRemote(client, action, plan) {
  const matches = matchingVariantAds(
    await client.adsByAdGroupId(action.adGroupId),
    plan,
    action.adGroupId,
  );
  return matches.length === 1 ? String(matches[0].Id) : null;
}

export async function createVerifiedAbVariant(
  db,
  userId,
  businessId,
  changeId,
  requestKey,
  client,
  connectionId,
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
  const { action, created, plan } = begin(
    db,
    userId,
    businessId,
    changeId,
    requestKey,
    connectionId,
    now,
  );
  if (!created) return action;
  if (
    !variantConfirmed ||
    String(confirmCampaignId) !== String(action.campaignId) ||
    String(confirmControlAdId) !== String(action.controlAdId)
  )
    return transition(
      db,
      userId,
      businessId,
      action.id,
      "checking",
      "failed_no_write",
      { errorCode: "confirmation_mismatch" },
    );
  let sending = false;
  try {
    const remoteCampaign = await campaign(client, action.campaignId);
    const control = await client.adsByIds([action.controlAdId]);
    if (
      !Array.isArray(control?.Ads) ||
      control.Ads.length !== 1 ||
      !exactAd(control.Ads[0], plan.control, action.adGroupId)
    )
      throw new AppError(409, "Контрольное объявление изменилось.");
    const existing = await reconcileRemote(client, action, plan);
    if (existing)
      return transition(
        db,
        userId,
        businessId,
        action.id,
        "checking",
        "succeeded",
        { variantAdId: existing },
      );
    transition(db, userId, businessId, action.id, "checking", "sending", {
      writeAttempted: true,
    });
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
    await campaign(client, action.campaignId);
    return transition(
      db,
      userId,
      businessId,
      action.id,
      "sending",
      "succeeded",
      { writeAttempted: true, variantAdId: result.Id },
    );
  } catch {
    if (!sending)
      return transition(
        db,
        userId,
        businessId,
        action.id,
        "checking",
        "failed_no_write",
        { errorCode: "precheck_failed" },
      );
    try {
      const confirmed = await reconcileRemote(client, action, plan);
      if (confirmed)
        return transition(
          db,
          userId,
          businessId,
          action.id,
          "sending",
          "succeeded",
          { writeAttempted: true, variantAdId: confirmed },
        );
    } catch {
      // Never replay a possibly accepted Ads.add call.
    }
    return transition(
      db,
      userId,
      businessId,
      action.id,
      "sending",
      "needs_reconciliation",
      { writeAttempted: true, errorCode: "unknown_result" },
    );
  }
}

export async function inspectAbVariantAction(
  db,
  userId,
  businessId,
  changeId,
  actionId,
  client,
) {
  requireBusiness(db, userId, businessId);
  const row = actionRow(db, businessId, actionId);
  if (row.change_id !== changeId)
    throw new AppError(404, "Действие A/B-теста не найдено.");
  if (row.connection_id !== connectedId(db, businessId))
    throw new AppError(409, "Подключение изменилось после операции.");
  if (row.status !== "needs_reconciliation")
    throw new AppError(409, "Для этой операции сверка не нужна.");
  const plan = JSON.parse(
    db
      .prepare("SELECT plan_json FROM direct_ab_plans WHERE id=?")
      .get(row.plan_id).plan_json,
  );
  const confirmed = await reconcileRemote(client, actionView(row), plan);
  if (confirmed)
    return transition(
      db,
      userId,
      businessId,
      actionId,
      "needs_reconciliation",
      "succeeded",
      { writeAttempted: true, variantAdId: confirmed },
    );
  return transition(
    db,
    userId,
    businessId,
    actionId,
    "needs_reconciliation",
    "not_applied",
    { writeAttempted: true, errorCode: "write_not_applied" },
  );
}

export function markInterruptedAbActions(db, now = Date.now()) {
  return transaction(db, () => {
    const at = new Date(now).toISOString();
    const checking = db
      .prepare(
        "UPDATE direct_ab_actions SET status='failed_no_write',error_code='process_interrupted_before_write',updated_at=? WHERE status='checking'",
      )
      .run(at);
    const sending = db
      .prepare(
        "UPDATE direct_ab_actions SET status='needs_reconciliation',error_code='process_interrupted',updated_at=? WHERE status='sending'",
      )
      .run(at);
    return checking.changes + sending.changes;
  });
}
