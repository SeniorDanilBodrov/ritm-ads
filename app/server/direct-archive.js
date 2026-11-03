import { randomUUID } from "node:crypto";
import { AppError, event, requireBusiness, transaction } from "./db.js";
import { directExecution } from "./direct-execution.js";

function view(row) {
  return {
    id: row.id,
    changeId: row.change_id,
    campaignId: row.campaign_id,
    status: row.status,
    beforeState: row.before_state,
    afterState: row.after_state,
    writeAttempted: !!row.write_attempted,
    errorCode: row.error_code,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function actionRow(db, businessId, actionId) {
  const row = db
    .prepare(
      "SELECT * FROM direct_archive_actions WHERE business_id=? AND id=?",
    )
    .get(businessId, actionId);
  if (!row) throw new AppError(404, "Действие архивации не найдено.");
  return row;
}

function connectionId(db, businessId) {
  const connection = db
    .prepare(
      "SELECT metadata FROM connections WHERE business_id=? AND provider='yandex'",
    )
    .get(businessId);
  return connection ? JSON.parse(connection.metadata).connectionId : null;
}

function requireSameConnection(db, row) {
  if (connectionId(db, row.business_id) !== row.connection_id)
    throw new AppError(409, "Кабинет изменился после создания кампании.");
}

function remoteCampaign(result, id) {
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

export function archiveActions(db, userId, businessId, changeId) {
  requireBusiness(db, userId, businessId);
  return db
    .prepare(
      "SELECT * FROM direct_archive_actions WHERE business_id=? AND change_id=? ORDER BY created_at DESC,rowid DESC LIMIT 20",
    )
    .all(businessId, changeId)
    .map(view);
}

function begin(db, userId, businessId, changeId, key, confirmedId, now) {
  return transaction(db, () => {
    requireBusiness(db, userId, businessId);
    const execution = directExecution(db, userId, businessId, changeId);
    if (execution.status !== "succeeded" || !execution.suspendVerified)
      throw new AppError(409, "Кампания не прошла сверку создания.");
    const campaignId = execution.calls.find((call) => call.key === "campaign")
      ?.ids[0];
    if (
      !Number.isSafeInteger(campaignId) ||
      campaignId <= 0 ||
      campaignId !== confirmedId
    )
      throw new AppError(409, "Подтвердите точный ID созданной кампании.");
    const previous = db
      .prepare(
        "SELECT * FROM direct_archive_actions WHERE business_id=? AND idempotency_key=?",
      )
      .get(businessId, key);
    if (previous) {
      if (
        previous.change_id !== changeId ||
        previous.campaign_id !== campaignId
      )
        throw new AppError(
          409,
          "Ключ уже использован для другого действия.",
          "idempotency_conflict",
        );
      return { action: view(previous), created: false };
    }
    const createdConnectionId = db
      .prepare("SELECT connection_id FROM direct_executions WHERE change_id=?")
      .get(changeId)?.connection_id;
    if (
      !createdConnectionId ||
      connectionId(db, businessId) !== createdConnectionId
    )
      throw new AppError(409, "Кабинет изменился после создания кампании.");
    if (
      db
        .prepare(
          "SELECT 1 FROM direct_lifecycle_actions WHERE business_id=? AND campaign_id=? AND status IN ('checking','sending','needs_reconciliation')",
        )
        .get(businessId, campaignId)
    )
      throw new AppError(409, "Остановка кампании ещё требует сверки.");
    if (
      db
        .prepare(
          "SELECT 1 FROM direct_archive_actions WHERE business_id=? AND campaign_id=? AND status IN ('checking','sending','needs_reconciliation')",
        )
        .get(businessId, campaignId)
    )
      throw new AppError(
        409,
        "Архивация кампании уже выполняется или требует сверки.",
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
          "SELECT 1 FROM direct_resume_actions WHERE business_id=? AND campaign_id=? AND status IN ('checking','sending','needs_reconciliation')",
        )
        .get(businessId, campaignId)
    )
      throw new AppError(409, "Запуск кампании требует сверки.");
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
      `INSERT INTO direct_archive_actions(
      id,business_id,change_id,connection_id,campaign_id,idempotency_key,status,created_at,updated_at
    ) VALUES(?,?,?,?,?,?,'checking',?,?)`,
    ).run(
      id,
      businessId,
      changeId,
      createdConnectionId,
      campaignId,
      key,
      at,
      at,
    );
    return { action: view(actionRow(db, businessId, id)), created: true };
  });
}

function transition(db, userId, businessId, actionId, expected, values, now) {
  return transaction(db, () => {
    requireBusiness(db, userId, businessId);
    const current = actionRow(db, businessId, actionId);
    requireSameConnection(db, current);
    if (current.status !== expected)
      throw new AppError(
        409,
        "Состояние архивации изменилось во время запроса.",
      );
    db.prepare(
      `UPDATE direct_archive_actions SET
      status=?,before_state=COALESCE(?,before_state),after_state=?,
      write_attempted=?,error_code=?,updated_at=? WHERE id=?`,
    ).run(
      values.status,
      values.beforeState ?? null,
      values.afterState ?? null,
      values.writeAttempted || current.write_attempted ? 1 : 0,
      values.errorCode ?? null,
      new Date(now).toISOString(),
      actionId,
    );
    if (["succeeded", "needs_reconciliation"].includes(values.status))
      event(db, businessId, {
        kind:
          values.status === "succeeded"
            ? "direct_campaign_archived"
            : "direct_campaign_archive_uncertain",
        title:
          values.status === "succeeded"
            ? "Архивация подтверждена"
            : "Архивация требует сверки",
        reason:
          values.status === "succeeded"
            ? `Кампания ${current.campaign_id}: состояние ARCHIVED подтверждено чтением Директа.`
            : `Кампания ${current.campaign_id}: результат архивации неизвестен; повторная запись не выполняется.`,
        rule: "direct/archive@1",
        jobId: actionId,
      });
    return view(actionRow(db, businessId, actionId));
  });
}

// A repeated request returns the journal entry and never repeats the API write.
export async function archiveVerifiedCampaign(
  db,
  userId,
  businessId,
  changeId,
  idempotencyKey,
  confirmedCampaignId,
  client,
  { enabled = false, confirmedNoFunds = false, now = Date.now() } = {},
) {
  if (!enabled)
    throw new AppError(409, "Архивация Директа отключена.", "archive_gate");
  if (!confirmedNoFunds)
    throw new AppError(
      409,
      "Подтвердите отсутствие средств на кампании.",
      "funds_confirmation",
    );
  const { action, created } = begin(
    db,
    userId,
    businessId,
    changeId,
    idempotencyKey,
    confirmedCampaignId,
    now,
  );
  if (!created) return action;
  let sending = false;
  try {
    const before = remoteCampaign(
      await client.campaignsByIds([action.campaignId]),
      action.campaignId,
    );
    if (before.State === "ARCHIVED")
      return transition(
        db,
        userId,
        businessId,
        action.id,
        "checking",
        {
          status: "succeeded",
          beforeState: "ARCHIVED",
          afterState: "ARCHIVED",
          writeAttempted: false,
        },
        Date.now(),
      );
    if (before.State !== "SUSPENDED")
      return transition(
        db,
        userId,
        businessId,
        action.id,
        "checking",
        {
          status: "failed_no_write",
          beforeState: before.State ?? "UNKNOWN",
          errorCode: "not_suspended",
          writeAttempted: false,
        },
        Date.now(),
      );
    transition(
      db,
      userId,
      businessId,
      action.id,
      "checking",
      {
        status: "sending",
        beforeState: "SUSPENDED",
        writeAttempted: true,
      },
      Date.now(),
    );
    sending = true;
    const response = await client.archiveCampaigns([action.campaignId]);
    if (
      response?.ArchiveResults?.length !== 1 ||
      response.ArchiveResults[0].Id !== action.campaignId ||
      response.ArchiveResults[0].Errors?.length
    )
      throw new AppError(
        502,
        "Директ не подтвердил архивацию.",
        "direct_archive_result",
      );
    const after = remoteCampaign(
      await client.campaignsByIds([action.campaignId]),
      action.campaignId,
    );
    if (after.State !== "ARCHIVED")
      throw new AppError(
        502,
        "Состояние ARCHIVED не подтверждено.",
        "direct_archive_unverified",
      );
    return transition(
      db,
      userId,
      businessId,
      action.id,
      "sending",
      {
        status: "succeeded",
        beforeState: "SUSPENDED",
        afterState: "ARCHIVED",
        writeAttempted: true,
      },
      Date.now(),
    );
  } catch {
    if (!sending)
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
    try {
      const after = remoteCampaign(
        await client.campaignsByIds([action.campaignId]),
        action.campaignId,
      );
      if (after.State === "ARCHIVED")
        return transition(
          db,
          userId,
          businessId,
          action.id,
          "sending",
          {
            status: "succeeded",
            afterState: "ARCHIVED",
            writeAttempted: true,
          },
          Date.now(),
        );
    } catch {
      // The write may have succeeded; never replay it automatically.
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

export async function inspectArchiveAction(
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
    throw new AppError(404, "Действие архивации не найдено.");
  requireSameConnection(db, current);
  if (current.status !== "needs_reconciliation")
    throw new AppError(409, "Для архивации сверка не требуется.");
  const remote = remoteCampaign(
    await client.campaignsByIds([current.campaign_id]),
    current.campaign_id,
  );
  return transition(
    db,
    userId,
    businessId,
    actionId,
    "needs_reconciliation",
    {
      status:
        remote.State === "ARCHIVED" ? "succeeded" : "needs_reconciliation",
      afterState: remote.State,
      errorCode: remote.State === "ARCHIVED" ? null : "state_not_archived",
      writeAttempted: true,
    },
    Date.now(),
  );
}

export function markInterruptedArchiveActions(db, now = Date.now()) {
  return transaction(db, () => {
    const at = new Date(now).toISOString();
    const checking = db
      .prepare(
        "UPDATE direct_archive_actions SET status='failed_no_write',error_code='process_interrupted_before_write',updated_at=? WHERE status='checking'",
      )
      .run(at);
    const sending = db
      .prepare(
        "UPDATE direct_archive_actions SET status='needs_reconciliation',error_code='process_interrupted',updated_at=? WHERE status='sending'",
      )
      .run(at);
    return checking.changes + sending.changes;
  });
}
