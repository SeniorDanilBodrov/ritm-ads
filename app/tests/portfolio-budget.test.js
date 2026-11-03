import { randomUUID } from "node:crypto";
import { test } from "node:test";
import assert from "node:assert/strict";
import { AppError, openDatabase } from "../server/db.js";
import { assertPortfolioBudget } from "../server/direct.js";
import { transitionAdLifecycle } from "../server/ad-lifecycle.js";

function campaign(db, businessId, budget) {
  const changeId = randomUUID(), at = new Date().toISOString();
  db.prepare("INSERT INTO jobs(id,business_id,kind,status,available_at,payload) VALUES(?,?,?,'succeeded',?,?)").run(
    changeId, businessId, "direct_dry_run", Date.now(), "{}",
  );
  const change = { id: changeId, plan: { budget } };
  db.prepare("INSERT INTO direct_changes(id,business_id,idempotency_key,mode,plan_json,commands_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)").run(
    changeId, businessId, randomUUID(), "dry-run", JSON.stringify(change.plan), "[]", at, at,
  );
  return change;
}

function fixture() {
  const db = openDatabase(":memory:"), userId = randomUUID(), businessId = randomUUID(), at = new Date().toISOString();
  db.prepare("INSERT INTO users VALUES(?,?,?,?)").run(userId, `google:${userId}`, "Tester", at);
  const business = { id: businessId, state: { budget: 300_000 } };
  db.prepare("INSERT INTO businesses VALUES(?,?,?,1)").run(businessId, userId, JSON.stringify(business.state));
  return { db, business };
}

test("portfolio budget admits several campaigns only within the shared business limit", () => {
  const { db, business } = fixture();
  const active = campaign(db, business.id, 200_000), next = campaign(db, business.id, 100_000);
  transitionAdLifecycle(db, business.id, "ready", { changeId: active.id });
  transitionAdLifecycle(db, business.id, "creating", { changeId: active.id });
  transitionAdLifecycle(db, business.id, "paused", { changeId: active.id });
  transitionAdLifecycle(db, business.id, "moderation", { changeId: active.id });
  transitionAdLifecycle(db, business.id, "active", { changeId: active.id });
  assert.deepEqual(assertPortfolioBudget(db, business, next), {
    budgetKopecks: 300_000,
    reservedKopecks: 200_000,
    availableKopecks: 100_000,
  });
  db.close();
});

test("portfolio budget rejects a second campaign that would exceed the shared limit", () => {
  const { db, business } = fixture();
  const active = campaign(db, business.id, 200_000), next = campaign(db, business.id, 100_001);
  transitionAdLifecycle(db, business.id, "ready", { changeId: active.id });
  transitionAdLifecycle(db, business.id, "creating", { changeId: active.id });
  transitionAdLifecycle(db, business.id, "paused", { changeId: active.id });
  transitionAdLifecycle(db, business.id, "moderation", { changeId: active.id });
  transitionAdLifecycle(db, business.id, "active", { changeId: active.id });
  assert.throws(
    () => assertPortfolioBudget(db, business, next),
    (error) => error instanceof AppError && error.code === "portfolio_budget_exceeded",
  );
  db.close();
});
