import { randomUUID } from "node:crypto";
import { AppError, event, requireBusiness, transaction } from "./db.js";
import { directChangeForPreflight } from "./direct.js";
import { directExecution } from "./direct-execution.js";
import { inspectDirectControl } from "./direct-control.js";
import { summarizeDirectMarking } from "./direct-marking.js";

const active = "('checking','sending','needs_reconciliation')";

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

function actionRow(db, businessId, id) {
  const row = db
    .prepare("SELECT * FROM direct_resume_actions WHERE business_id=? AND id=?")
    .get(businessId, id);
  if (!row) throw new AppError(404, "Действие запуска не найдено.");
  return row;
}

function connectedId(db, businessId) {
  const row = db
    .prepare(
      "SELECT metadata FROM connections WHERE business_id=? AND provider='yandex'",
    )
    .get(businessId);
  return row ? JSON.parse(row.metadata).connectionId : null;
}

function exactCampaign(db, userId, businessId, changeId, connectionId) {
  const { business, change } = directChangeForPreflight(
    db,
    userId,
    businessId,
    changeId,
  );
  const execution = directExecution(db, userId, businessId, changeId);
  if (execution.status !== "succeeded" || !execution.suspendVerified)
    throw new AppError(409, "Создание кампании ещё не подтверждено.");
  const createdConnection = db
    .prepare(
      "SELECT connection_id FROM direct_executions WHERE business_id=? AND change_id=?",
    )
    .get(businessId, changeId)?.connection_id;
  if (
    createdConnection !== connectionId ||
    connectedId(db, businessId) !== connectionId
  )
    throw new AppError(409, "Подключение Директа изменилось.");
  const campaignId = execution.calls.find((call) => call.key === "campaign")
    ?.ids[0];
  if (!Number.isSafeInteger(campaignId) || campaignId <= 0)
    throw new AppError(409, "ID кампании не подтверждён.");
  return { business, change, campaignId };
}

function assertNoOtherAction(db, businessId, campaignId) {
  for (const table of [
    "direct_lifecycle_actions",
    "direct_archive_actions",
    "direct_moderation_actions",
    "direct_budget_actions",
    "direct_ab_actions",
    "direct_ab_decision_actions",
  ]) {
    const pending = db
      .prepare(
        `SELECT 1 FROM ${table} WHERE business_id=? AND campaign_id=? AND status IN ${active}`,
      )
      .get(businessId, campaignId);
    if (pending)
      throw new AppError(
        409,
        "Другое действие с кампанией ещё требует сверки.",
      );
  }
}

export function resumeActions(db, userId, businessId, changeId) {
  requireBusiness(db, userId, businessId);
  return db
    .prepare(
      "SELECT * FROM direct_resume_actions WHERE business_id=? AND change_id=? ORDER BY created_at DESC,rowid DESC LIMIT 10",
    )
    .all(businessId, changeId)
    .map(view);
}

function begin(db, userId, businessId, changeId, key, connectionId, now) {
  return transaction(db, () => {
    const { campaignId } = exactCampaign(
      db,
      userId,
      businessId,
      changeId,
      connectionId,
    );
    const previous = db
      .prepare(
        "SELECT * FROM direct_resume_actions WHERE business_id=? AND idempotency_key=?",
      )
      .get(businessId, key);
    if (previous) {
      if (previous.change_id !== changeId)
        throw new AppError(409, "Ключ уже использован для другой кампании.");
      return { action: view(previous), created: false };
    }
    if (
      db
        .prepare(
          `SELECT 1 FROM direct_resume_actions WHERE business_id=? AND campaign_id=? AND status IN ${active}`,
        )
        .get(businessId, campaignId)
    )
      throw new AppError(409, "Предыдущий запуск требует сверки.");
    assertNoOtherAction(db, businessId, campaignId);
    const id = randomUUID();
    const at = new Date(now).toISOString();
    db.prepare(
      `INSERT INTO direct_resume_actions
      (id,business_id,change_id,connection_id,campaign_id,idempotency_key,status,created_at,updated_at)
      VALUES(?,?,?,?,?,?,'checking',?,?)`,
    ).run(id, businessId, changeId, connectionId, campaignId, key, at, at);
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
      throw new AppError(409, "Подключение изменилось во время запуска.");
    if (row.status !== expected)
      throw new AppError(409, "Состояние запуска изменилось.");
    if (status === "sending")
      assertNoOtherAction(db, businessId, row.campaign_id);
    db.prepare(
      `UPDATE direct_resume_actions SET status=?,write_attempted=?,
      error_code=?,before_state=COALESCE(?,before_state),after_state=?,updated_at=? WHERE id=?`,
    ).run(
      status,
      values.writeAttempted ? 1 : row.write_attempted,
      values.errorCode ?? null,
      values.beforeState ?? null,
      values.afterState ?? null,
      new Date().toISOString(),
      actionId,
    );
    if (["succeeded", "needs_reconciliation"].includes(status))
      event(db, businessId, {
        kind:
          status === "succeeded"
            ? "direct_campaign_resumed"
            : "direct_campaign_resume_uncertain",
        title:
          status === "succeeded"
            ? "Показы кампании возобновлены"
            : "Запуск требует сверки",
        reason: `Кампания ${row.campaign_id}; ${status === "succeeded" ? "состояние ON подтверждено Директом" : "повторный запрос запрещён"}.`,
        rule: "direct/resume@1",
        jobId: actionId,
      });
    return view(actionRow(db, businessId, actionId));
  });
}

async function remoteState(client, id) {
  const response = await client.campaignBudgetById(id);
  const campaigns = response?.Campaigns;
  if (
    !Array.isArray(campaigns) ||
    campaigns.length !== 1 ||
    campaigns[0].Id !== id
  )
    throw new AppError(502, "Не удалось сверить состояние кампании.");
  return campaigns[0].State;
}

export async function resumeVerifiedCampaign(
  db,
  userId,
  businessId,
  changeId,
  requestKey,
  client,
  connectionId,
  {
    enabled = false,
    advertiserConfirmed = false,
    siteConfirmed = false,
    markingConfirmed = false,
    spendConfirmed = false,
    confirmCampaignId,
    confirmLimitKopecks,
    now = Date.now(),
  } = {},
) {
  if (!enabled)
    throw new AppError(409, "Запуск показов отключён на сервере.", "live_gate");
  if (!/^[0-9a-f-]{36}$/i.test(requestKey))
    throw new AppError(400, "Некорректный ключ запроса.");
  const { change, campaignId } = exactCampaign(
    db,
    userId,
    businessId,
    changeId,
    connectionId,
  );
  if (
    !advertiserConfirmed ||
    !siteConfirmed ||
    !markingConfirmed ||
    !spendConfirmed ||
    confirmCampaignId !== campaignId ||
    confirmLimitKopecks !== change.plan.budget
  )
    throw new AppError(
      400,
      "Подтвердите рекламодателя, сайт, маркировку, расходы, ID и лимит кампании.",
    );
  const { action, created } = begin(
    db,
    userId,
    businessId,
    changeId,
    requestKey,
    connectionId,
    now,
  );
  if (!created) return action;
  let sending = false;
  try {
    const readiness = await inspectDirectControl(
      db,
      userId,
      businessId,
      changeId,
      randomUUID(),
      client,
      connectionId,
      now,
    );
    if (
      readiness.status !== "technical_ready" ||
      readiness.campaignId !== campaignId
    )
      throw new AppError(
        409,
        `Запуск заблокирован: ${readiness.blockers.join(", ")}`,
      );
    const marking = summarizeDirectMarking(
      await client.advertiserMarkingDetails(),
      now,
    );
    if (!marking.basicFieldsPresent)
      throw new AppError(409, "Основные данные рекламодателя не найдены.");
    // Re-read the campaign immediately before writing; reports alone are not a live balance.
    if ((await remoteState(client, campaignId)) !== "SUSPENDED")
      throw new AppError(409, "Кампания больше не остановлена.");
    transition(db, userId, businessId, action.id, "checking", "sending", {
      writeAttempted: true,
      beforeState: "SUSPENDED",
    });
    sending = true;
    const response = await client.resumeCampaigns([campaignId]);
    if (
      !Array.isArray(response?.ResumeResults) ||
      response.ResumeResults.length !== 1 ||
      response.ResumeResults[0].Id !== campaignId ||
      response.ResumeResults[0].Errors?.length
    )
      throw new AppError(502, "Директ не подтвердил возобновление кампании.");
    if ((await remoteState(client, campaignId)) !== "ON")
      throw new AppError(502, "Состояние ON после запуска не подтверждено.");
    return transition(
      db,
      userId,
      businessId,
      action.id,
      "sending",
      "succeeded",
      {
        writeAttempted: true,
        afterState: "ON",
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
        {
          errorCode: "precheck_failed",
        },
      );
    try {
      if ((await remoteState(client, campaignId)) === "ON")
        return transition(
          db,
          userId,
          businessId,
          action.id,
          "sending",
          "succeeded",
          {
            writeAttempted: true,
            afterState: "ON",
          },
        );
    } catch {
      /* remote response unknown; never replay */
    }
    return transition(
      db,
      userId,
      businessId,
      action.id,
      "sending",
      "needs_reconciliation",
      {
        writeAttempted: true,
        errorCode: "unknown_result",
      },
    );
  }
}

export async function inspectResumeAction(
  db,
  userId,
  businessId,
  changeId,
  actionId,
  client,
) {
  requireBusiness(db, userId, businessId);
  const action = actionRow(db, businessId, actionId);
  if (action.change_id !== changeId)
    throw new AppError(404, "Действие запуска не найдено.");
  if (action.connection_id !== connectedId(db, businessId))
    throw new AppError(409, "Подключение изменилось после запуска.");
  if (action.status !== "needs_reconciliation")
    throw new AppError(409, "Для этого действия сверка не нужна.");
  if ((await remoteState(client, action.campaign_id)) === "ON")
    return transition(
      db,
      userId,
      businessId,
      actionId,
      "needs_reconciliation",
      "succeeded",
      {
        writeAttempted: true,
        afterState: "ON",
      },
    );
  return view(action);
}

export function markInterruptedResumeActions(db, now = Date.now()) {
  return transaction(db, () => {
    const at = new Date(now).toISOString();
    const checking = db
      .prepare(
        "UPDATE direct_resume_actions SET status='failed_no_write',error_code='process_interrupted_before_write',updated_at=? WHERE status='checking'",
      )
      .run(at);
    const sending = db
      .prepare(
        "UPDATE direct_resume_actions SET status='needs_reconciliation',error_code='process_interrupted',updated_at=? WHERE status='sending'",
      )
      .run(at);
    return checking.changes + sending.changes;
  });
}
