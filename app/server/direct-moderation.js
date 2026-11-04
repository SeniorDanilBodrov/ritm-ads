import { randomUUID } from "node:crypto";
import { AppError, event, requireBusiness, transaction } from "./db.js";
import { directExecution } from "./direct-execution.js";
import { directChangeForPreflight } from "./direct.js";
import { inspectDirectBudget } from "./direct-budget.js";
import { summarizeDirectMarking } from "./direct-marking.js";
import { directAbVariantForChange } from "./direct-ab.js";

const moscowDate = (now) =>
  new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Europe/Moscow",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(now));
const sameIds = (expected, actual) =>
  Array.isArray(actual) &&
  actual.length === expected.length &&
  expected.every((id) => actual.some((item) => String(item.Id) === String(id)));

function view(row) {
  return {
    id: row.id,
    changeId: row.change_id,
    campaignId: row.campaign_id,
    adIds: JSON.parse(row.ad_ids_json),
    status: row.status,
    writeAttempted: !!row.write_attempted,
    errorCode: row.error_code,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function actionRow(db, businessId, actionId) {
  const row = db
    .prepare(
      "SELECT * FROM direct_moderation_actions WHERE business_id=? AND id=?",
    )
    .get(businessId, actionId);
  if (!row) throw new AppError(404, "Действие модерации не найдено.");
  return row;
}

function connectionId(db, businessId) {
  const row = db
    .prepare(
      "SELECT metadata FROM connections WHERE business_id=? AND provider='yandex'",
    )
    .get(businessId);
  return row ? JSON.parse(row.metadata).connectionId : null;
}

function campaignIds(db, userId, businessId, changeId, currentConnectionId) {
  const { business, change } = directChangeForPreflight(
    db,
    userId,
    businessId,
    changeId,
  );
  const execution = directExecution(db, userId, businessId, changeId);
  if (execution.status !== "succeeded" || !execution.suspendVerified)
    throw new AppError(409, "Кампания ещё не прошла сверку создания.");
  const saved = db
    .prepare(
      "SELECT connection_id FROM direct_executions WHERE business_id=? AND change_id=?",
    )
    .get(businessId, changeId);
  if (saved?.connection_id !== currentConnectionId)
    throw new AppError(409, "Кабинет изменился после создания кампании.");
  const ids = Object.fromEntries(
    execution.calls.map((item) => [item.key, item.ids]),
  );
  const campaignId = ids.campaign?.[0];
  const variant = directAbVariantForChange(db, businessId, changeId);
  const adIds = variant ? [...ids.ads, variant.adId] : ids.ads;
  if (
    !Number.isSafeInteger(campaignId) ||
    campaignId <= 0 ||
    !ids.ads?.length ||
    !ids.keywords?.length ||
    !ids.adgroup?.length
  )
    throw new AppError(409, "Не все ID кампании подтверждены.");
  return {
    business,
    change,
    campaignId,
    adIds,
    expectedAds: [
      ...change.plan.ads.map((ad, index) => ({ ...ad, adId: ids.ads[index] })),
      ...(variant ? [variant] : []),
    ],
    keywordIds: ids.keywords,
    groupIds: ids.adgroup,
  };
}

export function moderationActions(db, userId, businessId, changeId) {
  requireBusiness(db, userId, businessId);
  return db
    .prepare(
      "SELECT * FROM direct_moderation_actions WHERE business_id=? AND change_id=? ORDER BY created_at DESC,rowid DESC LIMIT 10",
    )
    .all(businessId, changeId)
    .map(view);
}

export async function inspectModerationReadiness(
  db,
  userId,
  businessId,
  changeId,
  client,
  currentConnectionId,
  now = Date.now(),
) {
  const {
    business,
    change,
    campaignId,
    adIds,
    expectedAds,
    keywordIds,
    groupIds,
  } = campaignIds(db, userId, businessId, changeId, currentConnectionId);
  const [budget, adsResult, keywordsResult, markingResponse] =
    await Promise.all([
      inspectDirectBudget(
        db,
        userId,
        businessId,
        changeId,
        client,
        currentConnectionId,
        now,
      ),
      client.adsByIds(adIds),
      client.keywordsByIds(keywordIds),
      client.advertiserMarkingDetails(),
    ]);
  const ads = adsResult?.Ads;
  const keywords = keywordsResult?.Keywords;
  if (!sameIds(adIds, ads) || !sameIds(keywordIds, keywords))
    throw new AppError(
      502,
      "Директ не вернул полный состав объявлений и фраз.",
    );
  const marking = summarizeDirectMarking(markingResponse, now);
  const blockers = [];
  if (budget.status !== "matched") blockers.push("budget_drift");
  if (
    budget.remote.state !== "SUSPENDED" &&
    !(budget.remote.state === "OFF" && budget.remote.status === "DRAFT")
  )
    blockers.push("campaign_not_held");
  if (change.plan.periodEnd < moscowDate(now)) blockers.push("period_ended");
  if (
    !business.state.website ||
    new URL(business.state.website).hostname !==
      new URL(change.plan.website).hostname
  )
    blockers.push("website_changed");
  if (!marking.basicFieldsPresent) blockers.push("advertiser_data_incomplete");
  if (
    ads.some(
      (ad) =>
        ad.Status !== "DRAFT" ||
        String(ad.CampaignId) !== String(campaignId) ||
        !groupIds.some((id) => String(id) === String(ad.AdGroupId)),
    )
  )
    blockers.push("ads_not_draft");
  if (
    ads.some((ad) => {
      const planned = expectedAds.find(
        (item) => String(item.adId) === String(ad.Id),
      );
      const title =
        ad.ResponsiveAd?.Titles?.map((item) => item.Title) ||
        (ad.TextAd ? [ad.TextAd.Title] : []);
      const text =
        ad.ResponsiveAd?.Texts?.map((item) => item.Text) ||
        (ad.TextAd ? [ad.TextAd.Text] : []);
      const href = ad.ResponsiveAd?.Href || ad.TextAd?.Href;
      return (
        !planned ||
        !title.includes(planned.title) ||
        !text.includes(planned.text) ||
        href !== planned.href
      );
    })
  )
    blockers.push("ad_content_changed");
  if (
    keywords.some(
      (item) =>
        String(item.CampaignId) !== String(campaignId) ||
        !groupIds.some((id) => String(id) === String(item.AdGroupId)),
    )
  )
    blockers.push("keywords_mismatch");
  if (
    db
      .prepare(
        "SELECT 1 FROM direct_moderation_actions WHERE business_id=? AND campaign_id=? AND status IN ('checking','sending','needs_reconciliation')",
      )
      .get(businessId, campaignId)
  )
    blockers.push("previous_action_unresolved");
  if (
    db
      .prepare(
        "SELECT 1 FROM direct_lifecycle_actions WHERE business_id=? AND campaign_id=? AND status IN ('checking','sending','needs_reconciliation')",
      )
      .get(businessId, campaignId) ||
    db
      .prepare(
        "SELECT 1 FROM direct_archive_actions WHERE business_id=? AND campaign_id=? AND status IN ('checking','sending','needs_reconciliation')",
      )
      .get(businessId, campaignId) ||
    db
      .prepare(
        "SELECT 1 FROM direct_resume_actions WHERE business_id=? AND campaign_id=? AND status IN ('checking','sending','needs_reconciliation')",
      )
      .get(businessId, campaignId) ||
    db
      .prepare(
        "SELECT 1 FROM direct_budget_actions WHERE business_id=? AND campaign_id=? AND status IN ('checking','sending','needs_reconciliation')",
      )
      .get(businessId, campaignId) ||
    db
      .prepare(
        "SELECT 1 FROM direct_ab_actions WHERE business_id=? AND campaign_id=? AND status IN ('checking','sending','needs_reconciliation')",
      )
      .get(businessId, campaignId) ||
    db
      .prepare(
        "SELECT 1 FROM direct_ab_decision_actions WHERE business_id=? AND campaign_id=? AND status IN ('checking','sending','needs_reconciliation')",
      )
      .get(businessId, campaignId)
  )
    blockers.push("campaign_action_unresolved");
  return {
    changeId,
    campaignId,
    adIds,
    checkedAt: new Date(now).toISOString(),
    status: blockers.length ? "blocked" : "technical_ready",
    blockers,
    marking: {
      basicFieldsPresent: marking.basicFieldsPresent,
      findings: marking.findings,
    },
    manualChecks: [
      "Подтвердить настоящего рекламодателя и корректность его данных в Директе.",
      "Проверить работающий сайт и содержание каждого объявления.",
    ],
    campaignHeld:
      budget.remote.state === "SUSPENDED" || budget.remote.state === "OFF",
    externalWrites: 0,
  };
}

function begin(
  db,
  userId,
  businessId,
  changeId,
  requestKey,
  currentConnectionId,
  now,
) {
  return transaction(db, () => {
    const { campaignId, adIds } = campaignIds(
      db,
      userId,
      businessId,
      changeId,
      currentConnectionId,
    );
    const previous = db
      .prepare(
        "SELECT * FROM direct_moderation_actions WHERE business_id=? AND idempotency_key=?",
      )
      .get(businessId, requestKey);
    if (previous) {
      if (previous.change_id !== changeId)
        throw new AppError(409, "Ключ уже использован для другой кампании.");
      return { action: view(previous), created: false };
    }
    if (
      db
        .prepare(
          "SELECT 1 FROM direct_moderation_actions WHERE business_id=? AND campaign_id=? AND status IN ('checking','sending','needs_reconciliation')",
        )
        .get(businessId, campaignId)
    )
      throw new AppError(409, "Предыдущее действие модерации требует сверки.");
    if (
      db
        .prepare(
          "SELECT 1 FROM direct_lifecycle_actions WHERE business_id=? AND campaign_id=? AND status IN ('checking','sending','needs_reconciliation')",
        )
        .get(businessId, campaignId) ||
      db
        .prepare(
          "SELECT 1 FROM direct_archive_actions WHERE business_id=? AND campaign_id=? AND status IN ('checking','sending','needs_reconciliation')",
        )
        .get(businessId, campaignId) ||
      db
        .prepare(
          "SELECT 1 FROM direct_resume_actions WHERE business_id=? AND campaign_id=? AND status IN ('checking','sending','needs_reconciliation')",
        )
        .get(businessId, campaignId) ||
      db
        .prepare(
          "SELECT 1 FROM direct_budget_actions WHERE business_id=? AND campaign_id=? AND status IN ('checking','sending','needs_reconciliation')",
        )
        .get(businessId, campaignId) ||
      db
        .prepare(
          "SELECT 1 FROM direct_ab_actions WHERE business_id=? AND campaign_id=? AND status IN ('checking','sending','needs_reconciliation')",
        )
        .get(businessId, campaignId) ||
      db
        .prepare(
          "SELECT 1 FROM direct_ab_decision_actions WHERE business_id=? AND campaign_id=? AND status IN ('checking','sending','needs_reconciliation')",
        )
        .get(businessId, campaignId)
    )
      throw new AppError(409, "Другое действие с кампанией требует сверки.");
    const id = randomUUID();
    const at = new Date(now).toISOString();
    db.prepare(
      `INSERT INTO direct_moderation_actions
      (id,business_id,change_id,connection_id,campaign_id,idempotency_key,ad_ids_json,status,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,'checking',?,?)`,
    ).run(
      id,
      businessId,
      changeId,
      currentConnectionId,
      campaignId,
      requestKey,
      JSON.stringify(adIds),
      at,
      at,
    );
    return { action: view(actionRow(db, businessId, id)), created: true };
  });
}

function transition(
  db,
  userId,
  businessId,
  actionId,
  expected,
  status,
  writeAttempted,
  errorCode = null,
) {
  return transaction(db, () => {
    requireBusiness(db, userId, businessId);
    const current = actionRow(db, businessId, actionId);
    if (current.connection_id !== connectionId(db, businessId))
      throw new AppError(409, "Кабинет изменился во время модерации.");
    if (current.status !== expected)
      throw new AppError(
        409,
        "Состояние модерации изменилось во время запроса.",
      );
    const at = new Date().toISOString();
    db.prepare(
      `UPDATE direct_moderation_actions SET status=?,write_attempted=?,error_code=?,updated_at=? WHERE id=?`,
    ).run(
      status,
      writeAttempted ? 1 : current.write_attempted,
      errorCode,
      at,
      actionId,
    );
    if (["succeeded", "needs_reconciliation"].includes(status))
      event(db, businessId, {
        kind:
          status === "succeeded"
            ? "direct_ads_moderation_submitted"
            : "direct_ads_moderation_uncertain",
        title:
          status === "succeeded"
            ? "Объявления отправлены на модерацию"
            : "Модерация требует сверки",
        reason: `Кампания ${current.campaign_id}; показы не возобновлялись.`,
        rule: "direct/moderation@1",
        jobId: actionId,
      });
    return view(actionRow(db, businessId, actionId));
  });
}

function submittedAds(adIds, response) {
  return (
    sameIds(adIds, response?.Ads) &&
    response.Ads.every((ad) =>
      ["MODERATION", "PREACCEPTED", "ACCEPTED", "REJECTED"].includes(
        ad.Status,
      ),
    )
  );
}

export async function submitVerifiedModeration(
  db,
  userId,
  businessId,
  changeId,
  requestKey,
  client,
  currentConnectionId,
  {
    enabled = false,
    advertiserConfirmed = false,
    siteConfirmed = false,
    now = Date.now(),
  } = {},
) {
  if (!enabled)
    throw new AppError(409, "Отправка на модерацию отключена.", "live_gate");
  if (!advertiserConfirmed || !siteConfirmed)
    throw new AppError(400, "Подтвердите рекламодателя и содержание сайта.");
  if (!/^[0-9a-f-]{36}$/i.test(requestKey))
    throw new AppError(400, "Некорректный ключ запроса.");
  const { action, created } = begin(
    db,
    userId,
    businessId,
    changeId,
    requestKey,
    currentConnectionId,
    now,
  );
  if (!created) return action;
  let sending = false;
  try {
    const readiness = await inspectModerationReadiness(
      db,
      userId,
      businessId,
      changeId,
      client,
      currentConnectionId,
      now,
    );
    const blockers = readiness.blockers.filter(
      (code) => code !== "previous_action_unresolved",
    );
    if (blockers.length)
      throw new AppError(
        409,
        `Модерация заблокирована: ${blockers.join(", ")}`,
      );
    transition(db, userId, businessId, action.id, "checking", "sending", true);
    sending = true;
    const response = await client.moderateAds(action.adIds);
    if (
      !sameIds(action.adIds, response?.ModerateResults) ||
      response.ModerateResults.some((item) => item.Errors?.length)
    )
      throw new AppError(
        502,
        "Директ не подтвердил модерацию всех объявлений.",
      );
    const after = await client.adsByIds(action.adIds);
    if (!submittedAds(action.adIds, after))
      throw new AppError(
        502,
        "Статус объявлений после модерации не подтверждён.",
      );
    return transition(
      db,
      userId,
      businessId,
      action.id,
      "sending",
      "succeeded",
      true,
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
        false,
        "precheck_failed",
      );
    try {
      if (submittedAds(action.adIds, await client.adsByIds(action.adIds)))
        return transition(
          db,
          userId,
          businessId,
          action.id,
          "sending",
          "succeeded",
          true,
        );
    } catch {
      /* uncertain remote result */
    }
    return transition(
      db,
      userId,
      businessId,
      action.id,
      "sending",
      "needs_reconciliation",
      true,
      "unknown_result",
    );
  }
}

export async function inspectModerationAction(
  db,
  userId,
  businessId,
  changeId,
  actionId,
  client,
) {
  requireBusiness(db, userId, businessId);
  const current = actionRow(db, businessId, actionId);
  if (current.change_id !== changeId)
    throw new AppError(404, "Действие модерации не найдено.");
  if (current.connection_id !== connectionId(db, businessId))
    throw new AppError(409, "Кабинет изменился после модерации.");
  if (current.status !== "needs_reconciliation")
    throw new AppError(409, "Для этого действия сверка не нужна.");
  const after = await client.adsByIds(JSON.parse(current.ad_ids_json));
  if (submittedAds(JSON.parse(current.ad_ids_json), after))
    return transition(
      db,
      userId,
      businessId,
      actionId,
      "needs_reconciliation",
      "succeeded",
      true,
    );
  return view(current);
}

export function markInterruptedModerationActions(db, now = Date.now()) {
  return transaction(db, () => {
    const at = new Date(now).toISOString();
    const before = db
      .prepare(
        "UPDATE direct_moderation_actions SET status='failed_no_write',error_code='process_interrupted_before_write',updated_at=? WHERE status='checking'",
      )
      .run(at);
    const after = db
      .prepare(
        "UPDATE direct_moderation_actions SET status='needs_reconciliation',error_code='process_interrupted',updated_at=? WHERE status='sending'",
      )
      .run(at);
    return before.changes + after.changes;
  });
}
