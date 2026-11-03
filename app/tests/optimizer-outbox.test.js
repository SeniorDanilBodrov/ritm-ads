import { randomUUID } from "node:crypto";
import { test } from "node:test";
import assert from "node:assert/strict";
import { openDatabase } from "../server/db.js";
import { transitionAdLifecycle } from "../server/ad-lifecycle.js";
import {
  optimizerActions,
  queueOptimizerAction,
} from "../server/optimizer-outbox.js";

const targetCpa = 45_000;

function fixture({ active = true } = {}) {
  const db = openDatabase(":memory:"),
    userId = randomUUID(),
    businessId = randomUUID(),
    changeId = randomUUID();
  db.prepare("INSERT INTO users VALUES(?,?,?,?)").run(
    userId,
    `google:${userId}`,
    "Tester",
    new Date().toISOString(),
  );
  db.prepare("INSERT INTO businesses VALUES(?,?,?,1)").run(
    businessId,
    userId,
    JSON.stringify({ mode: "live", targetCpa, budget: 6_000_000, counterId: "123", goalId: "456" }),
  );
  installCampaign(db, businessId, changeId, { active, campaignId: 77 });
  return { db, businessId, changeId };
}

function installCampaign(db, businessId, changeId, { active = true, campaignId, budget = 3_000_000 } = {}) {
  const at = new Date().toISOString();
  const plan = {
    login: "client", campaignName: `Кампания ${campaignId}`, budget,
    periodStart: "2026-11-01", periodEnd: "2026-11-30", counterId: "123", goalId: "456",
  };
  db.prepare("INSERT INTO jobs(id,business_id,kind,status,available_at,payload) VALUES(?,?,?,'succeeded',?,?)").run(
    changeId, businessId, "direct_dry_run", Date.now(), "{}",
  );
  db.prepare("INSERT INTO direct_changes(id,business_id,idempotency_key,mode,plan_json,commands_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)").run(
    changeId, businessId, randomUUID(), "dry-run", JSON.stringify(plan), "[]", at, at,
  );
  db.prepare("INSERT INTO direct_executions(change_id,business_id,connection_id,plan_fingerprint,status,inflight_key,suspend_verified,calls_json,started_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)").run(
    changeId, businessId, "connection", "fingerprint", "succeeded", null, 1,
    JSON.stringify([{ key: "campaign", ids: [campaignId] }]), at, at,
  );
  if (active) {
    transitionAdLifecycle(db, businessId, "ready", { changeId });
    transitionAdLifecycle(db, businessId, "creating", { changeId });
    transitionAdLifecycle(db, businessId, "paused", { changeId });
    transitionAdLifecycle(db, businessId, "moderation", { changeId });
    transitionAdLifecycle(db, businessId, "active", { changeId });
  }
  return plan;
}

function storeReview(db, businessId, changeId, value) {
  db.prepare("INSERT INTO direct_shadow_reviews(id,business_id,change_id,connection_id,request_key,created_at,result_json) VALUES(?,?,?,?,?,?,?)").run(
    randomUUID(), businessId, changeId, "connection", randomUUID(), new Date().toISOString(), JSON.stringify(value),
  );
}

function review({
  spentKopecks = 180_000,
  clicks = 150,
  goals = 0,
  attribution = "direct_campaign_last_significant",
} = {}) {
  return {
    id: randomUUID(),
    status: "observed",
    executed: false,
    source: {
      attribution,
      campaignGoalReaches: goals,
      direct: { snapshotId: randomUUID(), spentKopecks, clicks },
    },
  };
}

test("optimizer does not queue an action before the campaign is active", () => {
  const { db, businessId, changeId } = fixture({ active: false });
  assert.equal(
    queueOptimizerAction(db, businessId, changeId, review(), targetCpa),
    null,
  );
  assert.deepEqual(optimizerActions(db, businessId), []);
  db.close();
});

test("optimizer proposes a pause only after a mature exact-attribution sample", () => {
  const { db, businessId, changeId } = fixture();
  const result = queueOptimizerAction(
    db,
    businessId,
    changeId,
    review(),
    targetCpa,
  );
  assert.equal(result.action, "pause_campaign");
  assert.equal(result.status, "proposed");
  const [action] = optimizerActions(db, businessId);
  assert.equal(action.guard.totalBudgetIncreaseAllowed, false);
  assert.equal(action.guard.goals, 0);
  assert.equal(action.guard.targetCpaKopecks, targetCpa);
  db.close();
});

test("optimizer queue is idempotent for the same shadow review", () => {
  const { db, businessId, changeId } = fixture();
  const sameReview = review();
  const first = queueOptimizerAction(
    db,
    businessId,
    changeId,
    sameReview,
    targetCpa,
  );
  const second = queueOptimizerAction(
    db,
    businessId,
    changeId,
    sameReview,
    targetCpa,
  );
  assert.equal(second.id, first.id);
  assert.equal(optimizerActions(db, businessId).length, 1);
  db.close();
});

test("optimizer prepares an exact transfer from a weaker active campaign without increasing the portfolio", () => {
  const { db, businessId, changeId } = fixture();
  const donorChangeId = randomUUID();
  installCampaign(db, businessId, donorChangeId, { campaignId: 88 });
  storeReview(
    db,
    businessId,
    donorChangeId,
    review({ spentKopecks: 180_000, clicks: 250, goals: 4 }),
  );
  const result = queueOptimizerAction(
    db,
    businessId,
    changeId,
    review({ spentKopecks: 300_000, clicks: 400, goals: 10 }),
    targetCpa,
  );
  assert.equal(result.action, "consider_reallocation");
  const [action] = optimizerActions(db, businessId);
  assert.equal(action.guard.cpaKopecks, 30_000);
  assert.equal(action.guard.totalBudgetIncreaseAllowed, false);
  assert.equal(action.guard.reallocation.donor.changeId, donorChangeId);
  assert.equal(action.guard.reallocation.donor.campaignId, 88);
  assert.equal(action.guard.reallocation.recipient.campaignId, 77);
  assert.equal(action.guard.reallocation.transferKopecks, 2_820_000);
  db.close();
});

test("optimizer rejects weak, unattributed, and borderline evidence", () => {
  const { db, businessId, changeId } = fixture();
  const candidates = [
    review({ spentKopecks: 180_000, clicks: 99, goals: 0 }),
    review({
      spentKopecks: 180_000,
      clicks: 150,
      goals: 0,
      attribution: "sitewide_last_significant",
    }),
    review({ spentKopecks: 315_000, clicks: 150, goals: 5 }),
  ];
  for (const candidate of candidates)
    assert.equal(
      queueOptimizerAction(
        db,
        businessId,
        changeId,
        candidate,
        targetCpa,
      ),
      null,
    );
  assert.deepEqual(optimizerActions(db, businessId), []);
  db.close();
});

test("optimizer thresholds are configurable without changing decision code", () => {
  const { db, businessId, changeId } = fixture();
  const candidate = review({ spentKopecks: 180_000, clicks: 150, goals: 0 });
  assert.equal(
    queueOptimizerAction(
      db,
      businessId,
      changeId,
      candidate,
      targetCpa,
      { minClicks: 200 },
    ),
    null,
  );
  const queued = queueOptimizerAction(
    db,
    businessId,
    changeId,
    { ...candidate, id: randomUUID() },
    targetCpa,
    { minClicks: 120, minSpendTargetMultiple: 2 },
  );
  assert.equal(queued.action, "pause_campaign");
  const [action] = optimizerActions(db, businessId);
  assert.equal(action.guard.policy.minClicks, 120);
  assert.equal(action.guard.policy.minSpendTargetMultiple, 2);
  db.close();
});
