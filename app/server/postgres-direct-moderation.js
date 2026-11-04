import { randomUUID } from "node:crypto";
import { AppError } from "./db.js";
import { summarizeDirectMarking } from "./direct-marking.js";

const activeStatuses = "('checking','sending','needs_reconciliation')";

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

function actionView(row) {
  return {
    id: row.id,
    changeId: row.change_id,
    campaignId: Number(row.campaign_id),
    adIds: JSON.parse(row.ad_ids_json),
    status: row.status,
    writeAttempted: !!row.write_attempted,
    errorCode: row.error_code,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
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

async function actionRow(db, businessId, actionId) {
  const row = await db
    .prepare(
      "SELECT * FROM direct_moderation_actions WHERE business_id=? AND id=?",
    )
    .get(businessId, actionId);
  if (!row)
    throw new AppError(404, "Действие модерации не найдено.", "action_missing");
  return row;
}

async function connectedId(db, businessId) {
  const row = await db
    .prepare(
      "SELECT metadata FROM connections WHERE business_id=? AND provider='yandex'",
    )
    .get(businessId);
  return row ? JSON.parse(row.metadata).connectionId : null;
}

async function campaignBundle(
  db,
  userId,
  businessId,
  changeId,
  currentConnectionId,
) {
  const business = await ownedBusiness(db, userId, businessId);
  const row = await db
    .prepare(
      `SELECT dc.plan_json,de.connection_id,de.status,de.suspend_verified,de.calls_json,
              cba.limit_kopecks
       FROM direct_changes dc JOIN direct_executions de ON de.change_id=dc.id
       LEFT JOIN campaign_budget_allocations cba
         ON cba.business_id=dc.business_id AND cba.change_id=dc.id
       WHERE dc.id=? AND dc.business_id=?`,
    )
    .get(changeId, business.id);
  if (!row)
    throw new AppError(404, "Созданная кампания не найдена.", "change_missing");
  if (row.status !== "succeeded" || !row.suspend_verified)
    throw new AppError(409, "Кампания ещё не прошла сверку создания.");
  if (row.connection_id !== currentConnectionId)
    throw new AppError(409, "Кабинет изменился после создания кампании.");
  const plan = JSON.parse(row.plan_json);
  if (
    Number.isSafeInteger(Number(row.limit_kopecks)) &&
    Number(row.limit_kopecks) > 0
  )
    plan.budget = Number(row.limit_kopecks);
  const calls = JSON.parse(row.calls_json);
  const ids = Object.fromEntries(calls.map((item) => [item.key, item.ids]));
  const campaignId = Number(ids.campaign?.[0]);
  const adIds = ids.ads || [];
  const keywordIds = ids.keywords || [];
  const groupIds = ids.adgroup || [];
  const network = plan.channel === "network";
  if (
    !Number.isSafeInteger(campaignId) ||
    campaignId <= 0 ||
    !adIds.length ||
    (!network && !keywordIds.length) ||
    !groupIds.length
  )
    throw new AppError(409, "Не все ID кампании подтверждены.");
  return {
    business,
    plan,
    campaignId,
    adIds,
    keywordIds,
    groupIds,
    network,
    expectedAds: plan.ads.map((ad, index) => ({
      ...ad,
      adId: adIds[index],
    })),
  };
}

function periodBudget(remote, network = false) {
  const strategy =
    remote.UnifiedCampaign?.BiddingStrategy ||
    remote.TextCampaign?.BiddingStrategy;
  const placement = network ? strategy?.Network : strategy?.Search;
  const period = placement?.WbMaximumClicks?.CustomPeriodBudget;
  const micros = period?.SpendLimit;
  return {
    strategy,
    period,
    limitKopecks:
      Number.isSafeInteger(micros) && micros >= 0 && micros % 10_000 === 0
        ? micros / 10_000
        : null,
  };
}

function strategyMatchesPlan(strategy, network) {
  if (network)
    return (
      strategy?.Search?.BiddingStrategyType === "SERVING_OFF" &&
      strategy?.Network?.BiddingStrategyType === "WB_MAXIMUM_CLICKS" &&
      strategy?.Network?.PlacementTypes?.Network === "YES" &&
      strategy?.Network?.PlacementTypes?.Maps === "NO"
    );
  return (
    strategy?.Search?.BiddingStrategyType === "WB_MAXIMUM_CLICKS" &&
    strategy?.Network?.BiddingStrategyType === "SERVING_OFF"
  );
}

function campaignTypeMatchesPlan(type, network) {
  if (network) return type === "UNIFIED_CAMPAIGN";
  return type === "TEXT_CAMPAIGN" || type === "UNIFIED_CAMPAIGN";
}

function responsiveImageHashes(ad) {
  const source =
    ad?.ResponsiveAd?.AdImages || ad?.ResponsiveAd?.AdImageHashes || [];
  const values = Array.isArray(source)
    ? source
    : Array.isArray(source?.Items)
      ? source.Items
      : [];
  return values
    .map((item) =>
      typeof item === "string"
        ? item
        : item?.ImageHash || item?.AdImageHash || item?.Hash,
    )
    .filter(Boolean);
}

async function spendEvidence(db, businessId, login, campaignId, plan, now) {
  const row = await db
    .prepare(
      `SELECT date_from,date_to,received_at,rows_json
       FROM report_snapshots
       WHERE business_id=? AND scope='campaign' AND source='yandex' AND login=?
       ORDER BY received_at DESC,id DESC LIMIT 1`,
    )
    .get(businessId, login);
  if (!row) return null;
  const receivedAt = Date.parse(row.received_at);
  const through = [plan.periodEnd, moscowDate(now)].sort()[0];
  if (
    !Number.isFinite(receivedAt) ||
    receivedAt > now ||
    now - receivedAt > 48 * 3_600_000 ||
    row.date_from > plan.periodStart ||
    row.date_to < through
  )
    return null;
  const rows = JSON.parse(row.rows_json);
  const spentKopecks = rows
    .filter(
      (item) =>
        String(item.CampaignId) === String(campaignId) &&
        item.Date >= plan.periodStart &&
        item.Date <= plan.periodEnd,
    )
    .reduce((sum, item) => {
      if (!Number.isSafeInteger(item.spent) || item.spent < 0)
        throw new AppError(502, "Расход отчёта не прошёл проверку.");
      return sum + item.spent;
    }, 0);
  return {
    spentKopecks,
    receivedAt: row.received_at,
    dateTo: row.date_to,
  };
}

export async function postgresControlReviews(db, userId, businessId) {
  await ownedBusiness(db, userId, businessId);
  const rows = await db
    .prepare(
      `SELECT result_json FROM direct_control_reviews
       WHERE business_id=? ORDER BY checked_at DESC,id DESC LIMIT 20`,
    )
    .all(businessId);
  return rows.map((row) => JSON.parse(row.result_json));
}

export async function inspectPostgresDirectControl(
  db,
  userId,
  businessId,
  changeId,
  requestKey,
  client,
  currentConnectionId,
  now = Date.now(),
) {
  if (!/^[0-9a-f-]{36}$/i.test(requestKey))
    throw new AppError(400, "Некорректный ключ запроса.");
  const previous = await db
    .prepare(
      `SELECT change_id,result_json FROM direct_control_reviews
       WHERE business_id=? AND request_key=?`,
    )
    .get(businessId, requestKey);
  if (previous) {
    if (previous.change_id !== changeId)
      throw new AppError(409, "Ключ уже использован для другой кампании.");
    return JSON.parse(previous.result_json);
  }
  const bundle = await campaignBundle(
    db,
    userId,
    businessId,
    changeId,
    currentConnectionId,
  );
  const [campaignResult, groupsResult, adsResult, keywordsResult] =
    await Promise.all([
      client.campaignBudgetById(bundle.campaignId),
      client.adGroupsByIds(bundle.groupIds),
      client.adsByIds(bundle.adIds),
      bundle.keywordIds.length
        ? client.keywordsByIds(bundle.keywordIds)
        : Promise.resolve({ Keywords: [] }),
    ]);
  const campaigns = campaignResult?.Campaigns;
  const groups = groupsResult?.AdGroups;
  const ads = adsResult?.Ads;
  const keywords = keywordsResult?.Keywords;
  if (!sameIds([bundle.campaignId], campaigns))
    throw new AppError(502, "Директ не вернул созданную кампанию.");
  if (
    !sameIds(bundle.groupIds, groups) ||
    !sameIds(bundle.adIds, ads) ||
    !sameIds(bundle.keywordIds, keywords)
  )
    throw new AppError(502, "Директ не вернул полный состав кампании.");
  const remote = campaigns[0];
  const budget = periodBudget(remote, bundle.network);
  const spend = await spendEvidence(
    db,
    businessId,
    bundle.plan.login,
    bundle.campaignId,
    bundle.plan,
    now,
  );
  const blockers = [];
  const date = moscowDate(now);
  const expectedGroupType =
    bundle.network || remote.Type === "UNIFIED_CAMPAIGN"
      ? "UNIFIED_AD_GROUP"
      : "TEXT_AD_GROUP";
  if (
    !campaignTypeMatchesPlan(remote.Type, bundle.network) ||
    remote.Currency !== "RUB"
  )
    blockers.push("campaign_contract_changed");
  if (date < bundle.plan.periodStart) blockers.push("period_not_started");
  if (date > bundle.plan.periodEnd) blockers.push("period_ended");
  try {
    if (
      !bundle.business.state.website ||
      new URL(bundle.business.state.website).hostname !==
        new URL(bundle.plan.website).hostname
    )
      blockers.push("website_changed");
  } catch {
    blockers.push("website_changed");
  }
  if (
    !strategyMatchesPlan(budget.strategy, bundle.network) ||
    budget.limitKopecks !== bundle.plan.budget ||
    budget.period?.StartDate !== bundle.plan.periodStart ||
    budget.period?.EndDate !== bundle.plan.periodEnd ||
    budget.period?.AutoContinue !== "NO"
  )
    blockers.push("budget_drift");
  if (!["OFF", "SUSPENDED"].includes(remote.State))
    blockers.push("campaign_not_suspended");
  if (["MODERATION", "PREACCEPTED"].includes(remote.Status))
    blockers.push("campaign_under_review");
  else if (remote.Status !== "ACCEPTED") blockers.push("campaign_not_accepted");
  if (remote.StatusPayment !== "ALLOWED")
    blockers.push("payment_not_confirmed");
  if (
    groups.some(
      (group) =>
        String(group.CampaignId) !== String(bundle.campaignId) ||
        (group.Type && group.Type !== expectedGroupType),
    )
  )
    blockers.push("group_mismatch");
  const adsUnderReview = ads.some((ad) =>
    ["MODERATION", "PREACCEPTED"].includes(ad.Status),
  );
  if (adsUnderReview) blockers.push("ads_under_review");
  else if (
    ads.some(
      (ad) =>
        String(ad.CampaignId) !== String(bundle.campaignId) ||
        !bundle.groupIds.some(
          (groupId) => String(groupId) === String(ad.AdGroupId),
        ) ||
        ad.Status !== "ACCEPTED" ||
        ["SUSPENDED", "OFF_BY_MONITORING", "ARCHIVED"].includes(ad.State),
    )
  )
    blockers.push("ads_not_ready");
  if (
    bundle.keywordIds.length &&
    keywords.some(
      (keyword) =>
        String(keyword.CampaignId) !== String(bundle.campaignId) ||
        !bundle.groupIds.some(
          (groupId) => String(groupId) === String(keyword.AdGroupId),
        ) ||
        keyword.Status !== "ACCEPTED" ||
        !["ON", "SUSPENDED"].includes(keyword.State),
    )
  )
    blockers.push("keywords_not_ready");
  if (!spend) blockers.push("spend_not_verified");
  if (spend && spend.spentKopecks >= bundle.plan.budget)
    blockers.push("budget_exhausted");
  const result = {
    id: randomUUID(),
    changeId,
    campaignId: bundle.campaignId,
    checkedAt: new Date(now).toISOString(),
    status: blockers.length ? "blocked" : "technical_ready",
    blockers: [...new Set(blockers)],
    budget: {
      limitKopecks: budget.limitKopecks,
      spentKopecks: spend?.spentKopecks ?? null,
      reportReceivedAt: spend?.receivedAt ?? null,
      reportDateTo: spend?.dateTo ?? null,
    },
    remote: {
      state: remote.State,
      status: remote.Status,
      statusPayment: remote.StatusPayment,
      groups: groups.length,
      ads: ads.length,
      keywords: keywords.length,
    },
    manualChecks: [
      "Подтвердить данные реального рекламодателя и содержимое страницы.",
      "Проверить маркировку рекламы и решение модерации.",
      "Отдельно согласовать запуск показов и предел расходов.",
    ],
    safeToResume: false,
    externalWrites: 0,
  };
  return db.transaction(async (tx) => {
    const currentConnection = await connectedId(tx, businessId);
    if (currentConnection !== currentConnectionId)
      throw new AppError(
        409,
        "Кабинет изменился во время проверки. Повторите чтение.",
      );
    const inserted = await tx
      .prepare(
        `INSERT INTO direct_control_reviews
         (id,business_id,change_id,connection_id,request_key,checked_at,result_json)
         VALUES(?,?,?,?,?,?,?) ON CONFLICT (business_id,request_key) DO NOTHING`,
      )
      .run(
        result.id,
        businessId,
        changeId,
        currentConnectionId,
        requestKey,
        result.checkedAt,
        JSON.stringify(result),
      );
    if (!inserted.changes) {
      const prior = await tx
        .prepare(
          `SELECT change_id,result_json FROM direct_control_reviews
           WHERE business_id=? AND request_key=?`,
        )
        .get(businessId, requestKey);
      if (prior?.change_id === changeId) return JSON.parse(prior.result_json);
      throw new AppError(409, "Ключ уже использован для другой кампании.");
    }
    await addEvent(tx, businessId, {
      kind: "direct_control_review",
      title: "Ритм проверил решение Яндекса",
      reason: result.blockers.includes("campaign_not_accepted")
        ? "Яндекс ещё не принял кампанию после модерации."
        : result.blockers.includes("ads_not_ready")
          ? "Одно или несколько объявлений ещё не готовы к показам."
          : "Статусы кампании и объявлений прочитаны без изменений рекламы.",
      source: "Ритм",
    });
    return result;
  });
}

async function hasOtherAction(db, businessId, campaignId) {
  for (const table of [
    "direct_lifecycle_actions",
    "direct_archive_actions",
    "direct_resume_actions",
    "direct_budget_actions",
    "direct_ab_actions",
    "direct_ab_decision_actions",
  ]) {
    const row = await db
      .prepare(
        `SELECT 1 AS found FROM ${table} WHERE business_id=? AND campaign_id=? AND status IN ${activeStatuses} LIMIT 1`,
      )
      .get(businessId, campaignId);
    if (row) return true;
  }
  return false;
}

export async function postgresModerationActions(
  db,
  userId,
  businessId,
  changeId,
) {
  await ownedBusiness(db, userId, businessId);
  const rows = await db
    .prepare(
      "SELECT * FROM direct_moderation_actions WHERE business_id=? AND change_id=? ORDER BY created_at DESC,id DESC LIMIT 10",
    )
    .all(businessId, changeId);
  return rows.map(actionView);
}

export async function inspectPostgresModerationReadiness(
  db,
  userId,
  businessId,
  changeId,
  client,
  currentConnectionId,
  now = Date.now(),
) {
  const bundle = await campaignBundle(
    db,
    userId,
    businessId,
    changeId,
    currentConnectionId,
  );
  const [
    campaignResult,
    groupsResult,
    adsResult,
    keywordsResult,
    markingResponse,
  ] = await Promise.all([
    client.campaignBudgetById(bundle.campaignId),
    bundle.network
      ? client.adGroupsByIds(bundle.groupIds)
      : Promise.resolve({ AdGroups: [] }),
    client.adsByIds(bundle.adIds),
    bundle.keywordIds.length
      ? client.keywordsByIds(bundle.keywordIds)
      : Promise.resolve({ Keywords: [] }),
    client.advertiserMarkingDetails(),
  ]);
  const campaigns = campaignResult?.Campaigns;
  const groups = groupsResult?.AdGroups;
  const ads = adsResult?.Ads;
  const keywords = keywordsResult?.Keywords;
  if (!sameIds([bundle.campaignId], campaigns))
    throw new AppError(502, "Директ не вернул созданную кампанию.");
  if (bundle.network && !sameIds(bundle.groupIds, groups))
    throw new AppError(502, "Директ не вернул группу сетевой кампании.");
  if (!sameIds(bundle.adIds, ads) || !sameIds(bundle.keywordIds, keywords))
    throw new AppError(
      502,
      "Директ не вернул полный состав объявлений и фраз.",
    );
  const remote = campaigns[0];
  const budget = periodBudget(remote, bundle.network);
  const marking = summarizeDirectMarking(markingResponse, now);
  const blockers = [];
  if (!(
    remote.State === "SUSPENDED" ||
    (remote.State === "OFF" && remote.Status === "DRAFT")
  ))
    blockers.push("campaign_not_held");
  if (
    !campaignTypeMatchesPlan(remote.Type, bundle.network) ||
    remote.Currency !== "RUB" ||
    !strategyMatchesPlan(budget.strategy, bundle.network) ||
    budget.limitKopecks !== bundle.plan.budget ||
    budget.period?.StartDate !== bundle.plan.periodStart ||
    budget.period?.EndDate !== bundle.plan.periodEnd ||
    budget.period?.AutoContinue !== "NO"
  )
    blockers.push("budget_drift");
  if (
    bundle.network &&
    groups.some(
      (group) =>
        String(group.CampaignId) !== String(bundle.campaignId) ||
        group.Type !== "UNIFIED_AD_GROUP",
    )
  )
    blockers.push("group_contract_changed");
  if (bundle.plan.periodEnd < moscowDate(now)) blockers.push("period_ended");
  try {
    if (
      !bundle.business.state.website ||
      new URL(bundle.business.state.website).hostname !==
        new URL(bundle.plan.website).hostname
    )
      blockers.push("website_changed");
  } catch {
    blockers.push("website_changed");
  }
  if (!marking.basicFieldsPresent) blockers.push("advertiser_data_incomplete");
  if (
    ads.some(
      (ad) =>
        ad.Status !== "DRAFT" ||
        String(ad.CampaignId) !== String(bundle.campaignId) ||
        !bundle.groupIds.some((id) => String(id) === String(ad.AdGroupId)),
    )
  )
    blockers.push("ads_not_draft");
  if (
    ads.some((ad) => {
      const planned = bundle.expectedAds.find(
        (item) => String(item.adId) === String(ad.Id),
      );
      const titles =
        ad.ResponsiveAd?.Titles?.map((item) => item.Title) ||
        (ad.TextAd ? [ad.TextAd.Title] : []);
      const texts =
        ad.ResponsiveAd?.Texts?.map((item) => item.Text) ||
        (ad.TextAd ? [ad.TextAd.Text] : []);
      const href = ad.ResponsiveAd?.Href || ad.TextAd?.Href;
      const expectedTitles =
        planned?.titles ||
        (planned
          ? [planned.title, planned.title.replace(/\s*·\s*/g, ", ")]
          : []);
      const expectedTexts = planned?.texts || (planned ? [planned.text] : []);
      const expectedHashes = planned?.adImageHashes || [];
      const remoteHashes = responsiveImageHashes(ad);
      return (
        !planned ||
        !expectedTitles.every((title) => titles.includes(title)) ||
        !expectedTexts.every((text) => texts.includes(text)) ||
        !expectedHashes.every((hash) => remoteHashes.includes(hash)) ||
        href !== planned.href
      );
    })
  )
    blockers.push("ad_content_changed");
  if (
    bundle.keywordIds.length &&
    keywords.some(
      (item) =>
        String(item.CampaignId) !== String(bundle.campaignId) ||
        !bundle.groupIds.some((id) => String(id) === String(item.AdGroupId)),
    )
  )
    blockers.push("keywords_mismatch");
  if (
    await db
      .prepare(
        `SELECT 1 AS found FROM direct_moderation_actions WHERE business_id=? AND campaign_id=? AND status IN ${activeStatuses} LIMIT 1`,
      )
      .get(businessId, bundle.campaignId)
  )
    blockers.push("previous_action_unresolved");
  if (await hasOtherAction(db, businessId, bundle.campaignId))
    blockers.push("campaign_action_unresolved");
  return {
    changeId,
    campaignId: bundle.campaignId,
    adIds: bundle.adIds,
    checkedAt: new Date(now).toISOString(),
    status: blockers.length ? "blocked" : "technical_ready",
    blockers,
    marking: {
      basicFieldsPresent: marking.basicFieldsPresent,
      findings: marking.findings,
    },
    campaignHeld: ["SUSPENDED", "OFF"].includes(remote.State),
    externalWrites: 0,
  };
}

async function beginModeration(
  db,
  userId,
  businessId,
  changeId,
  requestKey,
  currentConnectionId,
  now,
) {
  return db.transaction(async (tx) => {
    const bundle = await campaignBundle(
      tx,
      userId,
      businessId,
      changeId,
      currentConnectionId,
    );
    const previous = await tx
      .prepare(
        "SELECT * FROM direct_moderation_actions WHERE business_id=? AND idempotency_key=?",
      )
      .get(businessId, requestKey);
    if (previous) {
      if (previous.change_id !== changeId)
        throw new AppError(409, "Ключ уже использован для другой кампании.");
      return { action: actionView(previous), created: false };
    }
    const active = await tx
      .prepare(
        `SELECT 1 AS found FROM direct_moderation_actions WHERE business_id=? AND campaign_id=? AND status IN ${activeStatuses} LIMIT 1`,
      )
      .get(businessId, bundle.campaignId);
    if (active)
      throw new AppError(409, "Предыдущее действие модерации требует сверки.");
    if (await hasOtherAction(tx, businessId, bundle.campaignId))
      throw new AppError(409, "Другое действие с кампанией требует сверки.");
    const id = randomUUID();
    const at = new Date(now).toISOString();
    await tx
      .prepare(
        `INSERT INTO direct_moderation_actions
         (id,business_id,change_id,connection_id,campaign_id,idempotency_key,ad_ids_json,status,created_at,updated_at)
         VALUES(?,?,?,?,?,?,?,'checking',?,?)`,
      )
      .run(
        id,
        businessId,
        changeId,
        currentConnectionId,
        bundle.campaignId,
        requestKey,
        JSON.stringify(bundle.adIds),
        at,
        at,
      );
    return {
      action: actionView(await actionRow(tx, businessId, id)),
      created: true,
    };
  });
}

async function transitionModeration(
  db,
  userId,
  businessId,
  actionId,
  expected,
  status,
  writeAttempted,
  errorCode = null,
) {
  return db.transaction(async (tx) => {
    await ownedBusiness(tx, userId, businessId);
    const current = await actionRow(tx, businessId, actionId);
    if (current.connection_id !== (await connectedId(tx, businessId)))
      throw new AppError(409, "Кабинет изменился во время модерации.");
    if (current.status !== expected)
      throw new AppError(409, "Состояние модерации изменилось.");
    const at = new Date().toISOString();
    await tx
      .prepare(
        "UPDATE direct_moderation_actions SET status=?,write_attempted=?,error_code=?,updated_at=? WHERE id=?",
      )
      .run(
        status,
        writeAttempted || current.write_attempted ? 1 : 0,
        errorCode,
        at,
        actionId,
      );
    const lifecycleStatus =
      status === "succeeded"
        ? "moderation"
        : status === "needs_reconciliation"
          ? "needs_reconciliation"
          : "paused";
    await tx
      .prepare(
        "UPDATE campaign_ad_lifecycle SET status=?,reason=?,updated_at=? WHERE business_id=? AND change_id=?",
      )
      .run(
        lifecycleStatus,
        status === "succeeded"
          ? "Объявления отправлены на модерацию. Показы ещё не запущены."
          : status === "needs_reconciliation"
            ? "Результат отправки нужно сверить чтением Директа. Повтор запрещён."
            : "Команда модерации не отправлялась. Черновик остаётся выключенным.",
        at,
        businessId,
        current.change_id,
      );
    if (["succeeded", "needs_reconciliation"].includes(status))
      await addEvent(tx, businessId, {
        kind:
          status === "succeeded"
            ? "direct_ads_moderation_submitted"
            : "direct_ads_moderation_uncertain",
        title:
          status === "succeeded"
            ? "Объявления отправлены на модерацию"
            : "Нужна сверка модерации",
        reason:
          status === "succeeded"
            ? `Яндекс принял ${JSON.parse(current.ad_ids_json).length} объявлений. Показы не запускались.`
            : "Ответ Яндекса не подтверждён. Повторная отправка заблокирована.",
        rule: "direct/moderation@1",
        jobId: actionId,
      });
    return actionView(await actionRow(tx, businessId, actionId));
  });
}

function adsSubmitted(adIds, response) {
  return (
    sameIds(adIds, response?.Ads) &&
    response.Ads.every((ad) =>
      ["MODERATION", "PREACCEPTED", "ACCEPTED", "REJECTED"].includes(ad.Status),
    )
  );
}

function moderationFailureCode(error, fallback) {
  const itemCode = Number(error?.itemErrors?.[0]?.code);
  if (Number.isSafeInteger(itemCode) && itemCode > 0)
    return `direct_item_${itemCode}`;
  const providerCode = Number(error?.providerCode);
  if (Number.isSafeInteger(providerCode) && providerCode > 0)
    return `direct_${providerCode}`;
  if (
    typeof error?.code === "string" &&
    /^[a-z][a-z0-9_]{0,63}$/.test(error.code) &&
    error.code !== "provider_error"
  )
    return error.code;
  return fallback;
}

export async function submitPostgresModeration(
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
    throw new AppError(400, "Подтвердите рекламодателя и содержание страницы.");
  if (!/^[0-9a-f-]{36}$/i.test(requestKey))
    throw new AppError(400, "Некорректный ключ запроса.");
  const { action, created } = await beginModeration(
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
    const readiness = await inspectPostgresModerationReadiness(
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
    await transitionModeration(
      db,
      userId,
      businessId,
      action.id,
      "checking",
      "sending",
      true,
    );
    sending = true;
    const response = await client.moderateAds(action.adIds);
    if (
      !sameIds(action.adIds, response?.ModerateResults) ||
      response.ModerateResults.some((item) => item.Errors?.length)
    )
      throw new AppError(502, "Яндекс не подтвердил отправку всех объявлений.");
    const after = await client.adsByIds(action.adIds);
    if (!adsSubmitted(action.adIds, after))
      throw new AppError(
        502,
        "Статус объявлений после отправки не подтверждён.",
      );
    return transitionModeration(
      db,
      userId,
      businessId,
      action.id,
      "sending",
      "succeeded",
      true,
    );
  } catch (error) {
    if (!sending)
      return transitionModeration(
        db,
        userId,
        businessId,
        action.id,
        "checking",
        "failed_no_write",
        false,
        moderationFailureCode(error, "precheck_failed"),
      );
    try {
      if (adsSubmitted(action.adIds, await client.adsByIds(action.adIds)))
        return transitionModeration(
          db,
          userId,
          businessId,
          action.id,
          "sending",
          "succeeded",
          true,
        );
    } catch {
      // A lost provider response is reconciled by reading; the write is never replayed.
    }
    return transitionModeration(
      db,
      userId,
      businessId,
      action.id,
      "sending",
      "needs_reconciliation",
      true,
      moderationFailureCode(error, "unknown_result"),
    );
  }
}

export async function inspectPostgresModerationAction(
  db,
  userId,
  businessId,
  changeId,
  actionId,
  client,
) {
  await ownedBusiness(db, userId, businessId);
  const action = await actionRow(db, businessId, actionId);
  if (action.change_id !== changeId)
    throw new AppError(404, "Действие модерации не найдено.");
  if (action.connection_id !== (await connectedId(db, businessId)))
    throw new AppError(409, "Кабинет изменился после отправки.");
  if (action.status !== "needs_reconciliation")
    throw new AppError(409, "Для этого действия сверка не нужна.");
  const adIds = JSON.parse(action.ad_ids_json);
  if (adsSubmitted(adIds, await client.adsByIds(adIds)))
    return transitionModeration(
      db,
      userId,
      businessId,
      actionId,
      "needs_reconciliation",
      "succeeded",
      true,
    );
  return actionView(action);
}

export async function markInterruptedPostgresModerationActions(
  db,
  now = Date.now(),
) {
  return db.transaction(async (tx) => {
    const at = new Date(now).toISOString();
    const checking = await tx
      .prepare(
        "UPDATE direct_moderation_actions SET status='failed_no_write',error_code='process_interrupted_before_write',updated_at=? WHERE status='checking'",
      )
      .run(at);
    const sending = await tx
      .prepare(
        "UPDATE direct_moderation_actions SET status='needs_reconciliation',error_code='process_interrupted',updated_at=? WHERE status='sending'",
      )
      .run(at);
    return checking.changes + sending.changes;
  });
}
