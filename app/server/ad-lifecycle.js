import { AppError, event, transaction } from "./db.js";

const allowed = {
  draft: new Set(["validating", "ready"]),
  validating: new Set(["ready", "blocked"]),
  ready: new Set(["validating", "creating", "blocked"]),
  creating: new Set(["paused", "needs_reconciliation", "blocked"]),
  moderation: new Set(["active", "paused", "blocked", "needs_reconciliation"]),
  active: new Set(["paused", "completed", "needs_reconciliation"]),
  paused: new Set([
    "validating",
    "moderation",
    "active",
    "completed",
    "needs_reconciliation",
    "blocked",
  ]),
  blocked: new Set(["validating", "ready"]),
  needs_reconciliation: new Set(["paused", "blocked", "ready"]),
  completed: new Set([]),
};

const empty = {
  status: "draft",
  changeId: null,
  reason: "Рекламный план ещё не прошёл проверку.",
  updatedAt: null,
};

export function adLifecycle(db, businessId, changeId = null) {
  const scoped = changeId
    ? db
        .prepare(
          "SELECT status,change_id AS changeId,reason,updated_at AS updatedAt FROM campaign_ad_lifecycle WHERE business_id=? AND change_id=?",
        )
        .get(businessId, changeId)
    : db
        .prepare(
          "SELECT status,change_id AS changeId,reason,updated_at AS updatedAt FROM campaign_ad_lifecycle WHERE business_id=? ORDER BY updated_at DESC,rowid DESC LIMIT 1",
        )
        .get(businessId);
  return (
    scoped ||
    (!changeId &&
      db
        .prepare(
          "SELECT status,change_id AS changeId,reason,updated_at AS updatedAt FROM business_ad_lifecycle WHERE business_id=?",
        )
        .get(businessId)) ||
    empty
  );
}

export function adLifecycles(db, businessId) {
  return db
    .prepare(
      "SELECT status,change_id AS changeId,reason,updated_at AS updatedAt FROM campaign_ad_lifecycle WHERE business_id=? ORDER BY updated_at DESC,rowid DESC",
    )
    .all(businessId);
}

export function transitionAdLifecycle(
  db,
  businessId,
  status,
  { changeId = null, reason } = {},
) {
  if (!allowed[status]) throw new AppError(400, "Неизвестное состояние рекламы.");
  return transaction(db, () => {
    const current = adLifecycle(db, businessId, changeId);
    if (current.status !== status && !allowed[current.status]?.has(status))
      throw new AppError(
        409,
        "Реклама находится в другом состоянии. Обновите страницу и повторите проверку.",
        "lifecycle_conflict",
      );
    const updatedAt = new Date().toISOString();
    const currentChangeId = changeId || current.changeId;
    if (!currentChangeId)
      throw new AppError(400, "Для изменения состояния нужен план кампании.");
    db.prepare(
      `INSERT INTO campaign_ad_lifecycle(business_id,change_id,status,reason,updated_at)
       VALUES(?,?,?,?,?) ON CONFLICT(business_id,change_id) DO UPDATE SET
       status=excluded.status,reason=excluded.reason,updated_at=excluded.updated_at`,
    ).run(
      businessId,
      currentChangeId,
      status,
      reason || current.reason,
      updatedAt,
    );
    db.prepare(
      `INSERT INTO business_ad_lifecycle(business_id,status,change_id,reason,updated_at)
       VALUES(?,?,?,?,?) ON CONFLICT(business_id) DO UPDATE SET
       status=excluded.status,change_id=excluded.change_id,
       reason=excluded.reason,updated_at=excluded.updated_at`,
    ).run(
      businessId,
      status,
      currentChangeId,
      reason || current.reason,
      updatedAt,
    );
    if (current.status !== status)
      event(db, businessId, {
        kind: "ad_lifecycle",
        title: `Состояние рекламы: ${status}`,
        reason: reason || current.reason,
        rule: "ad-lifecycle/1",
        before: { status: current.status },
        after: { status },
      });
    return { status, changeId: currentChangeId, reason, updatedAt };
  });
}
