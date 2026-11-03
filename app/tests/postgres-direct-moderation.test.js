import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { openDatabase } from "../server/db.js";
import {
  inspectPostgresDirectControl,
  inspectPostgresModerationReadiness,
  postgresControlReviews,
  postgresModerationActions,
  submitPostgresModeration,
} from "../server/postgres-direct-moderation.js";
import { preflightPostgresDirectPlan } from "../server/postgres-direct.js";

class AsyncSqlite {
  constructor(database) {
    this.database = database;
  }

  prepare(sql) {
    const statement = this.database.prepare(
      sql.replace(/\s+FOR UPDATE(?: SKIP LOCKED)?/gi, ""),
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

function fixture() {
  const sqlite = openDatabase(":memory:");
  const db = new AsyncSqlite(sqlite);
  const userId = randomUUID();
  const businessId = randomUUID();
  const changeId = randomUUID();
  const connectionId = randomUUID();
  const now = "2026-11-04T09:00:00.000Z";
  const plan = {
    login: "test-login",
    name: "Форма · Поиск",
    website: "https://forma.example/",
    budget: 30_000,
    periodStart: "2026-11-05",
    periodEnd: "2026-11-18",
    ads: [
      {
        title: "Маникюр с покрытием",
        text: "Бережный уход и удобная запись",
        href: "https://forma.example/",
      },
    ],
  };
  sqlite
    .prepare("INSERT INTO users VALUES(?,?,?,?)")
    .run(userId, `google:${userId}`, "Tester", now);
  sqlite.prepare("INSERT INTO businesses VALUES(?,?,?,1)").run(
    businessId,
    userId,
    JSON.stringify({
      mode: "live",
      name: "Форма",
      website: plan.website,
    }),
  );
  sqlite
    .prepare("INSERT INTO connections VALUES(?,?,?,?)")
    .run(
      businessId,
      "yandex",
      "encrypted-test-token",
      JSON.stringify({ connectionId }),
    );
  sqlite
    .prepare(
      "INSERT INTO jobs(id,business_id,kind,status,available_at,attempts,payload,error) VALUES(?,?,'direct_change','succeeded',0,0,'{}',NULL)",
    )
    .run(changeId, businessId);
  sqlite
    .prepare(
      `INSERT INTO direct_changes
       (id,business_id,idempotency_key,mode,plan_json,commands_json,result_json,reconciliation_json,created_at,updated_at)
       VALUES(?,?,?,'dry_run',?,'[]',NULL,NULL,?,?)`,
    )
    .run(changeId, businessId, randomUUID(), JSON.stringify(plan), now, now);
  sqlite
    .prepare(
      `INSERT INTO direct_executions
       (change_id,business_id,connection_id,plan_fingerprint,status,inflight_key,suspend_verified,calls_json,started_at,updated_at,error_code,reconciliation_json)
       VALUES(?,?,?,'fingerprint','succeeded',NULL,1,?,?,?,NULL,NULL)`,
    )
    .run(
      changeId,
      businessId,
      connectionId,
      JSON.stringify([
        { key: "campaign", ids: [77] },
        { key: "adgroup", ids: [88] },
        { key: "ads", ids: [99] },
        { key: "keywords", ids: [111] },
      ]),
      now,
      now,
    );
  sqlite
    .prepare("INSERT INTO campaign_ad_lifecycle VALUES(?,?,'paused',?,?)")
    .run(
      businessId,
      changeId,
      "Выключенный черновик подтверждён чтением Директа.",
      now,
    );
  return { sqlite, db, userId, businessId, changeId, connectionId, plan };
}

test("PostgreSQL moderation sends a verified draft once and keeps shows off", async () => {
  const data = fixture();
  let submitted = false;
  let writes = 0;
  const client = {
    campaignBudgetById: async () => ({
      Campaigns: [
        {
          Id: 77,
          State: "OFF",
          Status: "DRAFT",
          Type: "TEXT_CAMPAIGN",
          Currency: "RUB",
          TextCampaign: {
            BiddingStrategy: {
              Search: {
                BiddingStrategyType: "WB_MAXIMUM_CLICKS",
                WbMaximumClicks: {
                  CustomPeriodBudget: {
                    SpendLimit: data.plan.budget * 10_000,
                    StartDate: data.plan.periodStart,
                    EndDate: data.plan.periodEnd,
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
    adsByIds: async () => ({
      Ads: [
        {
          Id: 99,
          CampaignId: 77,
          AdGroupId: 88,
          Status: submitted ? "MODERATION" : "DRAFT",
          TextAd: {
            Title: data.plan.ads[0].title,
            Text: data.plan.ads[0].text,
            Href: data.plan.ads[0].href,
          },
        },
      ],
    }),
    keywordsByIds: async () => ({
      Keywords: [{ Id: 111, CampaignId: 77, AdGroupId: 88 }],
    }),
    advertiserMarkingDetails: async () => ({
      Clients: [
        {
          Type: "CLIENT",
          TinInfo: { TinType: "LEGAL", Tin: "test-value" },
          ErirAttributes: { Organization: { Name: "test-value" } },
        },
      ],
    }),
    moderateAds: async (ids) => {
      writes++;
      submitted = true;
      return { ModerateResults: ids.map((Id) => ({ Id })) };
    },
  };
  const checkedAt = Date.parse("2026-11-04T10:00:00.000Z");
  let campaignReads = 0;
  await assert.rejects(
    () =>
      preflightPostgresDirectPlan(
        data.db,
        data.userId,
        data.businessId,
        data.changeId,
        randomUUID(),
        {
          clientForLogin: {
            campaigns: async () => {
              campaignReads++;
              return { Campaigns: [] };
            },
          },
          clients: [],
          connectionId: data.connectionId,
        },
      ),
    (error) => error?.code === "direct_execution_exists",
  );
  assert.equal(campaignReads, 0);
  const readiness = await inspectPostgresModerationReadiness(
    data.db,
    data.userId,
    data.businessId,
    data.changeId,
    client,
    data.connectionId,
    checkedAt,
  );
  assert.equal(readiness.status, "technical_ready");
  assert.deepEqual(readiness.blockers, []);
  assert.equal(readiness.externalWrites, 0);

  const requestKey = randomUUID();
  const result = await submitPostgresModeration(
    data.db,
    data.userId,
    data.businessId,
    data.changeId,
    requestKey,
    client,
    data.connectionId,
    {
      enabled: true,
      advertiserConfirmed: true,
      siteConfirmed: true,
      now: checkedAt,
    },
  );
  assert.equal(result.status, "succeeded");
  assert.equal(writes, 1);

  const replay = await submitPostgresModeration(
    data.db,
    data.userId,
    data.businessId,
    data.changeId,
    requestKey,
    client,
    data.connectionId,
    {
      enabled: true,
      advertiserConfirmed: true,
      siteConfirmed: true,
      now: checkedAt,
    },
  );
  assert.equal(replay.id, result.id);
  assert.equal(writes, 1);
  assert.equal(
    data.sqlite
      .prepare(
        "SELECT status FROM campaign_ad_lifecycle WHERE business_id=? AND change_id=?",
      )
      .get(data.businessId, data.changeId).status,
    "moderation",
  );
  assert.equal(
    (
      await postgresModerationActions(
        data.db,
        data.userId,
        data.businessId,
        data.changeId,
      )
    ).length,
    1,
  );
  data.sqlite.close();
});

test("PostgreSQL control review persists the read-only Yandex decision", async () => {
  const data = fixture();
  let reads = 0;
  const client = {
    campaignBudgetById: async () => {
      reads++;
      return {
        Campaigns: [
          {
            Id: 77,
            State: "OFF",
            Status: "MODERATION",
            StatusPayment: "ALLOWED",
            Type: "TEXT_CAMPAIGN",
            Currency: "RUB",
            TextCampaign: {
              BiddingStrategy: {
                Search: {
                  BiddingStrategyType: "WB_MAXIMUM_CLICKS",
                  WbMaximumClicks: {
                    CustomPeriodBudget: {
                      SpendLimit: data.plan.budget * 10_000,
                      StartDate: data.plan.periodStart,
                      EndDate: data.plan.periodEnd,
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
    },
    adGroupsByIds: async () => ({
      AdGroups: [{ Id: 88, CampaignId: 77 }],
    }),
    adsByIds: async () => ({
      Ads: [
        {
          Id: 99,
          CampaignId: 77,
          AdGroupId: 88,
          Status: "MODERATION",
          State: "OFF",
        },
      ],
    }),
    keywordsByIds: async () => ({
      Keywords: [
        {
          Id: 111,
          CampaignId: 77,
          AdGroupId: 88,
          Status: "ACCEPTED",
          State: "SUSPENDED",
        },
      ],
    }),
  };
  const requestKey = randomUUID();
  const result = await inspectPostgresDirectControl(
    data.db,
    data.userId,
    data.businessId,
    data.changeId,
    requestKey,
    client,
    data.connectionId,
    Date.parse("2026-11-05T09:00:00.000Z"),
  );
  assert.equal(result.status, "blocked");
  assert.equal(result.externalWrites, 0);
  assert.ok(result.blockers.includes("campaign_under_review"));
  assert.ok(result.blockers.includes("ads_under_review"));
  assert.ok(result.blockers.includes("spend_not_verified"));
  assert.equal(
    (await postgresControlReviews(data.db, data.userId, data.businessId))
      .length,
    1,
  );

  const replay = await inspectPostgresDirectControl(
    data.db,
    data.userId,
    data.businessId,
    data.changeId,
    requestKey,
    client,
    data.connectionId,
    Date.parse("2026-11-05T10:00:00.000Z"),
  );
  assert.equal(replay.id, result.id);
  assert.equal(reads, 1);
  data.sqlite.close();
});
