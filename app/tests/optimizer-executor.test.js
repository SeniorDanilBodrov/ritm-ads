import { createHash, randomUUID } from "node:crypto";
import { test } from "node:test";
import assert from "node:assert/strict";
import { openDatabase } from "../server/db.js";
import { adLifecycle, transitionAdLifecycle } from "../server/ad-lifecycle.js";
import { queueOptimizerAction } from "../server/optimizer-outbox.js";
import {
  executeOptimizerAction,
  optimizerAction,
  recoverOptimizerDispatches,
  rollbackOptimizerAction,
} from "../server/optimizer-executor.js";
import { runOptimizerCycle } from "../server/live-data-worker.js";

const targetCpa = 45_000;
const moscowDate = (now) =>
  new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Europe/Moscow",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(now));

function remoteBudget(id, plan, limitKopecks) {
  return {
    Campaigns: [
      {
        Id: id,
        State: "ON",
        Status: "ACCEPTED",
        Type: "TEXT_CAMPAIGN",
        TextCampaign: {
          BiddingStrategy: {
            Search: {
              BiddingStrategyType: "WB_MAXIMUM_CLICKS",
              WbMaximumClicks: {
                CustomPeriodBudget: {
                  SpendLimit: limitKopecks * 10_000,
                  StartDate: plan.periodStart,
                  EndDate: plan.periodEnd,
                  AutoContinue: "NO",
                },
              },
            },
            Network: { BiddingStrategyType: "SERVING_OFF" },
          },
        },
      },
    ],
  };
}

function fixture({ action = "pause" } = {}) {
  const db = openDatabase(":memory:"),
    userId = randomUUID(),
    businessId = randomUUID(),
    changeId = randomUUID(),
    connectionId = randomUUID(),
    at = new Date().toISOString();
  db.prepare("INSERT INTO users VALUES(?,?,?,?)").run(
    userId,
    `google:${userId}`,
    "Tester",
    at,
  );
  db.prepare("INSERT INTO businesses VALUES(?,?,?,1)").run(
    businessId,
    userId,
    JSON.stringify({
      mode: "live",
      targetCpa,
      budget: 6_000_000,
      website: "https://example.test/",
      counterId: "123",
      goalId: "456",
    }),
  );
  db.prepare("INSERT INTO connections VALUES(?,?,?,?)").run(
    businessId,
    "yandex",
    "encrypted",
    JSON.stringify({ connectionId, sandbox: false }),
  );
  const now = Date.now(),
    periodStart = moscowDate(now),
    periodEnd = moscowDate(now + 13 * 86400000),
    plan = {
      login: "client",
      campaignName: "Тест",
      periodStart,
      periodEnd,
      budget: 3_000_000,
      website: "https://example.test/",
      counterId: "123",
      goalId: "456",
      ads: [
        {
          title: "Студия рядом",
          text: "Удобная запись на услугу",
          href: "https://example.test/",
        },
      ],
      keywords: ["студия рядом", "записаться в студию"],
    };
  db.prepare(
    "INSERT INTO jobs(id,business_id,kind,status,available_at,payload) VALUES(?,?,?,'succeeded',?,?)",
  ).run(changeId, businessId, "direct_dry_run", Date.now(), "{}");
  db.prepare(
    `INSERT INTO direct_changes
    (id,business_id,idempotency_key,mode,plan_json,commands_json,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?)`,
  ).run(
    changeId,
    businessId,
    randomUUID(),
    "dry-run",
    JSON.stringify(plan),
    "[]",
    at,
    at,
  );
  db.prepare(
    `INSERT INTO direct_executions
    (change_id,business_id,connection_id,plan_fingerprint,status,inflight_key,
    suspend_verified,calls_json,started_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    changeId,
    businessId,
    connectionId,
    "fingerprint",
    "succeeded",
    null,
    1,
    JSON.stringify([
      { key: "campaign", ids: [77] },
      { key: "suspend", ids: [77], holdState: "SUSPENDED" },
      { key: "adgroup", ids: [202] },
      { key: "keywords", ids: [301, 302] },
      { key: "ads", ids: [401] },
    ]),
    at,
    at,
  );
  transitionAdLifecycle(db, businessId, "ready", { changeId });
  transitionAdLifecycle(db, businessId, "creating", { changeId });
  transitionAdLifecycle(db, businessId, "paused", { changeId });
  transitionAdLifecycle(db, businessId, "moderation", { changeId });
  transitionAdLifecycle(db, businessId, "active", { changeId });
  let donorChangeId = null;
  if (action === "reallocate") {
    donorChangeId = randomUUID();
    const donorPlan = { ...plan, campaignName: "Донор", budget: 3_000_000 };
    db.prepare(
      "INSERT INTO jobs(id,business_id,kind,status,available_at,payload) VALUES(?,?,?,'succeeded',?,?)",
    ).run(donorChangeId, businessId, "direct_dry_run", Date.now(), "{}");
    db.prepare(
      `INSERT INTO direct_changes
      (id,business_id,idempotency_key,mode,plan_json,commands_json,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?)`,
    ).run(
      donorChangeId,
      businessId,
      randomUUID(),
      "dry-run",
      JSON.stringify(donorPlan),
      "[]",
      at,
      at,
    );
    db.prepare(
      `INSERT INTO direct_executions
      (change_id,business_id,connection_id,plan_fingerprint,status,inflight_key,
      suspend_verified,calls_json,started_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      donorChangeId,
      businessId,
      connectionId,
      "donor-fingerprint",
      "succeeded",
      null,
      1,
      JSON.stringify([{ key: "campaign", ids: [88] }]),
      at,
      at,
    );
    transitionAdLifecycle(db, businessId, "ready", { changeId: donorChangeId });
    transitionAdLifecycle(db, businessId, "creating", { changeId: donorChangeId });
    transitionAdLifecycle(db, businessId, "paused", { changeId: donorChangeId });
    transitionAdLifecycle(db, businessId, "moderation", { changeId: donorChangeId });
    transitionAdLifecycle(db, businessId, "active", { changeId: donorChangeId });
    const donorReview = {
      id: randomUUID(),
      status: "observed",
      executed: false,
      source: {
        attribution: "direct_campaign_last_significant",
        campaignGoalReaches: 4,
        direct: { snapshotId: randomUUID(), spentKopecks: 180_000, clicks: 250 },
      },
    };
    db.prepare(
      `INSERT INTO direct_shadow_reviews
      (id,business_id,change_id,connection_id,request_key,created_at,result_json)
      VALUES(?,?,?,?,?,?,?)`,
    ).run(
      donorReview.id,
      businessId,
      donorChangeId,
      connectionId,
      randomUUID(),
      at,
      JSON.stringify(donorReview),
    );
  }
  const review = {
    id: randomUUID(),
    status: "observed",
    executed: false,
    source: {
      attribution: "direct_campaign_last_significant",
      campaignGoalReaches: action === "pause" ? 0 : 10,
      direct: {
        snapshotId: randomUUID(),
        spentKopecks: action === "pause" ? 180_000 : 300_000,
        clicks: action === "pause" ? 150 : 400,
      },
    },
  };
  const queued = queueOptimizerAction(
    db,
    businessId,
    changeId,
    review,
    targetCpa,
  );
  return {
    db,
    userId,
    businessId,
    changeId,
    connectionId,
    plan,
    donorChangeId,
    actionId: queued.id,
  };
}

test("Budget Guard stops one active campaign once and confirms Direct read-back", async () => {
  const { db, userId, businessId, actionId } = fixture();
  let state = "ON",
    writes = 0;
  const client = {
    campaignsByIds: async () => ({
      Campaigns: [{ Id: 77, State: state, Status: "ACCEPTED" }],
    }),
    suspendCampaigns: async () => {
      writes += 1;
      state = "SUSPENDED";
      return { SuspendResults: [{ Id: 77 }] };
    },
  };
  const applied = await executeOptimizerAction(
    db,
    userId,
    businessId,
    actionId,
    client,
    { enabled: true },
  );
  assert.equal(applied.status, "applied");
  assert.equal(writes, 1);
  assert.equal(adLifecycle(db, businessId).status, "paused");
  const retry = await executeOptimizerAction(
    db,
    userId,
    businessId,
    actionId,
    client,
    { enabled: true },
  );
  assert.equal(retry.status, "applied");
  assert.equal(writes, 1);
  db.close();
});

test("Budget Guard never repeats an uncertain suspend", async () => {
  const { db, userId, businessId, actionId } = fixture();
  let writes = 0;
  const client = {
    campaignsByIds: async () => ({
      Campaigns: [{ Id: 77, State: "ON", Status: "ACCEPTED" }],
    }),
    suspendCampaigns: async () => {
      writes += 1;
      throw new Error("lost response");
    },
  };
  const uncertain = await executeOptimizerAction(
    db,
    userId,
    businessId,
    actionId,
    client,
    { enabled: true },
  );
  assert.equal(uncertain.status, "needs_reconciliation");
  assert.equal(adLifecycle(db, businessId).status, "needs_reconciliation");
  await executeOptimizerAction(db, userId, businessId, actionId, client, {
    enabled: true,
  });
  assert.equal(writes, 1);
  db.close();
});

test("Budget Guard transfers only the verified donor remainder and keeps the portfolio total unchanged", async () => {
  const { db, userId, businessId, connectionId, plan, actionId } = fixture({
    action: "reallocate",
  });
  const limits = new Map([[77, 3_000_000], [88, 3_000_000]]), writes = [];
  const client = {
    campaignBudgetById: async (id) => remoteBudget(id, plan, limits.get(id)),
    updateTextCampaignPeriodBudget: async (id, value) => {
      writes.push({ id, value });
      limits.set(id, value.spendLimitKopecks);
      return { UpdateResults: [{ Id: id }] };
    },
  };
  const result = await executeOptimizerAction(
    db,
    userId,
    businessId,
    actionId,
    client,
    { enabled: true, connectionId },
  );
  assert.equal(result.status, "applied");
  assert.deepEqual(writes.map((item) => item.id), [88, 77]);
  assert.equal(limits.get(88), 180_000);
  assert.equal(limits.get(77), 5_820_000);
  assert.equal(limits.get(77) + limits.get(88), 6_000_000);
  db.close();
});

test("Budget Guard never retries a transfer after the donor limit may have changed", async () => {
  const { db, userId, businessId, connectionId, plan, actionId } = fixture({
    action: "reallocate",
  });
  const limits = new Map([[77, 3_000_000], [88, 3_000_000]]);
  let writes = 0;
  const client = {
    campaignBudgetById: async (id) => remoteBudget(id, plan, limits.get(id)),
    updateTextCampaignPeriodBudget: async (id, value) => {
      writes += 1;
      if (id === 88) {
        limits.set(id, value.spendLimitKopecks);
        return { UpdateResults: [{ Id: id }] };
      }
      throw new Error("connection lost after donor confirmation");
    },
  };
  const uncertain = await executeOptimizerAction(
    db,
    userId,
    businessId,
    actionId,
    client,
    { enabled: true, connectionId },
  );
  assert.equal(uncertain.status, "needs_reconciliation");
  await executeOptimizerAction(db, userId, businessId, actionId, client, {
    enabled: true,
    connectionId,
  });
  assert.equal(writes, 2);
  db.close();
});

test("restart fences an in-flight optimizer write instead of retrying it", () => {
  const { db, userId, businessId, actionId } = fixture();
  db.prepare("UPDATE optimizer_actions SET status='dispatching' WHERE id=?").run(
    actionId,
  );
  assert.equal(recoverOptimizerDispatches(db), 1);
  assert.equal(
    optimizerAction(db, userId, businessId, actionId).status,
    "needs_reconciliation",
  );
  db.close();
});

test("user rollback rechecks the campaign and restores the previous active state", async () => {
  const { db, userId, businessId, connectionId, plan, actionId } = fixture();
  let state = "ON",
    pauseWrites = 0,
    resumeWrites = 0;
  const baseClient = {
    campaignsByIds: async () => ({
      Campaigns: [{ Id: 77, State: state, Status: "ACCEPTED" }],
    }),
    suspendCampaigns: async () => {
      pauseWrites += 1;
      state = "SUSPENDED";
      return { SuspendResults: [{ Id: 77 }] };
    },
  };
  await executeOptimizerAction(
    db,
    userId,
    businessId,
    actionId,
    baseClient,
    { enabled: true },
  );
  const signature = createHash("sha256").update(connectionId).digest("hex"),
    reportJobId = randomUUID(),
    reportAt = Date.now();
  db.prepare(
    `INSERT INTO jobs(id,business_id,kind,status,available_at,payload)
     VALUES(?,?,'report_sync','succeeded',?,?)`,
  ).run(
    reportJobId,
    businessId,
    reportAt,
    JSON.stringify({ signature }),
  );
  db.prepare(
    `INSERT INTO report_snapshots
    (id,business_id,job_id,scope,source,login,date_from,date_to,currency,include_vat,
     received_at,raw_hash,raw_tsv,rows_json,totals_json,previous_id,comparison_json)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    randomUUID(),
    businessId,
    reportJobId,
    "scope",
    "yandex",
    plan.login,
    plan.periodStart,
    plan.periodStart,
    "RUB",
    1,
    new Date(reportAt).toISOString(),
    "hash",
    "tsv",
    "[]",
    "{}",
    null,
    "{}",
  );
  const client = {
    ...baseClient,
    campaignBudgetById: async () => ({
      Campaigns: [
        {
          Id: 77,
          Name: plan.campaignName,
          Currency: "RUB",
          State: state,
          Status: "ACCEPTED",
          StatusPayment: "ALLOWED",
          Type: "TEXT_CAMPAIGN",
          TextCampaign: {
            BiddingStrategy: {
              Search: {
                BiddingStrategyType: "WB_MAXIMUM_CLICKS",
                WbMaximumClicks: {
                  CustomPeriodBudget: {
                    SpendLimit: plan.budget * 10_000,
                    StartDate: plan.periodStart,
                    EndDate: plan.periodEnd,
                    AutoContinue: "NO",
                  },
                },
              },
              Network: { BiddingStrategyType: "SERVING_OFF" },
            },
          },
        },
      ],
    }),
    adGroupsByIds: async () => ({ AdGroups: [{ Id: 202, CampaignId: 77 }] }),
    adsByIds: async () => ({
      Ads: [
        {
          Id: 401,
          CampaignId: 77,
          AdGroupId: 202,
          State: "ON",
          Status: "ACCEPTED",
          ResponsiveAd: {
            Titles: [{ Title: plan.ads[0].title }],
            Texts: [{ Text: plan.ads[0].text }],
            Href: plan.ads[0].href,
          },
        },
      ],
    }),
    keywordsByIds: async () => ({
      Keywords: [301, 302].map((Id) => ({
        Id,
        CampaignId: 77,
        AdGroupId: 202,
        State: "ON",
        Status: "ACCEPTED",
      })),
    }),
    advertiserMarkingDetails: async () => ({
      Clients: [
        {
          Type: "CLIENT",
          TinInfo: { TinType: "LEGAL", Tin: "1234567890" },
          ErirAttributes: { Organization: { Name: "Тест" } },
        },
      ],
    }),
    resumeCampaigns: async () => {
      resumeWrites += 1;
      state = "ON";
      return { ResumeResults: [{ Id: 77 }] };
    },
  };
  const rolledBack = await rollbackOptimizerAction(
    db,
    userId,
    businessId,
    actionId,
    randomUUID(),
    client,
    connectionId,
    { enabled: true, spendConfirmed: true },
  );
  assert.equal(
    rolledBack.status,
    "rolled_back",
    JSON.stringify({
      resume: db.prepare("SELECT * FROM direct_resume_actions").all(),
      control: db.prepare("SELECT result_json FROM direct_control_reviews").all(),
      budget: db.prepare("SELECT result_json FROM direct_budget_checks").all(),
    }),
  );
  assert.equal(pauseWrites, 1);
  assert.equal(resumeWrites, 1);
  assert.equal(adLifecycle(db, businessId).status, "active");
  db.close();
});

test("background optimizer applies only a queued protective pause", async () => {
  const { db, businessId, actionId } = fixture();
  let state = "ON",
    writes = 0,
    receivedLogin = null;
  const result = await runOptimizerCycle(db, {
    connectionRunner: async (_context, action) =>
      action({
        credentials: { access_token: "not-exposed" },
        metadata: { sandbox: false, connectionId: "connection" },
      }),
    directFactory: ({ login }) => {
      receivedLogin = login;
      return {
        campaignsByIds: async () => ({
          Campaigns: [{ Id: 77, State: state, Status: "ACCEPTED" }],
        }),
        suspendCampaigns: async () => {
          writes += 1;
          state = "SUSPENDED";
          return { SuspendResults: [{ Id: 77 }] };
        },
      };
    },
  });
  assert.equal(result.status, "applied");
  assert.equal(receivedLogin, "client");
  assert.equal(writes, 1);
  assert.equal(
    db.prepare("SELECT status FROM optimizer_actions WHERE id=?").get(actionId)
      .status,
    "applied",
  );
  assert.equal(
    (await runOptimizerCycle(db, {
      connectionRunner: async () => assert.fail("must stay idle"),
    })).status,
    "idle",
  );
  db.close();
});

test("background optimizer applies a verified portfolio reallocation", async () => {
  const { db, actionId, connectionId, plan } = fixture({ action: "reallocate" });
  const limits = new Map([[77, 3_000_000], [88, 3_000_000]]), writes = [];
  const result = await runOptimizerCycle(db, {
    connectionRunner: async (_context, action) =>
      action({
        credentials: { access_token: "not-exposed" },
        metadata: { sandbox: false, connectionId },
      }),
    directFactory: () => ({
      campaignBudgetById: async (id) => remoteBudget(id, plan, limits.get(id)),
      updateTextCampaignPeriodBudget: async (id, value) => {
        writes.push(id);
        limits.set(id, value.spendLimitKopecks);
        return { UpdateResults: [{ Id: id }] };
      },
    }),
  });
  assert.equal(result.status, "applied");
  assert.deepEqual(writes, [88, 77]);
  assert.equal(
    db.prepare("SELECT status FROM optimizer_actions WHERE id=?").get(actionId)
      .status,
    "applied",
  );
  db.close();
});

test("background optimizer stays read-only until the production autopilot is enabled", async () => {
  const { db, actionId } = fixture();
  const result = await runOptimizerCycle(db, {
    config: {
      production: true,
      encryptionConfigured: true,
      origin: "https://ritm.example",
      liveAdsEnabled: true,
      autopilotEnabled: false,
    },
    connectionRunner: async () => assert.fail("must not connect"),
  });
  assert.equal(result.status, "disabled");
  assert.equal(
    db.prepare("SELECT status FROM optimizer_actions WHERE id=?").get(actionId)
      .status,
    "proposed",
  );
  db.close();
});
