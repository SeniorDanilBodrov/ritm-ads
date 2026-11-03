import { randomUUID } from "node:crypto";
import { adLifecycle } from "./ad-lifecycle.js";

const defaultPolicy = Object.freeze({
  minClicks: 100,
  minSpendTargetMultiple: 3,
  pauseCpaTargetMultiple: 1.5,
  efficientCpaTargetMultiple: 0.8,
  minGoalsForReallocation: 10,
});

export function optimizerActions(db, businessId) {
  return db
    .prepare(
      "SELECT id,change_id AS changeId,review_id AS reviewId,action,status,reason,guard_json AS guardJson,created_at AS createdAt FROM optimizer_actions WHERE business_id=? ORDER BY rowid DESC LIMIT 20",
    )
    .all(businessId)
    .map(({ guardJson, ...row }) => ({ ...row, guard: JSON.parse(guardJson) }));
}

function observedPerformance(review, policy) {
  const source = review?.source;
  if (
    review?.status !== "observed" ||
    review?.executed !== false ||
    source?.attribution !== "direct_campaign_last_significant" ||
    !Number.isSafeInteger(source?.direct?.spentKopecks) ||
    !Number.isSafeInteger(source?.direct?.clicks) ||
    !Number.isSafeInteger(source?.campaignGoalReaches) ||
    source.direct.clicks < policy.minClicks
  )
    return null;
  return {
    spentKopecks: source.direct.spentKopecks,
    clicks: source.direct.clicks,
    goals: source.campaignGoalReaches,
    cpaKopecks: source.campaignGoalReaches
      ? Math.round(source.direct.spentKopecks / source.campaignGoalReaches)
      : null,
    snapshotId: source.direct.snapshotId,
  };
}

function reallocationDonor(db, businessId, recipientChangeId, recipientPlan, recipient, targetCpa, policy) {
  const rows = db
    .prepare(
      `SELECT cl.change_id,dc.plan_json,cba.limit_kopecks,de.calls_json,de.connection_id,sr.result_json
       FROM campaign_ad_lifecycle cl
       JOIN direct_changes dc ON dc.id=cl.change_id AND dc.business_id=cl.business_id
       LEFT JOIN campaign_budget_allocations cba
         ON cba.business_id=cl.business_id AND cba.change_id=cl.change_id
       JOIN direct_executions de ON de.change_id=cl.change_id AND de.business_id=cl.business_id
       JOIN direct_shadow_reviews sr ON sr.rowid=(
         SELECT rowid FROM direct_shadow_reviews
          WHERE business_id=cl.business_id AND change_id=cl.change_id
          ORDER BY created_at DESC,rowid DESC LIMIT 1
       )
       WHERE cl.business_id=? AND cl.change_id<>? AND cl.status='active'
         AND de.status='succeeded'`,
    )
    .all(businessId, recipientChangeId);
  const choices = rows
    .map((row) => {
      const plan = JSON.parse(row.plan_json), review = JSON.parse(row.result_json);
      const limitKopecks = row.limit_kopecks ?? plan.budget;
      const performance = observedPerformance(review, policy);
      const campaignId = JSON.parse(row.calls_json).find((call) => call.key === "campaign")?.ids?.[0];
      if (
        !performance ||
        !Number.isSafeInteger(campaignId) ||
        plan.login !== recipientPlan.login ||
        plan.counterId !== recipientPlan.counterId ||
        plan.goalId !== recipientPlan.goalId ||
        performance.cpaKopecks === null ||
        performance.cpaKopecks <= recipient.cpaKopecks ||
        performance.cpaKopecks > targetCpa * policy.pauseCpaTargetMultiple ||
        !Number.isSafeInteger(limitKopecks) ||
        limitKopecks <= 0 ||
        performance.spentKopecks >= limitKopecks
      )
        return null;
      return {
        changeId: row.change_id,
        campaignId,
        connectionId: row.connection_id,
        plan,
        performance,
        limitKopecks,
        freeKopecks: limitKopecks - performance.spentKopecks,
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.performance.cpaKopecks - a.performance.cpaKopecks);
  return choices[0] || null;
}

function hasUnresolvedAction(db, businessId, changeId) {
  return !!db
    .prepare(
      `SELECT 1 FROM optimizer_actions
       WHERE business_id=? AND status IN ('proposed','dispatching','needs_reconciliation')
         AND (change_id=? OR json_extract(guard_json,'$.reallocation.donor.changeId')=?)
       LIMIT 1`,
    )
    .get(businessId, changeId, changeId);
}

export function queueOptimizerAction(
  db,
  businessId,
  changeId,
  review,
  targetCpa,
  rawPolicy = {},
) {
  const policy = { ...defaultPolicy, ...rawPolicy };
  const performance = observedPerformance(review, policy);
  if (
    adLifecycle(db, businessId, changeId).status !== "active" ||
    !performance ||
    !Number.isSafeInteger(targetCpa) ||
    targetCpa <= 0 ||
    performance.spentKopecks < targetCpa * policy.minSpendTargetMultiple
  )
    return null;
  const goals = performance.goals,
    cpa = performance.cpaKopecks,
    action =
      !goals || cpa > targetCpa * policy.pauseCpaTargetMultiple
        ? "pause_campaign"
        : cpa < targetCpa * policy.efficientCpaTargetMultiple &&
            goals >= policy.minGoalsForReallocation
          ? "consider_reallocation"
          : null;
  if (!action) return null;
  const alreadyQueued = db
    .prepare("SELECT id,action,status FROM optimizer_actions WHERE review_id=?")
    .get(review.id);
  if (alreadyQueued) return alreadyQueued;
  if (hasUnresolvedAction(db, businessId, changeId)) return null;
  const recipientPlanRow = db
    .prepare(
      `SELECT dc.plan_json,cba.limit_kopecks FROM direct_changes dc
       LEFT JOIN campaign_budget_allocations cba ON cba.business_id=dc.business_id AND cba.change_id=dc.id
       WHERE dc.id=? AND dc.business_id=?`,
    )
    .get(changeId, businessId);
  const recipientExecution = db
    .prepare("SELECT calls_json,connection_id FROM direct_executions WHERE change_id=? AND business_id=? AND status='succeeded'")
    .get(changeId, businessId);
  const recipientPlan = recipientPlanRow && JSON.parse(recipientPlanRow.plan_json);
  const recipientCampaignId = recipientExecution && JSON.parse(recipientExecution.calls_json).find(
    (call) => call.key === "campaign",
  )?.ids?.[0];
  const donor =
    action === "consider_reallocation" && recipientPlan && Number.isSafeInteger(recipientCampaignId)
      ? reallocationDonor(
          db,
          businessId,
          changeId,
          recipientPlan,
          performance,
          targetCpa,
          policy,
        )
      : null;
  if (action === "consider_reallocation" && !donor) return null;
  if (donor && hasUnresolvedAction(db, businessId, donor.changeId)) return null;
  const guard = {
    totalBudgetIncreaseAllowed: false,
    sourceSnapshotId: performance.snapshotId,
    spentKopecks: performance.spentKopecks,
    goals,
    cpaKopecks: cpa,
    targetCpaKopecks: targetCpa,
    policy,
  };
  if (donor)
    guard.reallocation = {
      recipient: {
        changeId,
        campaignId: recipientCampaignId,
        connectionId: recipientExecution.connection_id,
        previousLimitKopecks: recipientPlanRow.limit_kopecks ?? recipientPlan.budget,
        snapshotId: performance.snapshotId,
        cpaKopecks: performance.cpaKopecks,
      },
      donor: {
        changeId: donor.changeId,
        campaignId: donor.campaignId,
        connectionId: donor.connectionId,
        previousLimitKopecks: donor.limitKopecks,
        snapshotId: donor.performance.snapshotId,
        cpaKopecks: donor.performance.cpaKopecks,
        spentKopecks: donor.performance.spentKopecks,
      },
      transferKopecks: donor.freeKopecks,
    };
  const id = randomUUID(), at = new Date().toISOString();
  db.prepare(
    `INSERT OR IGNORE INTO optimizer_actions
     (id,business_id,change_id,review_id,action,status,reason,guard_json,created_at,updated_at)
     VALUES(?,?,?,?,?,'proposed',?,?,?,?)`,
  ).run(id,businessId,changeId,review.id,action,action === "pause_campaign" ? "Стоимость обращения устойчиво выше цели; предлагается безопасная остановка." : "Результат устойчиво лучше цели; свободный остаток менее результативной кампании подготовлен к переносу без увеличения общего бюджета.",JSON.stringify(guard),at,at);
  return db.prepare("SELECT id,action,status FROM optimizer_actions WHERE review_id=?").get(review.id);
}
