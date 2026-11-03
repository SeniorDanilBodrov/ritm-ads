import { randomUUID } from "node:crypto";
import { AppError, event, requireBusiness, transaction } from "./db.js";
import { directChangeForPreflight } from "./direct.js";
import { directExecution } from "./direct-execution.js";
import { inspectDirectBudget } from "./direct-budget.js";
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
const matching = (items, ids) =>
  items.filter((item) => ids.some((id) => String(item.Id) === String(id)));

export function latestDirectControlReview(db, userId, businessId, changeId) {
  requireBusiness(db, userId, businessId);
  const row = db
    .prepare(
      `SELECT result_json FROM direct_control_reviews
    WHERE business_id=? AND change_id=? ORDER BY checked_at DESC,rowid DESC LIMIT 1`,
    )
    .get(businessId, changeId);
  return row ? JSON.parse(row.result_json) : null;
}

// Reads a real campaign and its exact objects. No resume, moderation or budget write.
export async function inspectDirectControl(
  db,
  userId,
  businessId,
  changeId,
  requestKey,
  client,
  connectionId,
  now = Date.now(),
) {
  if (!/^[0-9a-f-]{36}$/i.test(requestKey))
    throw new AppError(400, "Некорректный ключ запроса.");
  const { business, change } = directChangeForPreflight(
    db,
    userId,
    businessId,
    changeId,
  );
  const execution = directExecution(db, userId, businessId, changeId);
  if (execution.status !== "succeeded" || !execution.suspendVerified)
    throw new AppError(409, "Кампания не прошла сверку создания.");
  const stored = db
    .prepare("SELECT connection_id FROM direct_executions WHERE change_id=?")
    .get(changeId);
  if (
    stored.connection_id !== connectionId ||
    business.state.counterId !== change.plan.counterId ||
    business.state.goalId !== change.plan.goalId
  )
    throw new AppError(
      409,
      "Кабинет или аналитика изменились после создания кампании.",
    );
  const previous = db
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
  const ids = Object.fromEntries(
    execution.calls.map((call) => [call.key, call.ids]),
  );
  const variant = directAbVariantForChange(db, businessId, changeId);
  if (variant) ids.ads = [...ids.ads, variant.adId];
  const campaignId = ids.campaign?.[0];
  if (
    !Number.isSafeInteger(campaignId) ||
    campaignId <= 0 ||
    !ids.adgroup?.length ||
    !ids.ads?.length ||
    !ids.keywords?.length
  )
    throw new AppError(409, "Не все внешние ID кампании подтверждены.");
  const [budget, groupsResult, adsResult, keywordsResult] = await Promise.all([
    inspectDirectBudget(
      db,
      userId,
      businessId,
      changeId,
      client,
      connectionId,
      now,
    ),
    client.adGroupsByIds(ids.adgroup),
    client.adsByIds(ids.ads),
    client.keywordsByIds(ids.keywords),
  ]);
  const groups = groupsResult?.AdGroups;
  const ads = adsResult?.Ads;
  const keywords = keywordsResult?.Keywords;
  if (
    !sameIds(ids.adgroup, groups) ||
    !sameIds(ids.ads, ads) ||
    !sameIds(ids.keywords, keywords)
  )
    throw new AppError(502, "Директ не вернул полный состав кампании.");
  const date = moscowDate(now);
  const blockers = [];
  if (date < change.plan.periodStart) blockers.push("period_not_started");
  if (date > change.plan.periodEnd) blockers.push("period_ended");
  if (
    !business.state.website ||
    new URL(business.state.website).hostname !==
      new URL(change.plan.website).hostname
  )
    blockers.push("website_changed");
  if (budget.status !== "matched") blockers.push("budget_drift");
  if (budget.remote.state !== "SUSPENDED")
    blockers.push("campaign_not_suspended");
  if (["MODERATION", "PREACCEPTED"].includes(budget.remote.status))
    blockers.push("campaign_under_review");
  else if (budget.remote.status !== "ACCEPTED")
    blockers.push("campaign_not_accepted");
  if (budget.remote.statusPayment !== "ALLOWED")
    blockers.push("payment_not_confirmed");
  const reportReceivedAt = Date.parse(budget.report?.receivedAt);
  const verifiedSpend =
    !!budget.report?.coversPeriodToDate &&
    Number.isFinite(reportReceivedAt) &&
    reportReceivedAt <= now &&
    now - reportReceivedAt <= 48 * 3600000;
  if (!verifiedSpend) blockers.push("spend_not_verified");
  if (verifiedSpend && budget.report.reportedSpentKopecks >= change.plan.budget)
    blockers.push("budget_exhausted");
  if (
    matching(groups, ids.adgroup).some(
      (item) => String(item.CampaignId) !== String(campaignId),
    )
  )
    blockers.push("group_mismatch");
  const matchingAds = matching(ads, ids.ads);
  if (
    matchingAds.some((ad) => ["MODERATION", "PREACCEPTED"].includes(ad.Status))
  )
    blockers.push("ads_under_review");
  else if (
    matchingAds.some(
      (item) =>
        String(item.CampaignId) !== String(campaignId) ||
        !ids.adgroup.some((id) => String(id) === String(item.AdGroupId)) ||
        item.Status !== "ACCEPTED" ||
        ["SUSPENDED", "OFF_BY_MONITORING", "ARCHIVED"].includes(item.State),
    )
  )
    blockers.push("ads_not_ready");
  if (
    matchingAds.some((ad) => {
      const originalIndex = execution.calls
        .find((call) => call.key === "ads")
        .ids.findIndex((id) => String(id) === String(ad.Id));
      const planned =
        originalIndex >= 0 ? change.plan.ads[originalIndex] : variant;
      const titles =
        ad.ResponsiveAd?.Titles?.map((item) => item.Title) ||
        (ad.TextAd ? [ad.TextAd.Title] : []);
      const texts =
        ad.ResponsiveAd?.Texts?.map((item) => item.Text) ||
        (ad.TextAd ? [ad.TextAd.Text] : []);
      const href = ad.ResponsiveAd?.Href || ad.TextAd?.Href;
      return (
        !planned ||
        !titles.includes(planned.title) ||
        !texts.includes(planned.text) ||
        href !== planned.href
      );
    })
  )
    blockers.push("ad_content_changed");
  if (
    matching(keywords, ids.keywords).some(
      (item) =>
        String(item.CampaignId) !== String(campaignId) ||
        !ids.adgroup.some((id) => String(id) === String(item.AdGroupId)) ||
        !["ON", "SUSPENDED"].includes(item.State) ||
        item.Status !== "ACCEPTED",
    )
  )
    blockers.push("keywords_not_ready");
  const result = {
    id: randomUUID(),
    changeId,
    campaignId,
    checkedAt: new Date(now).toISOString(),
    status: blockers.length ? "blocked" : "technical_ready",
    blockers,
    budget: {
      limitKopecks: budget.remote.limitKopecks,
      spentKopecks: verifiedSpend ? budget.report.reportedSpentKopecks : null,
      reportReceivedAt: budget.report?.receivedAt ?? null,
      reportDateTo: budget.report?.dateTo ?? null,
    },
    remote: {
      state: budget.remote.state,
      status: budget.remote.status,
      statusPayment: budget.remote.statusPayment,
      groups: groups.length,
      ads: ads.length,
      keywords: keywords.length,
    },
    manualChecks: [
      "Подтвердить данные реального рекламодателя и содержимое сайта.",
      "Проверить маркировку рекламы и решение модерации.",
      "Отдельно согласовать запуск показов и предел расходов.",
    ],
    safeToResume: false,
    externalWrites: 0,
  };
  return transaction(db, () => {
    const latest = requireBusiness(db, userId, businessId);
    const current = db
      .prepare(
        "SELECT metadata FROM connections WHERE business_id=? AND provider='yandex'",
      )
      .get(businessId);
    if (
      latest.version !== business.version ||
      JSON.parse(current?.metadata || "null")?.connectionId !== connectionId ||
      directExecution(db, userId, businessId, changeId).status !== "succeeded"
    )
      throw new AppError(
        409,
        "Кампания или подключение изменились во время проверки.",
      );
    const inserted = db
      .prepare(
        `INSERT OR IGNORE INTO direct_control_reviews
      (id,business_id,change_id,connection_id,request_key,checked_at,result_json)
      VALUES(?,?,?,?,?,?,?)`,
      )
      .run(
        result.id,
        businessId,
        changeId,
        connectionId,
        requestKey,
        result.checkedAt,
        JSON.stringify(result),
      );
    if (!inserted.changes) {
      const prior = db
        .prepare(
          `SELECT change_id,result_json FROM direct_control_reviews
        WHERE business_id=? AND request_key=?`,
        )
        .get(businessId, requestKey);
      if (prior?.change_id === changeId) return JSON.parse(prior.result_json);
      throw new AppError(409, "Ключ уже использован для другой кампании.");
    }
    event(db, businessId, {
      kind: "direct_control_review",
      title: blockers.length
        ? "Запуск кампании пока заблокирован"
        : "Техническая проверка кампании пройдена",
      reason: blockers.length
        ? `Кампания ${campaignId}: ${blockers.length} препятствий для запуска. Внешних записей не было.`
        : `Кампания ${campaignId}: технические условия выполнены; требуется отдельное решение владельца.`,
      rule: "direct/control-read@1",
      jobId: result.id,
    });
    return result;
  });
}
