import { randomUUID } from "node:crypto";
import { AppError, event, requireBusiness, transaction } from "./db.js";
import { directAbPlanView } from "./direct-ab.js";

const active = "('checking','sending','needs_reconciliation')";

function view(row) {
  return {
    id: row.id,
    planId: row.plan_id,
    changeId: row.change_id,
    campaignId: row.campaign_id,
    targetAdId: row.target_ad_id,
    operation: row.operation,
    status: row.status,
    writeAttempted: !!row.write_attempted,
    errorCode: row.error_code,
    beforeState: row.before_state,
    afterState: row.after_state,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function connectedId(db, businessId) {
  const row = db
    .prepare(
      "SELECT metadata FROM connections WHERE business_id=? AND provider='yandex'",
    )
    .get(businessId);
  return row ? JSON.parse(row.metadata).connectionId : null;
}

function actionRow(db, businessId, actionId) {
  const row = db
    .prepare(
      "SELECT * FROM direct_ab_decision_actions WHERE business_id=? AND id=?",
    )
    .get(businessId, actionId);
  if (!row) throw new AppError(404, "A/B-решение не найдено.");
  return row;
}

function planRow(db, businessId, planId) {
  const row = db
    .prepare("SELECT * FROM direct_ab_plans WHERE business_id=? AND id=?")
    .get(businessId, planId);
  if (!row) throw new AppError(404, "A/B-план не найден.");
  return row;
}

function moscowDate(now) {
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Europe/Moscow",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(now));
}

function expectedTarget(plan, operation, now) {
  if (!plan.variant.adId)
    throw new AppError(409, "Вариант Б не создан или не подтверждён.");
  if (operation === "rollback_variant") {
    if (plan.evidence.reportId || moscowDate(now) >= plan.periodStart)
      throw new AppError(
        409,
        "Черновой откат доступен только до начала теста и появления статистики.",
      );
    return String(plan.variant.adId);
  }
  if (!["control_wins", "variant_wins"].includes(plan.outcome))
    throw new AppError(409, "Победитель A/B-теста ещё не подтверждён.");
  return plan.outcome === "control_wins"
    ? String(plan.variant.adId)
    : String(plan.control.adId);
}

function assertNoOtherAction(db, businessId, campaignId, planId) {
  for (const table of [
    "direct_lifecycle_actions",
    "direct_archive_actions",
    "direct_moderation_actions",
    "direct_resume_actions",
    "direct_budget_actions",
    "direct_ab_actions",
  ]) {
    if (
      db
        .prepare(
          `SELECT 1 FROM ${table} WHERE business_id=? AND campaign_id=? AND status IN ${active}`,
        )
        .get(businessId, campaignId)
    )
      throw new AppError(409, "Другое действие с кампанией требует сверки.");
  }
  if (
    db
      .prepare(
        `SELECT 1 FROM direct_ab_decision_actions WHERE plan_id=? AND status IN ${active}`,
      )
      .get(planId)
  )
    throw new AppError(409, "Предыдущее A/B-решение требует сверки.");
}

function begin(
  db,
  userId,
  businessId,
  planId,
  requestKey,
  connectionId,
  operation,
  confirmCampaignId,
  confirmTargetAdId,
  now,
) {
  return transaction(db, () => {
    requireBusiness(db, userId, businessId);
    const row = planRow(db, businessId, planId),
      plan = directAbPlanView(db, userId, businessId, planId),
      previous = db
        .prepare(
          "SELECT * FROM direct_ab_decision_actions WHERE business_id=? AND idempotency_key=?",
        )
        .get(businessId, requestKey);
    if (previous) {
      if (
        previous.plan_id !== planId ||
        previous.operation !== operation ||
        previous.target_ad_id !== String(confirmTargetAdId)
      )
        throw new AppError(
          409,
          "Ключ уже использован для другого A/B-решения.",
          "idempotency_conflict",
        );
      return { action: view(previous), created: false, plan };
    }
    const targetAdId = expectedTarget(plan, operation, now);
    if (
      row.connection_id !== connectionId ||
      connectedId(db, businessId) !== connectionId
    )
      throw new AppError(409, "Яндекс-кабинет изменился после A/B-плана.");
    if (
      String(confirmCampaignId) !== String(row.campaign_id) ||
      String(confirmTargetAdId) !== targetAdId
    )
      throw new AppError(409, "Подтвердите точные ID кампании и объявления.");
    if (
      db
        .prepare(
          "SELECT 1 FROM direct_ab_decision_actions WHERE plan_id=? AND status='succeeded'",
        )
        .get(planId)
    )
      throw new AppError(409, "A/B-решение уже применено.");
    assertNoOtherAction(db, businessId, row.campaign_id, planId);
    const id = randomUUID(),
      at = new Date(now).toISOString();
    db.prepare(
      `INSERT INTO direct_ab_decision_actions(
       id,business_id,plan_id,change_id,connection_id,campaign_id,target_ad_id,
       operation,idempotency_key,status,created_at,updated_at)
       VALUES(?,?,?,?,?,?,?,?,?,'checking',?,?)`,
    ).run(
      id,
      businessId,
      planId,
      row.change_id,
      connectionId,
      row.campaign_id,
      targetAdId,
      operation,
      requestKey,
      at,
      at,
    );
    return {
      action: view(actionRow(db, businessId, id)),
      created: true,
      plan,
    };
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
      throw new AppError(409, "Состояние A/B-решения изменилось.");
    db.prepare(
      `UPDATE direct_ab_decision_actions SET status=?,write_attempted=?,
       error_code=?,before_state=COALESCE(?,before_state),after_state=?,updated_at=?
       WHERE id=?`,
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
            ? "direct_ab_decision_applied"
            : "direct_ab_decision_uncertain",
        title:
          status === "succeeded"
            ? row.operation === "rollback_variant"
              ? "Вариант Б удалён"
              : "A/B-решение применено"
            : "A/B-решение требует сверки",
        reason:
          status === "succeeded"
            ? `Объявление ${row.target_ad_id}: подтверждено состояние ${values.afterState}.`
            : `Объявление ${row.target_ad_id}: результат записи неизвестен; повтор заблокирован.`,
        rule: "direct/ab-decision@1",
        jobId: actionId,
      });
    return view(actionRow(db, businessId, actionId));
  });
}

function remoteAd(response, adId) {
  if (!Array.isArray(response?.Ads))
    throw new AppError(502, "Не удалось прочитать объявление.");
  return response.Ads.find((item) => String(item.Id) === String(adId)) || null;
}

async function inspectRemote(client, action) {
  const ad = remoteAd(
    await client.adsByIds([action.targetAdId]),
    action.targetAdId,
  );
  if (ad && String(ad.CampaignId) !== String(action.campaignId))
    throw new AppError(409, "Объявление больше не принадлежит кампании.");
  if (action.operation === "rollback_variant")
    return ad
      ? { applied: false, state: ad.State || "UNKNOWN" }
      : { applied: true, state: "DELETED" };
  return ad?.State === "SUSPENDED"
    ? { applied: true, state: "SUSPENDED" }
    : { applied: false, state: ad?.State || "MISSING" };
}

export function directAbDecisionActions(db, userId, businessId, planId) {
  requireBusiness(db, userId, businessId);
  planRow(db, businessId, planId);
  return db
    .prepare(
      "SELECT * FROM direct_ab_decision_actions WHERE business_id=? AND plan_id=? ORDER BY created_at DESC,rowid DESC LIMIT 10",
    )
    .all(businessId, planId)
    .map(view);
}

export async function applyDirectAbDecision(
  db,
  userId,
  businessId,
  planId,
  requestKey,
  client,
  connectionId,
  {
    enabled = false,
    operation,
    confirmCampaignId,
    confirmTargetAdId,
    confirmed = false,
    now = Date.now(),
  } = {},
) {
  if (!enabled)
    throw new AppError(409, "Применение A/B-решений отключено.", "live_gate");
  if (!/^[0-9a-f-]{36}$/i.test(requestKey))
    throw new AppError(400, "Некорректный ключ запроса.");
  if (!["rollback_variant", "apply_outcome"].includes(operation))
    throw new AppError(400, "Некорректная A/B-операция.");
  if (!confirmed)
    throw new AppError(409, "Подтвердите последствие A/B-операции.");
  const { action, created } = begin(
    db,
    userId,
    businessId,
    planId,
    requestKey,
    connectionId,
    operation,
    confirmCampaignId,
    confirmTargetAdId,
    now,
  );
  if (!created) return action;
  let sending = false;
  try {
    const before = remoteAd(
      await client.adsByIds([action.targetAdId]),
      action.targetAdId,
    );
    if (before && String(before.CampaignId) !== String(action.campaignId))
      throw new AppError(409, "Объявление больше не принадлежит кампании.");
    if (operation === "rollback_variant") {
      if (!before)
        return transition(
          db,
          userId,
          businessId,
          action.id,
          "checking",
          "succeeded",
          { beforeState: "DELETED", afterState: "DELETED" },
        );
      if (before.Status !== "DRAFT" || before.State !== "OFF")
        return transition(
          db,
          userId,
          businessId,
          action.id,
          "checking",
          "failed_no_write",
          {
            beforeState: before.State || "UNKNOWN",
            errorCode: "variant_not_draft",
          },
        );
    } else {
      if (!before)
        return transition(
          db,
          userId,
          businessId,
          action.id,
          "checking",
          "failed_no_write",
          { beforeState: "MISSING", errorCode: "loser_missing" },
        );
      if (before.State === "SUSPENDED")
        return transition(
          db,
          userId,
          businessId,
          action.id,
          "checking",
          "succeeded",
          { beforeState: "SUSPENDED", afterState: "SUSPENDED" },
        );
      if (before.State !== "ON")
        return transition(
          db,
          userId,
          businessId,
          action.id,
          "checking",
          "failed_no_write",
          {
            beforeState: before.State || "UNKNOWN",
            errorCode: "loser_not_serving",
          },
        );
    }
    transition(db, userId, businessId, action.id, "checking", "sending", {
      beforeState: before.State,
      writeAttempted: true,
    });
    sending = true;
    const response =
      operation === "rollback_variant"
        ? await client.deleteAds([action.targetAdId])
        : await client.suspendAds([action.targetAdId]);
    const results =
      operation === "rollback_variant"
        ? response?.DeleteResults
        : response?.SuspendResults;
    if (
      !Array.isArray(results) ||
      results.length !== 1 ||
      String(results[0].Id) !== String(action.targetAdId) ||
      results[0].Errors?.length
    )
      throw new AppError(502, "Директ не подтвердил A/B-операцию.");
    const inspected = await inspectRemote(client, action);
    if (!inspected.applied)
      throw new AppError(502, "Результат A/B-операции не подтверждён чтением.");
    return transition(
      db,
      userId,
      businessId,
      action.id,
      "sending",
      "succeeded",
      { afterState: inspected.state, writeAttempted: true },
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
      const inspected = await inspectRemote(client, action);
      if (inspected.applied)
        return transition(
          db,
          userId,
          businessId,
          action.id,
          "sending",
          "succeeded",
          { afterState: inspected.state, writeAttempted: true },
        );
    } catch {}
    return transition(
      db,
      userId,
      businessId,
      action.id,
      "sending",
      "needs_reconciliation",
      { writeAttempted: true, errorCode: "write_outcome_unknown" },
    );
  }
}

export async function inspectDirectAbDecision(
  db,
  userId,
  businessId,
  planId,
  actionId,
  client,
) {
  requireBusiness(db, userId, businessId);
  const action = view(actionRow(db, businessId, actionId));
  if (action.planId !== planId)
    throw new AppError(404, "A/B-решение не найдено.");
  if (action.status !== "needs_reconciliation") return action;
  const inspected = await inspectRemote(client, action);
  return transition(
    db,
    userId,
    businessId,
    action.id,
    "needs_reconciliation",
    inspected.applied ? "succeeded" : "not_applied",
    {
      afterState: inspected.state,
      writeAttempted: true,
      errorCode: inspected.applied ? null : "not_applied_after_read",
    },
  );
}

export function markInterruptedAbDecisionActions(db) {
  transaction(db, () => {
    const at = new Date().toISOString();
    db.prepare(
      `UPDATE direct_ab_decision_actions SET status='failed_no_write',
       error_code='interrupted_before_send',updated_at=? WHERE status='checking'`,
    ).run(at);
    db.prepare(
      `UPDATE direct_ab_decision_actions SET status='needs_reconciliation',
       error_code='interrupted_after_send',write_attempted=1,updated_at=? WHERE status='sending'`,
    ).run(at);
  });
}
