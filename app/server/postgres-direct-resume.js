import { randomUUID } from "node:crypto";
import { AppError } from "./db.js";
import { summarizeDirectMarking } from "./direct-marking.js";
import { inspectPostgresDirectControl } from "./postgres-direct-moderation.js";

const activeStatuses = "('checking','sending','needs_reconciliation')";
const heldStates = new Set(["OFF", "SUSPENDED"]);

function actionView(row) {
  return {
    id: row.id,
    changeId: row.change_id,
    campaignId: Number(row.campaign_id),
    status: row.status,
    beforeState: row.before_state,
    afterState: row.after_state,
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

async function currentConnectionId(db, businessId) {
  const row = await db
    .prepare(
      "SELECT metadata FROM connections WHERE business_id=? AND provider='yandex'",
    )
    .get(businessId);
  return row ? JSON.parse(row.metadata).connectionId : null;
}

async function actionRow(db, businessId, actionId) {
  const row = await db
    .prepare(
      "SELECT * FROM direct_resume_actions WHERE business_id=? AND id=?",
    )
    .get(businessId, actionId);
  if (!row)
    throw new AppError(404, "Действие запуска не найдено.", "action_missing");
  return row;
}

async function campaignBundle(
  db,
  userId,
  businessId,
  changeId,
  connectionId,
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
    throw new AppError(409, "Создание кампании ещё не подтверждено.");
  if (
    row.connection_id !== connectionId ||
    (await currentConnectionId(db, businessId)) !== connectionId
  )
    throw new AppError(409, "Кабинет изменился после создания кампании.");
  const plan = JSON.parse(row.plan_json);
  if (Number.isSafeInteger(Number(row.limit_kopecks)) && Number(row.limit_kopecks) > 0)
    plan.budget = Number(row.limit_kopecks);
  const calls = JSON.parse(row.calls_json);
  const ids = Object.fromEntries(calls.map((item) => [item.key, item.ids]));
  const campaignId = Number(ids.campaign?.[0]);
  if (!Number.isSafeInteger(campaignId) || campaignId <= 0)
    throw new AppError(409, "ID кампании не подтверждён.");
  return { business, plan, campaignId };
}

async function remoteCampaign(client, campaignId) {
  const response = await client.campaignBudgetById(campaignId);
  const campaigns = response?.Campaigns;
  if (
    !Array.isArray(campaigns) ||
    campaigns.length !== 1 ||
    String(campaigns[0].Id) !== String(campaignId)
  )
    throw new AppError(502, "Не удалось сверить состояние кампании.");
  return campaigns[0];
}

async function hasOtherAction(db, businessId, campaignId) {
  for (const table of [
    "direct_lifecycle_actions",
    "direct_archive_actions",
    "direct_moderation_actions",
    "direct_budget_actions",
    "direct_ab_actions",
    "direct_ab_decision_actions",
  ]) {
    const pending = await db
      .prepare(
        `SELECT 1 AS found FROM ${table}
         WHERE business_id=? AND campaign_id=? AND status IN ${activeStatuses}
         LIMIT 1`,
      )
      .get(businessId, campaignId);
    if (pending) return true;
  }
  return false;
}

async function beginAction(
  db,
  userId,
  businessId,
  changeId,
  campaignId,
  requestKey,
  connectionId,
  now,
) {
  return db.transaction(async (tx) => {
    await ownedBusiness(tx, userId, businessId);
    const previous = await tx
      .prepare(
        "SELECT * FROM direct_resume_actions WHERE business_id=? AND idempotency_key=?",
      )
      .get(businessId, requestKey);
    if (previous) {
      if (previous.change_id !== changeId)
        throw new AppError(409, "Ключ уже использован для другой кампании.");
      return { action: actionView(previous), created: false };
    }
    const currentResume = await tx
      .prepare(
        `SELECT 1 AS found FROM direct_resume_actions
         WHERE business_id=? AND campaign_id=? AND status IN ${activeStatuses}
         LIMIT 1`,
      )
      .get(businessId, campaignId);
    if (currentResume || (await hasOtherAction(tx, businessId, campaignId)))
      throw new AppError(
        409,
        "Другое действие с кампанией ещё требует сверки.",
        "campaign_action_pending",
      );
    const id = randomUUID();
    const at = new Date(now).toISOString();
    await tx
      .prepare(
        `INSERT INTO direct_resume_actions
         (id,business_id,change_id,connection_id,campaign_id,idempotency_key,
          status,write_attempted,error_code,before_state,after_state,created_at,updated_at)
         VALUES(?,?,?,?,?,?,'checking',0,NULL,NULL,NULL,?,?)`,
      )
      .run(
        id,
        businessId,
        changeId,
        connectionId,
        campaignId,
        requestKey,
        at,
        at,
      );
    return {
      action: actionView(await actionRow(tx, businessId, id)),
      created: true,
    };
  });
}

async function transition(
  db,
  userId,
  businessId,
  actionId,
  expected,
  status,
  values = {},
) {
  return db.transaction(async (tx) => {
    await ownedBusiness(tx, userId, businessId);
    const row = await actionRow(tx, businessId, actionId);
    if ((await currentConnectionId(tx, businessId)) !== row.connection_id)
      throw new AppError(409, "Подключение изменилось во время запуска.");
    if (row.status !== expected)
      throw new AppError(409, "Состояние запуска изменилось.");
    if (
      status === "sending" &&
      (await hasOtherAction(tx, businessId, Number(row.campaign_id)))
    )
      throw new AppError(409, "Параллельное действие с кампанией запрещено.");
    const at = new Date().toISOString();
    await tx
      .prepare(
        `UPDATE direct_resume_actions SET status=?,write_attempted=?,error_code=?,
         before_state=COALESCE(?,before_state),after_state=?,updated_at=? WHERE id=?`,
      )
      .run(
        status,
        values.writeAttempted ? 1 : row.write_attempted,
        values.errorCode ?? null,
        values.beforeState ?? null,
        values.afterState ?? null,
        at,
        actionId,
      );
    if (status === "succeeded") {
      await tx
        .prepare(
          `UPDATE campaign_ad_lifecycle
           SET status='active',reason=?,updated_at=?
           WHERE business_id=? AND change_id=?`,
        )
        .run(
          "Показы запущены после подтверждения владельца и сверки Директа.",
          at,
          businessId,
          row.change_id,
        );
      await addEvent(tx, businessId, {
        kind: "direct_campaign_resumed",
        title: "Реклама запущена",
        reason: `Директ подтвердил состояние ON для кампании ${row.campaign_id}.`,
        rule: "direct/postgres-resume@1",
        jobId: actionId,
      });
    } else if (status === "needs_reconciliation") {
      await tx
        .prepare(
          `UPDATE campaign_ad_lifecycle
           SET status='needs_reconciliation',reason=?,updated_at=?
           WHERE business_id=? AND change_id=?`,
        )
        .run(
          "Ответ Директа неоднозначен. Повторный запуск запрещён до чтения состояния.",
          at,
          businessId,
          row.change_id,
        );
      await addEvent(tx, businessId, {
        kind: "direct_campaign_resume_uncertain",
        title: "Запуск требует сверки",
        reason: "Повторный запрос не отправлен. Ритм сначала прочитает состояние Директа.",
        rule: "direct/postgres-resume@1",
        jobId: actionId,
      });
    }
    return actionView(await actionRow(tx, businessId, actionId));
  });
}

export async function postgresResumeActions(db, userId, businessId, changeId) {
  await ownedBusiness(db, userId, businessId);
  const rows = await db
    .prepare(
      `SELECT * FROM direct_resume_actions
       WHERE business_id=? AND change_id=?
       ORDER BY created_at DESC,id DESC LIMIT 10`,
    )
    .all(businessId, changeId);
  return rows.map(actionView);
}

export async function resumePostgresVerifiedCampaign(
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
    launchConfirmed = false,
    confirmCampaignId,
    confirmLimitKopecks,
    now = Date.now(),
  } = {},
) {
  if (!enabled)
    throw new AppError(409, "Запуск показов отключён на сервере.", "live_gate");
  if (!/^[0-9a-f-]{36}$/i.test(requestKey))
    throw new AppError(400, "Некорректный ключ запроса.");
  const bundle = await campaignBundle(
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
    !launchConfirmed ||
    String(confirmCampaignId) !== String(bundle.campaignId) ||
    confirmLimitKopecks !== bundle.plan.budget
  )
    throw new AppError(
      400,
      "Подтвердите рекламодателя, страницу, маркировку, расходы, запуск, ID и лимит кампании.",
      "launch_confirmation_missing",
    );
  const { action, created } = await beginAction(
    db,
    userId,
    businessId,
    changeId,
    bundle.campaignId,
    requestKey,
    connectionId,
    now,
  );
  if (!created) return action;
  let sending = false;
  try {
    const readiness = await inspectPostgresDirectControl(
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
      readiness.campaignId !== bundle.campaignId
    )
      throw new AppError(
        409,
        `Запуск заблокирован: ${readiness.blockers.join(", ")}`,
        "launch_not_ready",
      );
    const marking = summarizeDirectMarking(
      await client.advertiserMarkingDetails(),
      now,
    );
    if (!marking.basicFieldsPresent)
      throw new AppError(
        409,
        "Основные данные рекламодателя не найдены.",
        "advertiser_data_incomplete",
      );
    const before = await remoteCampaign(client, bundle.campaignId);
    if (!heldStates.has(before.State) || before.Status !== "ACCEPTED")
      throw new AppError(
        409,
        "Кампания больше не готова к безопасному запуску.",
        "campaign_not_held",
      );
    await transition(
      db,
      userId,
      businessId,
      action.id,
      "checking",
      "sending",
      { writeAttempted: true, beforeState: before.State },
    );
    sending = true;
    const response = await client.resumeCampaigns([bundle.campaignId]);
    if (
      !Array.isArray(response?.ResumeResults) ||
      response.ResumeResults.length !== 1 ||
      String(response.ResumeResults[0].Id) !== String(bundle.campaignId) ||
      response.ResumeResults[0].Errors?.length
    )
      throw new AppError(502, "Директ не подтвердил запуск кампании.");
    const after = await remoteCampaign(client, bundle.campaignId);
    if (after.State !== "ON")
      throw new AppError(502, "Состояние ON после запуска не подтверждено.");
    return transition(
      db,
      userId,
      businessId,
      action.id,
      "sending",
      "succeeded",
      { writeAttempted: true, afterState: "ON" },
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
      const after = await remoteCampaign(client, bundle.campaignId);
      if (after.State === "ON")
        return transition(
          db,
          userId,
          businessId,
          action.id,
          "sending",
          "succeeded",
          { writeAttempted: true, afterState: "ON" },
        );
    } catch {
      // The write may have reached Direct. Never replay it automatically.
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

export async function inspectPostgresResumeAction(
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
    throw new AppError(404, "Действие запуска не найдено.", "action_missing");
  if (action.connection_id !== (await currentConnectionId(db, businessId)))
    throw new AppError(409, "Кабинет изменился после запуска.");
  if (action.status !== "needs_reconciliation")
    throw new AppError(409, "Для этого запуска сверка не нужна.");
  const remote = await remoteCampaign(client, Number(action.campaign_id));
  if (remote.State === "ON")
    return transition(
      db,
      userId,
      businessId,
      actionId,
      "needs_reconciliation",
      "succeeded",
      { writeAttempted: true, afterState: "ON" },
    );
  return actionView(action);
}

export async function markInterruptedPostgresResumeActions(
  db,
  now = Date.now(),
) {
  const at = new Date(now).toISOString();
  const checking = await db
    .prepare(
      `UPDATE direct_resume_actions
       SET status='failed_no_write',error_code='process_interrupted_before_write',updated_at=?
       WHERE status='checking'`,
    )
    .run(at);
  const sending = await db
    .prepare(
      `UPDATE direct_resume_actions
       SET status='needs_reconciliation',error_code='process_interrupted',updated_at=?
       WHERE status='sending'`,
    )
    .run(at);
  return Number(checking.changes || 0) + Number(sending.changes || 0);
}
