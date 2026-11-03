import { randomUUID } from "node:crypto";
import { AppError, event, requireBusiness, transaction } from "./db.js";
import { directExecution } from "./direct-execution.js";
import { latestDirectBudgetCheck } from "./direct-budget.js";

const active = "('checking','sending','needs_reconciliation')";

function view(row) {
  return {
    id: row.id,
    changeId: row.change_id,
    campaignId: row.campaign_id,
    status: row.status,
    checkId: row.check_id,
    previousLimitKopecks: row.previous_limit,
    requestedLimitKopecks: row.requested_limit,
    confirmedLimitKopecks: row.confirmed_limit,
    writeAttempted: !!row.write_attempted,
    errorCode: row.error_code,
    rollback: row.rollback_status
      ? {
          status: row.rollback_status,
          writeAttempted: !!row.rollback_write_attempted,
          confirmedLimitKopecks: row.rollback_confirmed_limit,
          errorCode: row.rollback_error,
          updatedAt: row.rollback_updated_at,
        }
      : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function beginRollback(
  db,
  userId,
  businessId,
  actionId,
  requestKey,
  connectionId,
  now,
) {
  return transaction(db, () => {
    requireBusiness(db, userId, businessId);
    const action = actionRow(db, businessId, actionId);
    if (action.connection_id !== connectionId || connectedId(db, businessId) !== connectionId)
      throw new AppError(409, "Подключение Директа изменилось.");
    if (action.rollback_key) {
      if (action.rollback_key !== requestKey)
        throw new AppError(409, "Откат уже начат другим запросом.");
      return { action: view(action), created: false };
    }
    if (
      action.status !== "succeeded" ||
      action.confirmed_limit !== action.requested_limit
    )
      throw new AppError(409, "Можно откатить только подтверждённое уменьшение лимита.");
    const planRow = db
      .prepare("SELECT plan_json FROM direct_changes WHERE id=? AND business_id=?")
      .get(action.change_id, businessId);
    const plan = planRow ? JSON.parse(planRow.plan_json) : null;
    if (!plan || plan.budget !== action.previous_limit)
      throw new AppError(409, "Исходный лимит больше не совпадает с бюджетом владельца.");
    const newer = db
      .prepare(
        `SELECT 1 FROM direct_budget_actions
         WHERE business_id=? AND campaign_id=? AND rowid>(SELECT rowid FROM direct_budget_actions WHERE id=?)
           AND status='succeeded' LIMIT 1`,
      )
      .get(businessId, action.campaign_id, actionId);
    if (newer)
      throw new AppError(409, "После этого уменьшения лимит уже менялся.");
    assertNoOtherAction(db, businessId, action.campaign_id);
    if (
      db
        .prepare(
          `SELECT 1 FROM direct_budget_actions WHERE business_id=? AND campaign_id=?
           AND id<>? AND status IN ${active}`,
        )
        .get(businessId, action.campaign_id, actionId)
    )
      throw new AppError(409, "Другое изменение лимита требует сверки.");
    const at = new Date(now).toISOString();
    db.prepare(
      `UPDATE direct_budget_actions SET rollback_key=?,rollback_status='checking',
       rollback_updated_at=? WHERE id=?`,
    ).run(requestKey, at, actionId);
    return { action: view(actionRow(db, businessId, actionId)), created: true, plan };
  });
}

function transitionRollback(
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
    const action = actionRow(db, businessId, actionId);
    if (action.connection_id !== connectedId(db, businessId))
      throw new AppError(409, "Подключение изменилось во время отката.");
    if (action.rollback_status !== expected)
      throw new AppError(409, "Состояние отката изменилось.");
    const at = new Date().toISOString();
    db.prepare(
      `UPDATE direct_budget_actions SET rollback_status=?,
       rollback_write_attempted=?,rollback_confirmed_limit=?,rollback_error=?,
       rollback_updated_at=? WHERE id=?`,
    ).run(
      status,
      values.writeAttempted ? 1 : action.rollback_write_attempted,
      values.confirmedLimitKopecks ?? null,
      values.errorCode ?? null,
      at,
      actionId,
    );
    if (["succeeded", "not_applied", "needs_reconciliation"].includes(status))
      event(db, businessId, {
        kind:
          status === "succeeded"
            ? "direct_budget_reduction_rolled_back"
            : status === "needs_reconciliation"
              ? "direct_budget_rollback_uncertain"
              : "direct_budget_rollback_not_applied",
        title:
          status === "succeeded"
            ? "Исходный лимит восстановлен"
            : status === "needs_reconciliation"
              ? "Откат лимита требует сверки"
              : "Откат лимита не применился",
        reason: `Лимит возвращается с ${action.requested_limit} до ${action.previous_limit} коп.; подтверждено ${values.confirmedLimitKopecks ?? "неизвестно"} коп.`,
        rule: "direct/budget-rollback@1",
        jobId: actionId,
      });
    return view(actionRow(db, businessId, actionId));
  });
}

function connectedId(db, businessId) {
  const row = db
    .prepare(
      "SELECT metadata FROM connections WHERE business_id=? AND provider='yandex'",
    )
    .get(businessId);
  return row ? JSON.parse(row.metadata).connectionId : null;
}

function actionRow(db, businessId, id) {
  const row = db
    .prepare("SELECT * FROM direct_budget_actions WHERE business_id=? AND id=?")
    .get(businessId, id);
  if (!row) throw new AppError(404, "Изменение лимита не найдено.");
  return row;
}

function campaignIdFor(db, userId, businessId, changeId, connectionId) {
  requireBusiness(db, userId, businessId);
  const execution = directExecution(db, userId, businessId, changeId);
  if (execution.status !== "succeeded" || !execution.suspendVerified)
    throw new AppError(409, "Создание кампании ещё не подтверждено.");
  const saved = db
    .prepare(
      "SELECT connection_id FROM direct_executions WHERE business_id=? AND change_id=?",
    )
    .get(businessId, changeId);
  if (
    !saved ||
    saved.connection_id !== connectionId ||
    connectedId(db, businessId) !== connectionId
  )
    throw new AppError(409, "Подключение Директа изменилось.");
  const campaignId = execution.calls.find((call) => call.key === "campaign")
    ?.ids[0];
  if (!Number.isSafeInteger(campaignId) || campaignId <= 0)
    throw new AppError(409, "ID кампании не подтверждён.");
  return campaignId;
}

function assertNoOtherAction(db, businessId, campaignId) {
  for (const table of [
    "direct_lifecycle_actions",
    "direct_archive_actions",
    "direct_moderation_actions",
    "direct_resume_actions",
    "direct_ab_actions",
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

export function budgetActions(db, userId, businessId, changeId) {
  requireBusiness(db, userId, businessId);
  return db
    .prepare(
      "SELECT * FROM direct_budget_actions WHERE business_id=? AND change_id=? ORDER BY created_at DESC,rowid DESC LIMIT 10",
    )
    .all(businessId, changeId)
    .map(view);
}

function begin(
  db,
  userId,
  businessId,
  changeId,
  requestKey,
  connectionId,
  proposedLimitKopecks,
  now,
) {
  return transaction(db, () => {
    const campaignId = campaignIdFor(
      db,
      userId,
      businessId,
      changeId,
      connectionId,
    );
    const previous = db
      .prepare(
        "SELECT * FROM direct_budget_actions WHERE business_id=? AND idempotency_key=?",
      )
      .get(businessId, requestKey);
    if (previous) {
      if (
        previous.change_id !== changeId ||
        previous.requested_limit !== proposedLimitKopecks
      )
        throw new AppError(
          409,
          "Ключ уже использован для другого изменения лимита.",
        );
      return { action: view(previous), created: false };
    }
    const check = latestDirectBudgetCheck(db, userId, businessId, changeId);
    const checkedAt = check && Date.parse(check.checkedAt);
    if (
      !check ||
      check.status !== "matched" ||
      check.remote.limitKopecks !== check.plan.budgetKopecks ||
      !Number.isFinite(checkedAt) ||
      now < checkedAt ||
      now - checkedAt > 10 * 60_000
    )
      throw new AppError(
        409,
        "Проверка лимита устарела или обнаружила расхождение.",
      );
    if (
      !Number.isSafeInteger(proposedLimitKopecks) ||
      proposedLimitKopecks <= 0 ||
      proposedLimitKopecks >= check.remote.limitKopecks
    )
      throw new AppError(400, "Разрешено только уменьшение текущего лимита.");
    const beforeStart =
      new Intl.DateTimeFormat("sv-SE", {
        timeZone: "Europe/Moscow",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).format(new Date(now)) < check.plan.periodStart;
    if (
      !beforeStart &&
      (!check.report ||
        !check.report.coversPeriodToDate ||
        check.report.reportedSpentKopecks > proposedLimitKopecks)
    )
      throw new AppError(
        409,
        "Нужен свежий отчёт, покрывающий период и подтверждающий расход ниже нового лимита.",
      );
    if (!new Set(["OFF", "SUSPENDED"]).has(check.remote.state))
      throw new AppError(409, "Сначала остановите кампанию.");
    assertNoOtherAction(db, businessId, campaignId);
    if (
      db
        .prepare(
          `SELECT 1 FROM direct_budget_actions WHERE business_id=? AND campaign_id=? AND status IN ${active}`,
        )
        .get(businessId, campaignId)
    )
      throw new AppError(409, "Предыдущее изменение лимита требует сверки.");
    const id = randomUUID();
    const at = new Date(now).toISOString();
    db.prepare(
      `INSERT INTO direct_budget_actions(
      id,business_id,change_id,connection_id,campaign_id,idempotency_key,check_id,
      previous_limit,requested_limit,status,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,'checking',?,?)`,
    ).run(
      id,
      businessId,
      changeId,
      connectionId,
      campaignId,
      requestKey,
      check.id,
      check.remote.limitKopecks,
      proposedLimitKopecks,
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
      `UPDATE direct_budget_actions SET status=?,write_attempted=?,confirmed_limit=?,
      error_code=?,updated_at=? WHERE id=?`,
    ).run(
      status,
      values.writeAttempted ? 1 : row.write_attempted,
      values.confirmedLimitKopecks ?? null,
      values.errorCode ?? null,
      new Date().toISOString(),
      actionId,
    );
    if (["succeeded", "not_applied", "needs_reconciliation"].includes(status))
      event(db, businessId, {
        kind:
          status === "succeeded"
            ? "direct_budget_reduced"
            : "direct_budget_change_uncertain",
        title:
          status === "succeeded"
            ? "Лимит кампании уменьшен"
            : status === "not_applied"
              ? "Изменение лимита не применилось"
              : "Изменение лимита требует сверки",
        reason: `Кампания ${row.campaign_id}: ${row.previous_limit} → ${row.requested_limit} коп.; подтверждено ${values.confirmedLimitKopecks ?? "неизвестно"} коп.`,
        rule: "direct/budget-decrease@1",
        jobId: actionId,
      });
    return view(actionRow(db, businessId, actionId));
  });
}

function parseRemoteBudget(response, campaignId) {
  if (
    !Array.isArray(response?.Campaigns) ||
    response.Campaigns.length !== 1 ||
    response.Campaigns[0].Id !== campaignId
  )
    throw new AppError(502, "Не удалось прочитать лимит кампании.");
  const campaign = response.Campaigns[0];
  const strategy = campaign.TextCampaign?.BiddingStrategy;
  const period = strategy?.Search?.WbMaximumClicks?.CustomPeriodBudget;
  const micros = period?.SpendLimit;
  if (
    campaign.Type !== "TEXT_CAMPAIGN" ||
    strategy?.Search?.BiddingStrategyType !== "WB_MAXIMUM_CLICKS" ||
    strategy?.Network?.BiddingStrategyType !== "SERVING_OFF" ||
    !Number.isSafeInteger(micros) ||
    micros <= 0 ||
    micros % 10_000 !== 0
  )
    throw new AppError(409, "Стратегия или лимит кампании изменились.");
  return {
    state: campaign.State,
    status: campaign.Status,
    limitKopecks: micros / 10_000,
    periodStart: period.StartDate,
    periodEnd: period.EndDate,
    autoContinue: period.AutoContinue,
  };
}

async function remoteBudget(client, campaignId) {
  return parseRemoteBudget(
    await client.campaignBudgetById(campaignId),
    campaignId,
  );
}

export async function reduceVerifiedBudget(
  db,
  userId,
  businessId,
  changeId,
  requestKey,
  client,
  connectionId,
  {
    enabled = false,
    proposedLimitKopecks,
    confirmCampaignId,
    confirmPreviousLimitKopecks,
    budgetConfirmed = false,
    now = Date.now(),
  } = {},
) {
  if (!enabled)
    throw new AppError(
      409,
      "Изменение лимита отключено на сервере.",
      "live_gate",
    );
  if (!/^[0-9a-f-]{36}$/i.test(requestKey))
    throw new AppError(400, "Некорректный ключ запроса.");
  const { action, created } = begin(
    db,
    userId,
    businessId,
    changeId,
    requestKey,
    connectionId,
    proposedLimitKopecks,
    now,
  );
  if (!created) return action;
  if (
    !budgetConfirmed ||
    confirmCampaignId !== action.campaignId ||
    confirmPreviousLimitKopecks !== action.previousLimitKopecks
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
    const before = await remoteBudget(client, action.campaignId);
    if (
      before.limitKopecks !== action.previousLimitKopecks ||
      !["OFF", "SUSPENDED"].includes(before.state) ||
      before.autoContinue !== "NO"
    )
      throw new AppError(409, "Кампания изменилась после проверки лимита.");
    const check = latestDirectBudgetCheck(db, userId, businessId, changeId);
    if (
      before.periodStart !== check.plan.periodStart ||
      before.periodEnd !== check.plan.periodEnd
    )
      throw new AppError(409, "Период кампании изменился.");
    transition(db, userId, businessId, action.id, "checking", "sending", {
      writeAttempted: true,
    });
    sending = true;
    const response = await client.updateTextCampaignPeriodBudget(
      action.campaignId,
      {
        spendLimitKopecks: action.requestedLimitKopecks,
        startDate: before.periodStart,
        endDate: before.periodEnd,
      },
    );
    if (
      !Array.isArray(response?.UpdateResults) ||
      response.UpdateResults.length !== 1 ||
      response.UpdateResults[0].Id !== action.campaignId ||
      response.UpdateResults[0].Errors?.length
    )
      throw new AppError(502, "Директ не подтвердил изменение лимита.");
    const after = await remoteBudget(client, action.campaignId);
    if (
      after.limitKopecks !== action.requestedLimitKopecks ||
      after.periodStart !== before.periodStart ||
      after.periodEnd !== before.periodEnd ||
      after.autoContinue !== "NO" ||
      !["OFF", "SUSPENDED"].includes(after.state)
    )
      throw new AppError(502, "Новый лимит не подтверждён чтением Директа.");
    return transition(
      db,
      userId,
      businessId,
      action.id,
      "sending",
      "succeeded",
      {
        writeAttempted: true,
        confirmedLimitKopecks: after.limitKopecks,
      },
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
      const confirmed = await remoteBudget(client, action.campaignId);
      if (confirmed.limitKopecks === action.requestedLimitKopecks)
        return transition(
          db,
          userId,
          businessId,
          action.id,
          "sending",
          "succeeded",
          {
            writeAttempted: true,
            confirmedLimitKopecks: confirmed.limitKopecks,
          },
        );
      if (confirmed.limitKopecks === action.previousLimitKopecks)
        return transition(
          db,
          userId,
          businessId,
          action.id,
          "sending",
          "not_applied",
          {
            writeAttempted: true,
            confirmedLimitKopecks: confirmed.limitKopecks,
            errorCode: "write_not_applied",
          },
        );
    } catch {
      // The result remains uncertain; never replay the update automatically.
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

export async function inspectBudgetAction(
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
    throw new AppError(404, "Изменение лимита не найдено.");
  if (row.connection_id !== connectedId(db, businessId))
    throw new AppError(409, "Подключение изменилось после операции.");
  if (row.status !== "needs_reconciliation")
    throw new AppError(409, "Для этой операции сверка не нужна.");
  const confirmed = await remoteBudget(client, row.campaign_id);
  if (confirmed.limitKopecks === row.requested_limit)
    return transition(
      db,
      userId,
      businessId,
      actionId,
      "needs_reconciliation",
      "succeeded",
      {
        writeAttempted: true,
        confirmedLimitKopecks: confirmed.limitKopecks,
      },
    );
  if (confirmed.limitKopecks === row.previous_limit)
    return transition(
      db,
      userId,
      businessId,
      actionId,
      "needs_reconciliation",
      "not_applied",
      {
        writeAttempted: true,
        confirmedLimitKopecks: confirmed.limitKopecks,
        errorCode: "write_not_applied",
      },
    );
  return view(row);
}

export async function rollbackReducedBudget(
  db,
  userId,
  businessId,
  actionId,
  requestKey,
  client,
  connectionId,
  {
    enabled = false,
    spendConfirmed = false,
    confirmCurrentLimitKopecks,
    confirmRestoredLimitKopecks,
    now = Date.now(),
  } = {},
) {
  if (!enabled)
    throw new AppError(409, "Откат лимита отключён на сервере.", "live_gate");
  if (!/^[0-9a-f-]{36}$/i.test(requestKey))
    throw new AppError(400, "Некорректный ключ запроса.");
  const started = beginRollback(
    db,
    userId,
    businessId,
    actionId,
    requestKey,
    connectionId,
    now,
  );
  if (!started.created) return started.action;
  const action = started.action;
  if (
    !spendConfirmed ||
    confirmCurrentLimitKopecks !== action.requestedLimitKopecks ||
    confirmRestoredLimitKopecks !== action.previousLimitKopecks
  )
    return transitionRollback(
      db,
      userId,
      businessId,
      actionId,
      "checking",
      "failed_no_write",
      { errorCode: "confirmation_mismatch" },
    );
  let sending = false;
  try {
    const before = await remoteBudget(client, action.campaignId);
    if (
      before.limitKopecks !== action.requestedLimitKopecks ||
      !["OFF", "SUSPENDED"].includes(before.state) ||
      before.autoContinue !== "NO" ||
      before.periodStart !== started.plan.periodStart ||
      before.periodEnd !== started.plan.periodEnd
    )
      throw new AppError(409, "Кампания изменилась после уменьшения лимита.");
    transitionRollback(
      db,
      userId,
      businessId,
      actionId,
      "checking",
      "sending",
      { writeAttempted: true },
    );
    sending = true;
    const response = await client.updateTextCampaignPeriodBudget(
      action.campaignId,
      {
        spendLimitKopecks: action.previousLimitKopecks,
        startDate: before.periodStart,
        endDate: before.periodEnd,
      },
    );
    if (
      !Array.isArray(response?.UpdateResults) ||
      response.UpdateResults.length !== 1 ||
      response.UpdateResults[0].Id !== action.campaignId ||
      response.UpdateResults[0].Errors?.length
    )
      throw new AppError(502, "Директ не подтвердил восстановление лимита.");
    const after = await remoteBudget(client, action.campaignId);
    if (
      after.limitKopecks !== action.previousLimitKopecks ||
      after.periodStart !== before.periodStart ||
      after.periodEnd !== before.periodEnd ||
      after.autoContinue !== "NO" ||
      !["OFF", "SUSPENDED"].includes(after.state)
    )
      throw new AppError(502, "Исходный лимит не подтверждён чтением Direct.");
    return transitionRollback(
      db,
      userId,
      businessId,
      actionId,
      "sending",
      "succeeded",
      {
        writeAttempted: true,
        confirmedLimitKopecks: after.limitKopecks,
      },
    );
  } catch {
    if (!sending)
      return transitionRollback(
        db,
        userId,
        businessId,
        actionId,
        "checking",
        "failed_no_write",
        { errorCode: "precheck_failed" },
      );
    try {
      const confirmed = await remoteBudget(client, action.campaignId);
      if (confirmed.limitKopecks === action.previousLimitKopecks)
        return transitionRollback(
          db,
          userId,
          businessId,
          actionId,
          "sending",
          "succeeded",
          {
            writeAttempted: true,
            confirmedLimitKopecks: confirmed.limitKopecks,
          },
        );
      if (confirmed.limitKopecks === action.requestedLimitKopecks)
        return transitionRollback(
          db,
          userId,
          businessId,
          actionId,
          "sending",
          "not_applied",
          {
            writeAttempted: true,
            confirmedLimitKopecks: confirmed.limitKopecks,
            errorCode: "write_not_applied",
          },
        );
    } catch {
      /* Unknown result is never replayed automatically. */
    }
    return transitionRollback(
      db,
      userId,
      businessId,
      actionId,
      "sending",
      "needs_reconciliation",
      { writeAttempted: true, errorCode: "unknown_result" },
    );
  }
}

export async function inspectBudgetRollback(
  db,
  userId,
  businessId,
  actionId,
  client,
) {
  requireBusiness(db, userId, businessId);
  const action = actionRow(db, businessId, actionId);
  if (action.connection_id !== connectedId(db, businessId))
    throw new AppError(409, "Подключение изменилось после отката.");
  if (action.rollback_status !== "needs_reconciliation")
    throw new AppError(409, "Для этого отката сверка не нужна.");
  const confirmed = await remoteBudget(client, action.campaign_id);
  if (confirmed.limitKopecks === action.previous_limit)
    return transitionRollback(
      db,
      userId,
      businessId,
      actionId,
      "needs_reconciliation",
      "succeeded",
      { writeAttempted: true, confirmedLimitKopecks: confirmed.limitKopecks },
    );
  if (confirmed.limitKopecks === action.requested_limit)
    return transitionRollback(
      db,
      userId,
      businessId,
      actionId,
      "needs_reconciliation",
      "not_applied",
      {
        writeAttempted: true,
        confirmedLimitKopecks: confirmed.limitKopecks,
        errorCode: "write_not_applied",
      },
    );
  return view(action);
}

export function markInterruptedBudgetActions(db, now = Date.now()) {
  return transaction(db, () => {
    const at = new Date(now).toISOString();
    const checking = db
      .prepare(
        "UPDATE direct_budget_actions SET status='failed_no_write',error_code='process_interrupted_before_write',updated_at=? WHERE status='checking'",
      )
      .run(at);
    const sending = db
      .prepare(
        "UPDATE direct_budget_actions SET status='needs_reconciliation',error_code='process_interrupted',updated_at=? WHERE status='sending'",
      )
      .run(at);
    const rollbackChecking = db
      .prepare(
        "UPDATE direct_budget_actions SET rollback_status='failed_no_write',rollback_error='process_interrupted_before_write',rollback_updated_at=? WHERE rollback_status='checking'",
      )
      .run(at);
    const rollbackSending = db
      .prepare(
        "UPDATE direct_budget_actions SET rollback_status='needs_reconciliation',rollback_error='process_interrupted',rollback_updated_at=? WHERE rollback_status='sending'",
      )
      .run(at);
    return (
      checking.changes +
      sending.changes +
      rollbackChecking.changes +
      rollbackSending.changes
    );
  });
}
