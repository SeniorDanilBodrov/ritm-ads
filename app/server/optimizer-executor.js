import { AppError, event, requireBusiness, transaction } from "./db.js";
import { adLifecycle, transitionAdLifecycle } from "./ad-lifecycle.js";
import { suspendVerifiedCampaign } from "./direct-lifecycle.js";
import { resumeVerifiedCampaign } from "./direct-resume.js";
import { reallocateVerifiedPortfolio } from "./portfolio-reallocation.js";

function row(db, businessId, actionId) {
  const value = db
    .prepare("SELECT * FROM optimizer_actions WHERE business_id=? AND id=?")
    .get(businessId, actionId);
  if (!value) throw new AppError(404, "Решение Budget Guard не найдено.");
  return value;
}

const view = (value) => ({
  id: value.id,
  changeId: value.change_id,
  action: value.action,
  status: value.status,
  reason: value.reason,
  guard: JSON.parse(value.guard_json),
  createdAt: value.created_at,
  updatedAt: value.updated_at,
});

function finish(db, businessId, actionId, status, reason) {
  return transaction(db, () => {
    const current = row(db, businessId, actionId),
      at = new Date().toISOString();
    if (current.status !== "dispatching")
      throw new AppError(409, "Состояние решения изменилось во время выполнения.");
    db.prepare(
      "UPDATE optimizer_actions SET status=?,reason=?,updated_at=? WHERE id=?",
    ).run(status, reason || current.reason, at, actionId);
    event(db, businessId, {
      kind:
        status === "applied"
          ? "optimizer_action_applied"
          : status === "needs_reconciliation"
            ? "optimizer_action_uncertain"
            : "optimizer_action_not_applied",
      title:
        status === "applied"
          ? "Защитное решение применено"
          : status === "needs_reconciliation"
            ? "Защитное решение требует сверки"
            : "Защитное решение не применено",
      reason: reason || current.reason,
      rule: "budget-guard/executor@1",
      jobId: actionId,
    });
    return view(row(db, businessId, actionId));
  });
}

export function optimizerAction(db, userId, businessId, actionId) {
  requireBusiness(db, userId, businessId);
  return view(row(db, businessId, actionId));
}

export async function executeOptimizerAction(
  db,
  userId,
  businessId,
  actionId,
  client,
  { enabled = false, connectionId = null } = {},
) {
  if (!enabled)
    throw new AppError(409, "Автоматические защитные действия отключены.", "live_gate");
  requireBusiness(db, userId, businessId);
  const current = row(db, businessId, actionId);
  if (["applied", "failed_no_write", "needs_reconciliation"].includes(current.status))
    return view(current);
  if (!['pause_campaign', 'consider_reallocation'].includes(current.action))
    throw new AppError(
      409,
      "Тип защитного действия не поддерживается.",
    );
  transaction(db, () => {
    const latest = row(db, businessId, actionId);
    if (latest.status !== "proposed")
      throw new AppError(409, "Защитное решение уже выполняется.");
    if (
      latest.action === "pause_campaign" &&
      (adLifecycle(db, businessId, latest.change_id).status !== "active")
    )
      throw new AppError(409, "Кампания уже не находится в подтверждённом активном состоянии.");
    db.prepare("UPDATE optimizer_actions SET status='dispatching',updated_at=? WHERE id=?").run(
      new Date().toISOString(),
      actionId,
    );
  });
  if (current.action === "consider_reallocation") {
    const result = await reallocateVerifiedPortfolio(
      db,
      businessId,
      current,
      client,
      connectionId,
    );
    return finish(db, businessId, actionId, result.status, result.reason);
  }
  let result;
  try {
    result = await suspendVerifiedCampaign(
      db,
      userId,
      businessId,
      current.change_id,
      actionId,
      client,
      { enabled: true },
    );
  } catch {
    return finish(
      db,
      businessId,
      actionId,
      "failed_no_write",
      "Проверка перед остановкой не пройдена; внешняя команда не отправлялась.",
    );
  }
  if (result.status === "succeeded") {
    transitionAdLifecycle(db, businessId, "paused", {
      changeId: current.change_id,
      reason: "Budget Guard остановил неэффективную кампанию; состояние подтверждено чтением Direct.",
    });
    return finish(
      db,
      businessId,
      actionId,
      "applied",
      "Неэффективная кампания остановлена и повторно прочитана в Direct.",
    );
  }
  if (result.status === "needs_reconciliation") {
    transitionAdLifecycle(db, businessId, "needs_reconciliation", {
      changeId: current.change_id,
      reason: "Ответ на защитную остановку неоднозначен; повторная запись запрещена до сверки.",
    });
    return finish(
      db,
      businessId,
      actionId,
      "needs_reconciliation",
      "Результат остановки нужно подтвердить чтением Direct; автоматический повтор запрещён.",
    );
  }
  return finish(
    db,
    businessId,
    actionId,
    "failed_no_write",
    "Кампания не изменена: проверка перед записью не пройдена.",
  );
}

export function recoverOptimizerDispatches(db) {
  const at = new Date().toISOString();
  return db
    .prepare(
      `UPDATE optimizer_actions SET status='needs_reconciliation',
       reason='Процесс прервался во время возможной записи; автоматический повтор запрещён.',
       updated_at=? WHERE status='dispatching'`,
    )
    .run(at).changes;
}

export async function rollbackOptimizerAction(
  db,
  userId,
  businessId,
  actionId,
  requestKey,
  client,
  connectionId,
  { enabled = false, spendConfirmed = false } = {},
) {
  if (!enabled)
    throw new AppError(409, "Откат защитного действия отключён.", "live_gate");
  if (!spendConfirmed)
    throw new AppError(400, "Подтвердите, что откат снова разрешит расходы.");
  requireBusiness(db, userId, businessId);
  const current = row(db, businessId, actionId);
  if (current.status === "rolled_back") return view(current);
  if (current.status === "rollback_needs_reconciliation") return view(current);
  if (current.action !== "pause_campaign" || current.status !== "applied")
    throw new AppError(409, "Это защитное действие сейчас нельзя откатить.");
  const lifecycle = adLifecycle(db, businessId, current.change_id);
  if (lifecycle.status !== "paused" || lifecycle.changeId !== current.change_id)
    throw new AppError(409, "Кампания была изменена после защитной остановки.");
  const execution = db
      .prepare("SELECT calls_json FROM direct_executions WHERE change_id=? AND business_id=?")
      .get(current.change_id, businessId),
    change = db
      .prepare("SELECT plan_json FROM direct_changes WHERE id=? AND business_id=?")
      .get(current.change_id, businessId);
  if (!execution || !change)
    throw new AppError(409, "Исходное состояние кампании не найдено.");
  const campaignId = JSON.parse(execution.calls_json).find(
      (item) => item.key === "campaign",
    )?.ids?.[0],
    plan = JSON.parse(change.plan_json);
  const result = await resumeVerifiedCampaign(
    db,
    userId,
    businessId,
    current.change_id,
    requestKey,
    client,
    connectionId,
    {
      enabled: true,
      advertiserConfirmed: true,
      siteConfirmed: true,
      markingConfirmed: true,
      spendConfirmed: true,
      confirmCampaignId: campaignId,
      confirmLimitKopecks: plan.budget,
    },
  );
  const status =
      result.status === "succeeded"
        ? "rolled_back"
        : result.status === "needs_reconciliation"
          ? "rollback_needs_reconciliation"
          : "applied",
    at = new Date().toISOString();
  db.prepare("UPDATE optimizer_actions SET status=?,updated_at=? WHERE id=?").run(
    status,
    at,
    actionId,
  );
  if (status === "rolled_back")
    transitionAdLifecycle(db, businessId, "active", {
      changeId: current.change_id,
      reason: "Пользователь отменил защитную остановку; запуск подтверждён чтением Direct.",
    });
  else if (status === "rollback_needs_reconciliation")
    transitionAdLifecycle(db, businessId, "needs_reconciliation", {
      changeId: current.change_id,
      reason: "Результат отката неоднозначен; повторный запуск запрещён до сверки.",
    });
  event(db, businessId, {
    kind:
      status === "rolled_back"
        ? "optimizer_action_rolled_back"
        : status === "rollback_needs_reconciliation"
          ? "optimizer_rollback_uncertain"
          : "optimizer_rollback_not_applied",
    title:
      status === "rolled_back"
        ? "Защитная остановка отменена"
        : status === "rollback_needs_reconciliation"
          ? "Откат требует сверки"
          : "Откат не применён",
    reason:
      status === "rolled_back"
        ? "Показы возобновлены с прежним периодным лимитом; состояние подтверждено Direct."
        : "Кампания не считается возобновлённой без подтверждения Direct.",
    rule: "budget-guard/rollback@1",
    jobId: actionId,
  });
  return view(row(db, businessId, actionId));
}
