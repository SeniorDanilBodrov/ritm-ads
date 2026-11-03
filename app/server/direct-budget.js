import { createHash, randomUUID } from "node:crypto";
import { AppError, event, requireBusiness, transaction } from "./db.js";
import { directExecution } from "./direct-execution.js";
import { heldCampaign } from "./direct.js";

const signature = (value) => createHash("sha256").update(value).digest("hex");
const moscowDate = (now) =>
  new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Europe/Moscow",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(now));

export function latestDirectBudgetCheck(db, userId, businessId, changeId) {
  requireBusiness(db, userId, businessId);
  const row = db
    .prepare(
      "SELECT result_json FROM direct_budget_checks WHERE business_id=? AND change_id=? ORDER BY checked_at DESC,rowid DESC LIMIT 1",
    )
    .get(businessId, changeId);
  return row ? JSON.parse(row.result_json) : null;
}

// A budget preview is read-only. Reports can lag behind live Direct spend, so
// even a clean preview must never authorize a write or a campaign resume.
export function previewDirectBudgetLimit(
  db,
  userId,
  businessId,
  changeId,
  proposedLimitKopecks,
  now = Date.now(),
) {
  if (!Number.isSafeInteger(proposedLimitKopecks) || proposedLimitKopecks <= 0)
    throw new AppError(400, "Укажите положительный лимит в копейках.");
  const check = latestDirectBudgetCheck(db, userId, businessId, changeId);
  if (!check)
    throw new AppError(409, "Сначала проверьте лимит кампании в Директе.");
  const ownerLimit = check.plan.budgetKopecks;
  const remoteLimit = check.remote.limitKopecks;
  const blockers = [];
  if (proposedLimitKopecks > ownerLimit)
    blockers.push("Выше исходного лимита, утверждённого владельцем.");
  if (check.status !== "matched" || remoteLimit !== ownerLimit)
    blockers.push(
      "Лимит или настройки Директа отличаются от утверждённого плана.",
    );
  if (
    now - Date.parse(check.checkedAt) > 10 * 60_000 ||
    now < Date.parse(check.checkedAt)
  )
    blockers.push("Проверка Директа старше 10 минут. Обновите её.");
  if (proposedLimitKopecks === remoteLimit)
    blockers.push("Предложенный лимит уже установлен.");
  if (check.report?.reportedSpentKopecks > proposedLimitKopecks)
    blockers.push("В сохранённом отчёте расход уже выше предложенного лимита.");
  const beforeStart =
    moscowDate(now) < check.plan.periodStart &&
    ["OFF", "SUSPENDED"].includes(check.remote.state);
  if (!check.report) {
    if (!beforeStart) blockers.push("Нет отчёта о расходе за кампанию.");
  } else if (!check.report.coversPeriodToDate && !beforeStart) {
    blockers.push("Сохранённый отчёт не покрывает период кампании до сегодня.");
  }
  return {
    mode: "read_only_preview",
    checkId: check.id,
    campaignId: check.campaignId,
    checkedAt: check.checkedAt,
    ownerLimitKopecks: ownerLimit,
    remoteLimitKopecks: remoteLimit,
    proposedLimitKopecks,
    knownReportedSpentKopecks:
      check.report?.reportedSpentKopecks ?? (beforeStart ? 0 : null),
    reportReceivedAt: check.report?.receivedAt ?? null,
    blockers,
    preliminaryChecksPassed: blockers.length === 0,
    canApply: false,
    externalWrites: 0,
    notice: beforeStart
      ? "Период ещё не начался, а кампания выключена. Предпросмотр не запускает показы и не меняет лимит."
      : "Отчёт о расходе может запаздывать. Расчёт не подтверждает доступный остаток и не разрешает изменение лимита или запуск показов.",
  };
}

function spendEvidence(
  db,
  businessId,
  login,
  connectionId,
  campaignId,
  plan,
  now,
) {
  const row = db
    .prepare(
      `SELECT rs.id,rs.date_from,rs.date_to,rs.received_at,rs.include_vat,rs.rows_json
    FROM report_snapshots rs JOIN jobs j ON j.id=rs.job_id
    WHERE rs.business_id=? AND rs.source='yandex' AND rs.login=?
      AND json_extract(j.payload,'$.signature')=?
      AND COALESCE(json_extract(j.payload,'$.reportType'),'campaign')='campaign'
    ORDER BY rs.rowid DESC LIMIT 1`,
    )
    .get(businessId, login, signature(connectionId));
  if (!row) return null;
  const rows = JSON.parse(row.rows_json);
  const spent = rows
    .filter(
      (item) =>
        item.CampaignId === String(campaignId) &&
        item.Date >= plan.periodStart &&
        item.Date <= plan.periodEnd,
    )
    .reduce((sum, item) => sum + item.spent, 0);
  if (!Number.isSafeInteger(spent) || spent < 0)
    throw new AppError(502, "Расход отчёта не прошёл проверку диапазона.");
  const through = [plan.periodEnd, moscowDate(now)].sort()[0];
  return {
    snapshotId: row.id,
    dateFrom: row.date_from,
    dateTo: row.date_to,
    receivedAt: row.received_at,
    includeVat: !!row.include_vat,
    reportedSpentKopecks: spent,
    coversPeriodToDate:
      plan.periodStart <= moscowDate(now) &&
      row.date_from <= plan.periodStart &&
      row.date_to >= through,
    // Direct Reports may arrive late and include VAT. This is evidence, not a live balance.
    safeForAutomaticLimitChange: false,
  };
}

export async function inspectDirectBudget(
  db,
  userId,
  businessId,
  changeId,
  client,
  connectionId,
  now = Date.now(),
) {
  requireBusiness(db, userId, businessId);
  const execution = directExecution(db, userId, businessId, changeId);
  if (execution.status !== "succeeded")
    throw new AppError(409, "Кампания ещё не прошла сверку создания.");
  const campaignId = execution.calls.find((item) => item.key === "campaign")
    ?.ids[0];
  if (!Number.isSafeInteger(campaignId) || campaignId <= 0)
    throw new AppError(409, "У кампании нет подтверждённого ID.");
  const saved = db
    .prepare(
      "SELECT de.connection_id,dc.plan_json FROM direct_executions de JOIN direct_changes dc ON dc.id=de.change_id WHERE de.change_id=? AND de.business_id=?",
    )
    .get(changeId, businessId);
  if (saved.connection_id !== connectionId)
    throw new AppError(409, "Кабинет изменился после создания кампании.");
  const plan = JSON.parse(saved.plan_json);
  const response = await client.campaignBudgetById(campaignId);
  if (
    !Array.isArray(response?.Campaigns) ||
    response.Campaigns.length !== 1 ||
    response.Campaigns[0].Id !== campaignId
  )
    throw new AppError(502, "Не удалось прочитать бюджет кампании в Директе.");
  const remote = response.Campaigns[0];
  const strategy =
    remote.UnifiedCampaign?.BiddingStrategy ||
    remote.TextCampaign?.BiddingStrategy;
  const period = strategy?.Search?.WbMaximumClicks?.CustomPeriodBudget;
  const limitMicros = period?.SpendLimit;
  const limitKopecks =
    Number.isSafeInteger(limitMicros) &&
    limitMicros >= 0 &&
    limitMicros % 10_000 === 0
      ? limitMicros / 10_000
      : null;
  const findings = [];
  if (!["TEXT_CAMPAIGN", "UNIFIED_CAMPAIGN"].includes(remote.Type))
    findings.push("campaign_type");
  if (remote.Currency !== "RUB") findings.push("currency");
  if (
    strategy?.Search?.BiddingStrategyType !== "WB_MAXIMUM_CLICKS" ||
    strategy?.Network?.BiddingStrategyType !== "SERVING_OFF"
  )
    findings.push("strategy_changed");
  if (limitKopecks === null) findings.push("limit_unreadable");
  else if (limitKopecks !== plan.budget)
    findings.push("limit_differs_from_plan");
  if (
    period?.StartDate !== plan.periodStart ||
    period?.EndDate !== plan.periodEnd
  )
    findings.push("period_changed");
  if (period?.AutoContinue !== "NO") findings.push("auto_continue_enabled");
  if (!heldCampaign(remote)) findings.push("campaign_not_held");
  const report = spendEvidence(
    db,
    businessId,
    plan.login,
    connectionId,
    campaignId,
    plan,
    now,
  );
  const result = {
    id: randomUUID(),
    changeId,
    campaignId,
    checkedAt: new Date(now).toISOString(),
    status: findings.length ? "drift" : "matched",
    findings,
    plan: {
      budgetKopecks: plan.budget,
      periodStart: plan.periodStart,
      periodEnd: plan.periodEnd,
    },
    remote: {
      name: remote.Name,
      state: remote.State,
      status: remote.Status,
      statusPayment: remote.StatusPayment ?? null,
      type: remote.Type,
      currency: remote.Currency,
      limitKopecks,
      periodStart: period?.StartDate || null,
      periodEnd: period?.EndDate || null,
      autoContinue: period?.AutoContinue || null,
    },
    report,
    // A current balance cannot be proven from a possibly delayed report alone.
    safeToResumeOrChangeLimit: false,
  };
  return transaction(db, () => {
    requireBusiness(db, userId, businessId);
    const current = db
      .prepare(
        "SELECT metadata FROM connections WHERE business_id=? AND provider='yandex'",
      )
      .get(businessId);
    if (
      !current ||
      JSON.parse(current.metadata).connectionId !== connectionId ||
      directExecution(db, userId, businessId, changeId).status !== "succeeded"
    )
      throw new AppError(
        409,
        "Подключение или исполнение изменилось во время проверки.",
      );
    db.prepare(
      `INSERT INTO direct_budget_checks
      (id,business_id,change_id,connection_id,campaign_id,checked_at,result_json)
      VALUES(?,?,?,?,?,?,?)`,
    ).run(
      result.id,
      businessId,
      changeId,
      connectionId,
      campaignId,
      result.checkedAt,
      JSON.stringify(result),
    );
    event(db, businessId, {
      kind: "direct_budget_checked",
      title: findings.length
        ? "Настройки бюджета отличаются от плана"
        : "Бюджет кампании проверен",
      reason: findings.length
        ? `Кампания ${campaignId}: требуется сверка ${findings.join(", ")}.`
        : `Кампания ${campaignId}: лимит и период совпадают с утверждённым планом.`,
      rule: "direct/budget-read@1",
      jobId: result.id,
    });
    return result;
  });
}
