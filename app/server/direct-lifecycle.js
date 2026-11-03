import { randomUUID } from "node:crypto";
import { AppError, event, requireBusiness, transaction } from "./db.js";
import { directExecution } from "./direct-execution.js";

function view(row) {
  return {
    id: row.id,
    changeId: row.change_id,
    campaignId: row.campaign_id,
    kind: row.kind,
    status: row.status,
    beforeState: row.before_state,
    afterState: row.after_state,
    writeAttempted: !!row.write_attempted,
    errorCode: row.error_code,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function row(db, businessId, id) {
  const found = db
    .prepare(
      "SELECT * FROM direct_lifecycle_actions WHERE business_id=? AND id=?",
    )
    .get(businessId, id);
  if (!found) throw new AppError(404, "Действие с кампанией не найдено.");
  return found;
}

function connectedId(db, businessId) {
  const connection = db
    .prepare(
      "SELECT metadata FROM connections WHERE business_id=? AND provider='yandex'",
    )
    .get(businessId);
  return connection ? JSON.parse(connection.metadata).connectionId : null;
}

function requireSameConnection(db, action) {
  if (connectedId(db, action.business_id) !== action.connection_id)
    throw new AppError(
      409,
      "Кабинет изменился. Действие с кампанией заблокировано.",
    );
}

function campaignFrom(result, id) {
  const campaigns = result?.Campaigns;
  if (
    !Array.isArray(campaigns) ||
    campaigns.length !== 1 ||
    campaigns[0].Id !== id
  )
    throw new AppError(
      502,
      "Кампания не найдена при сверке Директа.",
      "direct_readback",
    );
  return campaigns[0];
}

export function lifecycleAction(db, userId, businessId, actionId) {
  requireBusiness(db, userId, businessId);
  return view(row(db, businessId, actionId));
}

export function lifecycleActions(db, userId, businessId, changeId) {
  requireBusiness(db, userId, businessId);
  return db
    .prepare(
      "SELECT * FROM direct_lifecycle_actions WHERE business_id=? AND change_id=? ORDER BY created_at DESC,rowid DESC LIMIT 20",
    )
    .all(businessId, changeId)
    .map(view);
}

function beginSuspend(db, userId, businessId, changeId, idempotencyKey, now) {
  return transaction(db, () => {
    requireBusiness(db, userId, businessId);
    const execution = directExecution(db, userId, businessId, changeId);
    if (execution.status !== "succeeded" || !execution.suspendVerified)
      throw new AppError(409, "Кампания не прошла полную сверку создания.");
    const campaignId = execution.calls.find((item) => item.key === "campaign")
      ?.ids[0];
    if (!Number.isSafeInteger(campaignId) || campaignId <= 0)
      throw new AppError(409, "У кампании нет подтвержденного ID.");
    const previous = db
      .prepare(
        "SELECT * FROM direct_lifecycle_actions WHERE business_id=? AND idempotency_key=?",
      )
      .get(businessId, idempotencyKey);
    if (previous) {
      if (previous.change_id !== changeId || previous.kind !== "suspend")
        throw new AppError(
          409,
          "Этот ключ уже использован для другого действия.",
          "idempotency_conflict",
        );
      return { action: view(previous), created: false };
    }
    const connectionId = db
      .prepare("SELECT connection_id FROM direct_executions WHERE change_id=?")
      .get(changeId).connection_id;
    if (connectedId(db, businessId) !== connectionId)
      throw new AppError(409, "Кабинет изменился после создания кампании.");
    if (
      db
        .prepare(
          "SELECT 1 FROM direct_lifecycle_actions WHERE business_id=? AND campaign_id=? AND status IN ('checking','sending','needs_reconciliation')",
        )
        .get(businessId, campaignId)
    )
      throw new AppError(
        409,
        "Предыдущее действие с кампанией требует сверки.",
      );
    if (
      db
        .prepare(
          "SELECT 1 FROM direct_moderation_actions WHERE business_id=? AND campaign_id=? AND status IN ('checking','sending','needs_reconciliation')",
        )
        .get(businessId, campaignId)
    )
      throw new AppError(409, "Модерация кампании требует сверки.");
    if (
      db
        .prepare(
          "SELECT 1 FROM direct_resume_actions WHERE business_id=? AND campaign_id=? AND status IN ('checking','sending')",
        )
        .get(businessId, campaignId)
    )
      throw new AppError(409, "Запуск кампании ещё выполняется.");
    if (
      db
        .prepare(
          "SELECT 1 FROM direct_archive_actions WHERE business_id=? AND campaign_id=? AND status IN ('checking','sending','needs_reconciliation')",
        )
        .get(businessId, campaignId)
    )
      throw new AppError(409, "Архивация кампании требует сверки.");
    if (
      db
        .prepare(
          "SELECT 1 FROM direct_budget_actions WHERE business_id=? AND campaign_id=? AND status IN ('checking','sending','needs_reconciliation')",
        )
        .get(businessId, campaignId)
    )
      throw new AppError(409, "Изменение лимита кампании требует сверки.");
    if (
      db
        .prepare(
          "SELECT 1 FROM direct_ab_actions WHERE business_id=? AND campaign_id=? AND status IN ('checking','sending','needs_reconciliation')",
        )
        .get(businessId, campaignId)
    )
      throw new AppError(409, "Создание варианта Б требует сверки.");
    if (
      db
        .prepare(
          "SELECT 1 FROM direct_ab_decision_actions WHERE business_id=? AND campaign_id=? AND status IN ('checking','sending','needs_reconciliation')",
        )
        .get(businessId, campaignId)
    )
      throw new AppError(409, "A/B-решение требует сверки.");
    const id = randomUUID(),
      at = new Date(now).toISOString();
    db.prepare(
      `INSERT INTO direct_lifecycle_actions(
      id,business_id,change_id,connection_id,campaign_id,idempotency_key,kind,status,created_at,updated_at)
      VALUES(?,?,?,?,?,?,'suspend','checking',?,?)`,
    ).run(
      id,
      businessId,
      changeId,
      connectionId,
      campaignId,
      idempotencyKey,
      at,
      at,
    );
    return { action: view(row(db, businessId, id)), created: true };
  });
}

function transition(db, userId, businessId, actionId, expected, values, now) {
  return transaction(db, () => {
    requireBusiness(db, userId, businessId);
    const current = row(db, businessId, actionId);
    requireSameConnection(db, current);
    if (current.status !== expected)
      throw new AppError(
        409,
        "Состояние действия изменилось во время запроса.",
      );
    const at = new Date(now).toISOString();
    db.prepare(
      `UPDATE direct_lifecycle_actions SET status=?,before_state=COALESCE(?,before_state),
      after_state=?,write_attempted=?,error_code=?,updated_at=? WHERE id=?`,
    ).run(
      values.status,
      values.beforeState ?? null,
      values.afterState ?? null,
      values.writeAttempted ? 1 : current.write_attempted,
      values.errorCode ?? null,
      at,
      actionId,
    );
    if (
      values.status === "succeeded" ||
      values.status === "needs_reconciliation"
    )
      event(db, businessId, {
        kind:
          values.status === "succeeded"
            ? values.afterState === "OFF"
              ? "direct_campaign_already_held"
              : "direct_campaign_suspended"
            : "direct_campaign_suspend_uncertain",
        title:
          values.status === "succeeded"
            ? values.afterState === "OFF"
              ? "Черновик уже выключен"
              : "Остановка кампании подтверждена"
            : "Остановка требует сверки",
        reason:
          values.status === "succeeded"
            ? values.afterState === "OFF"
              ? `Кампания ${current.campaign_id}: OFF/DRAFT подтверждено чтением Директа; вызов suspend не отправлялся.`
              : `Кампания ${current.campaign_id}: ${values.beforeState || current.before_state || "неизвестно"} → SUSPENDED; подтверждено повторным чтением Директа.`
            : `Кампания ${current.campaign_id}: ответ Директа не подтвержден; повторная запись не выполняется.`,
        rule: "direct/lifecycle@1",
        jobId: actionId,
      });
    return view(row(db, businessId, actionId));
  });
}

// A retry of the HTTP request returns the journal entry; it never sends a second suspend.
export async function suspendVerifiedCampaign(
  db,
  userId,
  businessId,
  changeId,
  idempotencyKey,
  client,
  { enabled = false, now = Date.now() } = {},
) {
  if (!enabled)
    throw new AppError(
      409,
      "Реальное управление Директом отключено.",
      "live_gate",
    );
  const { action, created } = beginSuspend(
    db,
    userId,
    businessId,
    changeId,
    idempotencyKey,
    now,
  );
  if (!created) return action;
  let sending = false;
  try {
    const before = campaignFrom(
      await client.campaignsByIds([action.campaignId]),
      action.campaignId,
    );
    if (before.State === "SUSPENDED")
      return transition(
        db,
        userId,
        businessId,
        action.id,
        "checking",
        {
          status: "succeeded",
          beforeState: "SUSPENDED",
          afterState: "SUSPENDED",
          writeAttempted: false,
        },
        Date.now(),
      );
    if (before.State === "OFF" && before.Status === "DRAFT")
      return transition(
        db,
        userId,
        businessId,
        action.id,
        "checking",
        {
          status: "succeeded",
          beforeState: "OFF",
          afterState: "OFF",
          writeAttempted: false,
        },
        Date.now(),
      );
    if (!["ON", "OFF"].includes(before.State))
      throw new AppError(
        409,
        "Кампанию в этом состоянии нельзя остановить автоматически.",
      );
    transition(
      db,
      userId,
      businessId,
      action.id,
      "checking",
      {
        status: "sending",
        beforeState: before.State,
        writeAttempted: true,
      },
      Date.now(),
    );
    sending = true;
    const response = await client.suspendCampaigns([action.campaignId]);
    if (
      response?.SuspendResults?.length !== 1 ||
      response.SuspendResults[0].Id !== action.campaignId ||
      response.SuspendResults[0].Errors?.length
    )
      throw new AppError(
        502,
        "Директ не подтвердил остановку кампании.",
        "direct_suspend_result",
      );
    const after = campaignFrom(
      await client.campaignsByIds([action.campaignId]),
      action.campaignId,
    );
    if (after.State !== "SUSPENDED")
      throw new AppError(
        502,
        "Директ не подтвердил состояние SUSPENDED.",
        "direct_suspend_unverified",
      );
    return transition(
      db,
      userId,
      businessId,
      action.id,
      "sending",
      {
        status: "succeeded",
        beforeState: before.State,
        afterState: after.State,
        writeAttempted: true,
      },
      Date.now(),
    );
  } catch (error) {
    if (!sending) {
      return transition(
        db,
        userId,
        businessId,
        action.id,
        "checking",
        {
          status: "failed_no_write",
          errorCode: "precheck_failed",
          writeAttempted: false,
        },
        Date.now(),
      );
    }
    try {
      const after = campaignFrom(
        await client.campaignsByIds([action.campaignId]),
        action.campaignId,
      );
      if (after.State === "SUSPENDED")
        return transition(
          db,
          userId,
          businessId,
          action.id,
          "sending",
          {
            status: "succeeded",
            afterState: "SUSPENDED",
            writeAttempted: true,
          },
          Date.now(),
        );
    } catch {
      /* The result remains uncertain. */
    }
    return transition(
      db,
      userId,
      businessId,
      action.id,
      "sending",
      {
        status: "needs_reconciliation",
        errorCode: "unknown_result",
        writeAttempted: true,
      },
      Date.now(),
    );
  }
}

export async function inspectLifecycleAction(
  db,
  userId,
  businessId,
  changeId,
  actionId,
  client,
) {
  const current = row(db, requireBusiness(db, userId, businessId).id, actionId);
  if (current.change_id !== changeId)
    throw new AppError(404, "Действие с кампанией не найдено.");
  requireSameConnection(db, current);
  if (current.status !== "needs_reconciliation")
    throw new AppError(409, "Для действия сверка не требуется.");
  const remote = campaignFrom(
    await client.campaignsByIds([current.campaign_id]),
    current.campaign_id,
  );
  if (remote.State === "SUSPENDED")
    return transition(
      db,
      userId,
      businessId,
      actionId,
      "needs_reconciliation",
      {
        status: "succeeded",
        afterState: "SUSPENDED",
        writeAttempted: true,
      },
      Date.now(),
    );
  return transition(
    db,
    userId,
    businessId,
    actionId,
    "needs_reconciliation",
    {
      status: "needs_reconciliation",
      afterState: remote.State,
      errorCode: "state_not_suspended",
      writeAttempted: true,
    },
    Date.now(),
  );
}

export function markInterruptedLifecycleActions(db, now = Date.now()) {
  return transaction(db, () => {
    const at = new Date(now).toISOString();
    const checking = db
      .prepare(
        "UPDATE direct_lifecycle_actions SET status='failed_no_write',error_code='process_interrupted_before_write',updated_at=? WHERE status='checking'",
      )
      .run(at);
    const sending = db
      .prepare(
        "UPDATE direct_lifecycle_actions SET status='needs_reconciliation',error_code='process_interrupted',updated_at=? WHERE status='sending'",
      )
      .run(at);
    return checking.changes + sending.changes;
  });
}
