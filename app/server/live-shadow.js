import { createHash, randomUUID } from "node:crypto";
import { AppError, event, requireBusiness, transaction } from "./db.js";
import { directChangeForPreflight } from "./direct.js";
import { directExecution } from "./direct-execution.js";

const signature = (value) => createHash("sha256").update(value).digest("hex");
const localDate = (now, timezone) =>
  new Intl.DateTimeFormat("sv-SE", {
    timeZone: timezone || "Europe/Moscow",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(now));
const daysBetween = (from, to) =>
  Math.round(
    (Date.parse(to + "T00:00:00Z") - Date.parse(from + "T00:00:00Z")) /
      86400000,
  );
const sum = (rows, field) => {
  const value = rows.reduce((total, row) => total + row[field], 0);
  if (!Number.isSafeInteger(value) || value < 0)
    throw new AppError(502, "Показатели отчёта вышли за допустимый диапазон.");
  return value;
};

export function latestLiveShadowReview(db, userId, businessId, changeId) {
  requireBusiness(db, userId, businessId);
  const row = db
    .prepare(
      "SELECT result_json FROM direct_shadow_reviews WHERE business_id=? AND change_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1",
    )
    .get(businessId, changeId);
  return row ? JSON.parse(row.result_json) : null;
}

// A site-wide Metrica goal is deliberately never treated as a campaign lead.
export async function runLiveShadowReview(
  db,
  userId,
  businessId,
  changeId,
  requestKey,
  { connectionId, metrica, direct, snapshotId = null },
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
  const campaignId = execution.calls[0]?.ids?.[0];
  const stored = db
    .prepare("SELECT connection_id FROM direct_executions WHERE change_id=?")
    .get(changeId);
  if (
    execution.status !== "succeeded" ||
    !Number.isSafeInteger(campaignId) ||
    stored.connection_id !== connectionId ||
    business.state.counterId !== change.plan.counterId ||
    business.state.goalId !== change.plan.goalId
  )
    throw new AppError(409, "Кампания, аналитика или подключение изменились.");
  const prior = db
    .prepare(
      "SELECT change_id,result_json FROM direct_shadow_reviews WHERE business_id=? AND request_key=?",
    )
    .get(businessId, requestKey);
  if (prior) {
    if (prior.change_id !== changeId)
      throw new AppError(409, "Ключ уже использован для другой кампании.");
    return JSON.parse(prior.result_json);
  }
  const checkedAt = new Date(now).toISOString();
  const today = localDate(now, business.state.timezone);
  const through = [today, change.plan.periodEnd].sort()[0];
  const report =
    change.plan.periodStart <= today
      ? db
          .prepare(
            `SELECT rs.* FROM report_snapshots rs JOIN jobs j ON j.id=rs.job_id
        WHERE rs.business_id=? AND rs.source='yandex' AND rs.login=?
        AND json_extract(j.payload,'$.signature')=?
        AND COALESCE(json_extract(j.payload,'$.reportType'),'campaign')='campaign'
        AND rs.date_from<=? AND rs.date_to>=? AND rs.date_to<=?
        AND (? IS NULL OR rs.id=?)
        ORDER BY rs.date_to DESC,rs.rowid DESC LIMIT 1`,
          )
          .get(
            businessId,
            change.plan.login,
            signature(connectionId),
            change.plan.periodStart,
            change.plan.periodStart,
            today,
            snapshotId,
            snapshotId,
          )
      : null;
  const dataThrough = report ? [through, report.date_to].sort()[0] : null;
  let status = "observed",
    blocker = null,
    metricaTotals = null,
    attributedMetricaTotals = null,
    directTotals = null,
    campaignState = null;
  if (change.plan.periodStart > today) {
    status = "insufficient";
    blocker = "period_not_started";
  } else if (!report) {
    status = "insufficient";
    blocker = "direct_report_missing";
  } else if (
    !Number.isFinite(Date.parse(report.received_at)) ||
    Date.parse(report.received_at) > now ||
    now - Date.parse(report.received_at) > 48 * 3600000 ||
    daysBetween(report.date_to, through) > 2
  ) {
    status = "insufficient";
    blocker = "direct_report_stale";
  } else {
    const rows = JSON.parse(report.rows_json).filter(
      (row) =>
        row.CampaignId === String(campaignId) &&
        row.Date >= change.plan.periodStart &&
        row.Date <= dataThrough,
    );
    directTotals = {
      spentKopecks: sum(rows, "spent"),
      clicks: sum(rows, "clicks"),
      impressions: sum(rows, "impressions"),
    };
    const [stats, attributedStats, campaign] = await Promise.all([
      metrica.statistics(
        change.plan.counterId,
        change.plan.goalId,
        change.plan.periodStart,
        dataThrough,
      ),
      typeof metrica.campaignStatistics === "function"
        ? metrica.campaignStatistics(
            change.plan.counterId,
            change.plan.goalId,
            campaignId,
            change.plan.periodStart,
            dataThrough,
          )
        : null,
      direct.campaignsByIds([campaignId]),
    ]);
    if (
      !Array.isArray(stats?.totals) ||
      stats.totals.length !== 2 ||
      stats.totals.some((value) => !Number.isSafeInteger(value) || value < 0) ||
      stats.sampled === true ||
      campaign.Campaigns?.length !== 1 ||
      campaign.Campaigns[0].Id !== campaignId
    )
      throw new AppError(
        502,
        "Источники не прошли проверку формата или полноты.",
      );
    if (
      attributedStats &&
      (!Array.isArray(attributedStats.totals) ||
        attributedStats.totals.length !== 2 ||
        attributedStats.totals.some(
          (value) => !Number.isSafeInteger(value) || value < 0,
        ) ||
        attributedStats.sampled === true)
    )
      throw new AppError(
        502,
        "Атрибуция Метрики не прошла проверку формата или полноты.",
      );
    metricaTotals = {
      visits: stats.totals[0],
      goalReaches: stats.totals[1],
      counterId: change.plan.counterId,
      goalId: change.plan.goalId,
    };
    if (attributedStats)
      attributedMetricaTotals = {
        visits: attributedStats.totals[0],
        goalReaches: attributedStats.totals[1],
        counterId: change.plan.counterId,
        goalId: change.plan.goalId,
        campaignId,
        attribution: "lastsign",
        filterDimension: "ym:s:lastsignDirectClickOrder",
      };
    campaignState = {
      state: campaign.Campaigns[0].State,
      status: campaign.Campaigns[0].Status,
    };
  }
  const result = {
    id: randomUUID(),
    changeId,
    campaignId,
    checkedAt,
    status,
    blocker,
    executed: false,
    requiresReview: true,
    action:
      status === "observed" &&
      attributedMetricaTotals &&
      directTotals.spentKopecks > 0
        ? "review_campaign_performance"
        : status === "observed" && directTotals.spentKopecks > 0
          ? "review_attribution"
          : "observe",
    reason:
      status === "observed"
        ? attributedMetricaTotals
          ? "Метрика отфильтрована по точному ID кампании и модели последнего значимого перехода. Решение всё равно требует ручной проверки."
          : "Метрика показывает достижения по всему сайту. Без атрибуции их нельзя считать результатом этой кампании."
        : blocker === "period_not_started"
          ? "Период кампании ещё не начался. Данных для решения нет."
          : blocker === "direct_report_missing"
            ? "Подходящий отчёт Директа ещё не сохранён."
            : "Отчёт Директа устарел; запросите свежий снимок.",
    source: {
      direct: report
        ? {
            snapshotId: report.id,
            dateFrom: report.date_from,
            dateTo: dataThrough,
            snapshotDateTo: report.date_to,
            receivedAt: report.received_at,
            ...directTotals,
          }
        : null,
      metrica: metricaTotals,
      attributedMetrica: attributedMetricaTotals,
      campaign: campaignState,
      attribution: attributedMetricaTotals
        ? "direct_campaign_last_significant"
        : "site_wide_only",
      campaignGoalReaches: attributedMetricaTotals?.goalReaches ?? null,
      campaignCpaKopecks:
        attributedMetricaTotals?.goalReaches > 0
          ? Math.round(
              directTotals.spentKopecks / attributedMetricaTotals.goalReaches,
            )
          : null,
    },
  };
  return transaction(db, () => {
    const latest = requireBusiness(db, userId, businessId);
    const connection = db
      .prepare(
        "SELECT metadata FROM connections WHERE business_id=? AND provider='yandex'",
      )
      .get(businessId);
    if (
      latest.version !== business.version ||
      JSON.parse(connection?.metadata || "null")?.connectionId !==
        connectionId ||
      directExecution(db, userId, businessId, changeId).status !== "succeeded"
    )
      throw new AppError(409, "Данные изменились во время анализа.");
    const inserted = db
      .prepare(
        `INSERT OR IGNORE INTO direct_shadow_reviews
      (id,business_id,change_id,connection_id,request_key,created_at,result_json)
      VALUES(?,?,?,?,?,?,?)`,
      )
      .run(
        result.id,
        businessId,
        changeId,
        connectionId,
        requestKey,
        checkedAt,
        JSON.stringify(result),
      );
    if (!inserted.changes) {
      const existing = db
        .prepare(
          "SELECT change_id,result_json FROM direct_shadow_reviews WHERE business_id=? AND request_key=?",
        )
        .get(businessId, requestKey);
      if (existing?.change_id === changeId)
        return JSON.parse(existing.result_json);
      throw new AppError(409, "Ключ уже использован для другой кампании.");
    }
    event(db, businessId, {
      kind: "direct_shadow_review",
      title:
        status === "observed"
          ? "Сводка реальных источников готова"
          : "Данных для решения пока недостаточно",
      reason: result.reason,
      rule: "direct/shadow-review@1",
      jobId: result.id,
    });
    return result;
  });
}
