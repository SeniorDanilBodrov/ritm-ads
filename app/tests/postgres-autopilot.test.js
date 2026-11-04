import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import test from "node:test";
import { openDatabase } from "../server/db.js";
import {
  applyPostgresOptimizerAction,
  createPostgresManualSuspendAction,
  queuePostgresOptimizerAction,
  rollbackPostgresOptimizerAction,
  runPostgresOptimizerCycle,
  runPostgresShadowCycle,
  schedulePostgresAutopilotReports,
  schedulePostgresShadowReviews,
} from "../server/postgres-autopilot.js";
import { encrypt } from "../server/security.js";

class AsyncSqlite {
  constructor(database) {
    this.database = database;
  }

  prepare(sql) {
    const statement = this.database.prepare(
      sql
        .replace(/\s+FOR UPDATE(?: SKIP LOCKED)?/gi, "")
        .replace(/\bctid\b/gi, "rowid"),
    );
    return {
      get: async (...parameters) => statement.get(...parameters),
      all: async (...parameters) => statement.all(...parameters),
      run: async (...parameters) => statement.run(...parameters),
    };
  }

  async transaction(action) {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const value = await action(this);
      this.database.exec("COMMIT");
      return value;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }
}

const NOW = Date.parse("2026-11-10T09:00:00.000Z");
const KEY = randomBytes(32);
const CONFIG = {
  liveAdsEnabled: true,
  autopilotEnabled: true,
  production: true,
  encryptionConfigured: true,
  origin: "https://ritm.example",
};

function fixture() {
  const sqlite = openDatabase(":memory:");
  const db = new AsyncSqlite(sqlite);
  const userId = randomUUID();
  const businessId = randomUUID();
  const connectionId = randomUUID();
  const state = {
    mode: "live",
    name: "Форма",
    timezone: "Europe/Moscow",
    periodStart: "2026-11-01",
    periodEnd: "2026-11-30",
    budget: 6_000_000,
    targetCpa: 45_000,
    counterId: "123",
    goalId: "456",
  };
  sqlite
    .prepare("INSERT INTO users VALUES(?,?,?,?)")
    .run(userId, `google:${userId}`, "Tester", new Date(NOW).toISOString());
  sqlite
    .prepare("INSERT INTO businesses VALUES(?,?,?,1)")
    .run(businessId, userId, JSON.stringify(state));
  sqlite.prepare("INSERT INTO connections VALUES(?,?,?,?)").run(
    businessId,
    "yandex",
    encrypt({ access_token: "token" }, KEY, `${businessId}:yandex`),
    JSON.stringify({
      connectionId,
      sandbox: false,
      clients: [{ Login: "client", Currency: "RUB" }],
    }),
  );
  return { sqlite, db, userId, businessId, connectionId, state };
}

function installCampaign(
  data,
  { campaignId, budget = 3_000_000, channel = "search" } = {},
) {
  const changeId = randomUUID();
  const at = new Date(NOW - 86400000).toISOString();
  const plan = {
    login: "client",
    campaignName: `Кампания ${campaignId}`,
    budget,
    periodStart: "2026-11-01",
    periodEnd: "2026-11-30",
    counterId: "123",
    goalId: "456",
    ...(channel === "network" ? { channel: "network" } : {}),
  };
  data.sqlite
    .prepare(
      "INSERT INTO jobs(id,business_id,kind,status,available_at,payload) VALUES(?,?,?,'succeeded',?,?)",
    )
    .run(changeId, data.businessId, "direct_change", NOW, "{}");
  data.sqlite
    .prepare(
      `INSERT INTO direct_changes
       (id,business_id,idempotency_key,mode,plan_json,commands_json,created_at,updated_at)
       VALUES(?,?,?,'dry-run',?,'[]',?,?)`,
    )
    .run(changeId, data.businessId, randomUUID(), JSON.stringify(plan), at, at);
  data.sqlite
    .prepare(
      `INSERT INTO direct_executions
       (change_id,business_id,connection_id,plan_fingerprint,status,inflight_key,
        suspend_verified,calls_json,started_at,updated_at)
       VALUES(?,?,?,'fingerprint','succeeded',NULL,1,?,?,?)`,
    )
    .run(
      changeId,
      data.businessId,
      data.connectionId,
      JSON.stringify([{ key: "campaign", ids: [campaignId] }]),
      at,
      at,
    );
  data.sqlite
    .prepare("INSERT INTO campaign_ad_lifecycle VALUES(?,?,'active',?,?)")
    .run(data.businessId, changeId, "Запуск подтверждён", at);
  data.sqlite
    .prepare("INSERT INTO campaign_budget_allocations VALUES(?,?,?,?)")
    .run(data.businessId, changeId, budget, at);
  return { changeId, plan };
}

function storeSnapshot(
  data,
  campaignId,
  { spent = 180_000, clicks = 150 } = {},
) {
  const jobId = randomUUID();
  const snapshotId = randomUUID();
  data.sqlite
    .prepare(
      "INSERT INTO jobs(id,business_id,kind,status,available_at,payload) VALUES(?,?,?,'succeeded',?,?)",
    )
    .run(jobId, data.businessId, "report_sync", NOW, "{}");
  const rows = [
    {
      Date: "2026-11-10",
      CampaignId: String(campaignId),
      spent,
      clicks,
      impressions: clicks * 10,
      conversions: 0,
    },
  ];
  data.sqlite
    .prepare(
      `INSERT INTO report_snapshots
       (id,business_id,job_id,scope,source,login,date_from,date_to,currency,
        include_vat,received_at,request_id,raw_hash,raw_tsv,rows_json,totals_json,
        previous_id,comparison_json,metrica_json)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      snapshotId,
      data.businessId,
      jobId,
      randomUUID(),
      "yandex",
      "client",
      "2026-11-01",
      "2026-11-10",
      "RUB",
      1,
      new Date(NOW).toISOString(),
      null,
      randomUUID(),
      "",
      JSON.stringify(rows),
      JSON.stringify({ spent, clicks, impressions: clicks * 10 }),
      null,
      "{}",
      null,
    );
  return snapshotId;
}

function review({ spent, clicks, goals, snapshotId = randomUUID() }) {
  return {
    id: randomUUID(),
    status: "observed",
    executed: false,
    source: {
      attribution: "direct_campaign_last_significant",
      direct: { snapshotId, spentKopecks: spent, clicks },
      campaignGoalReaches: goals,
    },
  };
}

function budgetCampaign(id, limit, channel = "search") {
  const network = channel === "network";
  return {
    Campaigns: [
      {
        Id: id,
        State: "ON",
        Status: "ACCEPTED",
        Type: network ? "UNIFIED_CAMPAIGN" : "TEXT_CAMPAIGN",
        ...(network
          ? {
              UnifiedCampaign: {
                BiddingStrategy: {
                  Search: { BiddingStrategyType: "SERVING_OFF" },
                  Network: {
                    BiddingStrategyType: "WB_MAXIMUM_CLICKS",
                    PlacementTypes: { Network: "YES", Maps: "NO" },
                    WbMaximumClicks: {
                      CustomPeriodBudget: {
                        SpendLimit: limit * 10_000,
                        StartDate: "2026-11-01",
                        EndDate: "2026-11-30",
                        AutoContinue: "NO",
                      },
                    },
                  },
                },
              },
            }
          : {
              TextCampaign: {
                BiddingStrategy: {
                  Search: {
                    BiddingStrategyType: "WB_MAXIMUM_CLICKS",
                    WbMaximumClicks: {
                      CustomPeriodBudget: {
                        SpendLimit: limit * 10_000,
                        StartDate: "2026-11-01",
                        EndDate: "2026-11-30",
                        AutoContinue: "NO",
                      },
                    },
                  },
                  Network: { BiddingStrategyType: "SERVING_OFF" },
                },
              },
            }),
      },
    ],
  };
}

test("PostgreSQL autopilot schedules one safe report per campaign day", async () => {
  const data = fixture();
  installCampaign(data, { campaignId: 77 });
  assert.equal(await schedulePostgresAutopilotReports(data.db, NOW), 1);
  assert.equal(await schedulePostgresAutopilotReports(data.db, NOW), 0);
  assert.equal(
    data.sqlite
      .prepare("SELECT COUNT(*) AS count FROM jobs WHERE kind='report_sync'")
      .get().count,
    1,
  );
  data.sqlite.close();
});

test("PostgreSQL shadow review uses exact campaign attribution and queues a pause", async () => {
  const data = fixture();
  const campaign = installCampaign(data, { campaignId: 77 });
  storeSnapshot(data, 77);
  assert.equal(await schedulePostgresShadowReviews(data.db, NOW), 1);
  const result = await runPostgresShadowCycle(data.db, {
    key: KEY,
    now: NOW,
    directFactory: () => ({
      campaignsByIds: async () => ({
        Campaigns: [{ Id: 77, State: "ON", Status: "ACCEPTED" }],
      }),
    }),
    metricaFactory: () => ({
      campaignStatistics: async () => ({ totals: [140, 0], sampled: false }),
    }),
  });
  assert.equal(result.status, "succeeded");
  assert.equal(result.review.source.direct.spentKopecks, 180_000);
  assert.equal(result.review.source.campaignGoalReaches, 0);
  assert.equal(result.optimizerAction.action, "pause_campaign");
  assert.equal(
    data.sqlite
      .prepare("SELECT status FROM optimizer_actions WHERE change_id=?")
      .get(campaign.changeId).status,
    "proposed",
  );
  data.sqlite.close();
});

test("PostgreSQL Budget Guard suspends once and verifies read-back", async () => {
  const data = fixture();
  const campaign = installCampaign(data, { campaignId: 77 });
  await queuePostgresOptimizerAction(
    data.db,
    data.businessId,
    campaign.changeId,
    review({ spent: 180_000, clicks: 150, goals: 0 }),
    data.state.targetCpa,
  );
  let writes = 0;
  let suspended = false;
  const result = await runPostgresOptimizerCycle(data.db, {
    key: KEY,
    config: CONFIG,
    now: NOW,
    directFactory: () => ({
      campaignsByIds: async () => ({
        Campaigns: [
          {
            Id: 77,
            State: suspended ? "SUSPENDED" : "ON",
            Status: "ACCEPTED",
          },
        ],
      }),
      suspendCampaigns: async () => {
        writes += 1;
        suspended = true;
        return { SuspendResults: [{ Id: 77 }] };
      },
    }),
  });
  assert.equal(result.status, "applied");
  assert.equal(writes, 1);
  assert.equal(
    data.sqlite
      .prepare(
        "SELECT status FROM campaign_ad_lifecycle WHERE business_id=? AND change_id=?",
      )
      .get(data.businessId, campaign.changeId).status,
    "paused",
  );
  assert.equal(
    (
      await runPostgresOptimizerCycle(data.db, {
        key: KEY,
        config: CONFIG,
        directFactory: () => {
          throw new Error("must not execute");
        },
      })
    ).status,
    "idle",
  );
  assert.equal(writes, 1);
  data.sqlite.close();
});

test("owner-requested PostgreSQL suspension is journaled and applied once", async () => {
  const data = fixture();
  const campaign = installCampaign(data, { campaignId: 77 });
  const action = await createPostgresManualSuspendAction(
    data.db,
    data.userId,
    data.businessId,
    campaign.changeId,
    randomUUID(),
    { confirmed: true, now: NOW },
  );
  let suspended = false;
  let writes = 0;
  const result = await applyPostgresOptimizerAction(
    data.db,
    data.userId,
    data.businessId,
    action.id,
    {
      key: KEY,
      config: CONFIG,
      now: NOW,
      directFactory: () => ({
        campaignsByIds: async () => ({
          Campaigns: [
            {
              Id: 77,
              State: suspended ? "SUSPENDED" : "ON",
              Status: "ACCEPTED",
            },
          ],
        }),
        suspendCampaigns: async () => {
          writes += 1;
          suspended = true;
          return { SuspendResults: [{ Id: 77 }] };
        },
      }),
    },
  );
  assert.equal(result.status, "applied");
  assert.equal(writes, 1);
  const replay = await applyPostgresOptimizerAction(
    data.db,
    data.userId,
    data.businessId,
    action.id,
    { key: KEY, config: CONFIG },
  );
  assert.equal(replay.status, "applied");
  assert.equal(writes, 1);
  data.sqlite.close();
});

test("PostgreSQL autopilot transfers only the donor remainder and preserves the portfolio", async () => {
  const data = fixture();
  const recipient = installCampaign(data, {
    campaignId: 77,
    channel: "network",
  });
  const donor = installCampaign(data, { campaignId: 88 });
  const donorReview = review({ spent: 180_000, clicks: 250, goals: 4 });
  data.sqlite
    .prepare(
      `INSERT INTO direct_shadow_reviews
       (id,business_id,change_id,connection_id,request_key,created_at,result_json)
       VALUES(?,?,?,?,?,?,?)`,
    )
    .run(
      donorReview.id,
      data.businessId,
      donor.changeId,
      data.connectionId,
      randomUUID(),
      new Date(NOW).toISOString(),
      JSON.stringify(donorReview),
    );
  const queued = await queuePostgresOptimizerAction(
    data.db,
    data.businessId,
    recipient.changeId,
    review({ spent: 300_000, clicks: 400, goals: 10 }),
    data.state.targetCpa,
  );
  assert.equal(queued.action, "consider_reallocation");
  const limits = new Map([
    [77, 3_000_000],
    [88, 3_000_000],
  ]);
  const writes = [];
  const client = {
    campaignBudgetById: async (id) =>
      budgetCampaign(id, limits.get(id), id === 77 ? "network" : "search"),
    updateTextCampaignPeriodBudget: async (id, input) => {
      writes.push(["search", id, input.spendLimitKopecks]);
      limits.set(id, input.spendLimitKopecks);
      return { UpdateResults: [{ Id: id }] };
    },
    updateUnifiedCampaignPeriodBudget: async (id, input) => {
      writes.push(["network", id, input.spendLimitKopecks]);
      limits.set(id, input.spendLimitKopecks);
      return { UpdateResults: [{ Id: id }] };
    },
  };
  const result = await runPostgresOptimizerCycle(data.db, {
    key: KEY,
    config: CONFIG,
    now: NOW,
    directFactory: () => client,
  });
  assert.equal(result.status, "applied");
  assert.deepEqual(writes, [
    ["search", 88, 180_000],
    ["network", 77, 5_820_000],
  ]);
  assert.equal(limits.get(77) + limits.get(88), 6_000_000);
  assert.equal(
    data.sqlite
      .prepare(
        "SELECT SUM(limit_kopecks) AS total FROM campaign_budget_allocations WHERE business_id=?",
      )
      .get(data.businessId).total,
    6_000_000,
  );
  const rollback = await rollbackPostgresOptimizerAction(
    data.db,
    data.userId,
    data.businessId,
    result.id,
    randomUUID(),
    {
      key: KEY,
      config: CONFIG,
      directFactory: () => client,
      spendConfirmed: true,
      launchConfirmed: true,
      now: NOW + 1_000,
    },
  );
  assert.equal(rollback.status, "rolled_back");
  assert.deepEqual(writes.slice(-2), [
    ["network", 77, 3_000_000],
    ["search", 88, 3_000_000],
  ]);
  assert.equal(limits.get(77) + limits.get(88), 6_000_000);
  data.sqlite.close();
});

test("PostgreSQL optimizer remains read-only while autopilot is disabled", async () => {
  const data = fixture();
  const campaign = installCampaign(data, { campaignId: 77 });
  await queuePostgresOptimizerAction(
    data.db,
    data.businessId,
    campaign.changeId,
    review({ spent: 180_000, clicks: 150, goals: 0 }),
    data.state.targetCpa,
  );
  const result = await runPostgresOptimizerCycle(data.db, {
    key: KEY,
    config: { ...CONFIG, autopilotEnabled: false },
    directFactory: () => {
      throw new Error("must remain read-only");
    },
  });
  assert.equal(result.status, "disabled");
  assert.equal(
    data.sqlite.prepare("SELECT status FROM optimizer_actions").get().status,
    "proposed",
  );
  data.sqlite.close();
});
