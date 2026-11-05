import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { openDatabase } from "../server/db.js";
import {
  inspectPostgresResumeAction,
  markInterruptedPostgresResumeActions,
  postgresResumeActions,
  resumePostgresVerifiedCampaign,
} from "../server/postgres-direct-resume.js";

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
  const now = "2026-11-05T08:55:00.000Z";
  const plan = {
    login: "test-login",
    campaignName: "Форма · Поиск",
    website: "https://forma.example/",
    audience: "Ищут маникюр с покрытием рядом",
    regionIds: [54],
    budget: 30_000,
    targetCpa: 450,
    counterId: "123",
    goalId: "456",
    periodStart: "2026-11-05",
    periodEnd: "2026-11-18",
    ads: [
      {
        title: "Маникюр с покрытием",
        text: "Бережный уход и удобная запись",
        href: "https://forma.example/",
      },
    ],
    keywords: ["маникюр с покрытием"],
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
      budget: plan.budget,
      counterId: plan.counterId,
      goalId: plan.goalId,
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
        { key: "suspend", ids: [77], holdState: "OFF_DRAFT" },
        { key: "adgroup", ids: [88] },
        { key: "keywords", ids: [111] },
        { key: "ads", ids: [99] },
      ]),
      now,
      now,
    );
  sqlite
    .prepare("INSERT INTO campaign_ad_lifecycle VALUES(?,?,'paused',?,?)")
    .run(businessId, changeId, "Кампания выключена.", now);
  const reportJobId = randomUUID();
  sqlite
    .prepare(
      "INSERT INTO jobs(id,business_id,kind,status,available_at,attempts,payload,error) VALUES(?,?,'report_sync','succeeded',0,1,'{}',NULL)",
    )
    .run(reportJobId, businessId);
  sqlite
    .prepare(
      `INSERT INTO report_snapshots
       (id,business_id,job_id,scope,source,login,date_from,date_to,currency,include_vat,received_at,request_id,raw_hash,raw_tsv,rows_json,totals_json,previous_id,comparison_json)
       VALUES(?,?,?,'campaign','yandex','test-login','2026-11-05','2026-11-05','RUB',1,?,NULL,'hash','header',?,'{}',NULL,'{}')`,
    )
    .run(
      randomUUID(),
      businessId,
      reportJobId,
      now,
      JSON.stringify([{ CampaignId: "77", Date: "2026-11-05", spent: 0 }]),
    );
  return { sqlite, db, userId, businessId, changeId, connectionId, plan };
}

function networkFixture() {
  const data = fixture();
  data.plan = {
    channel: "network",
    login: "test-login",
    campaignName: "Форма · РСЯ",
    website: "https://forma.example/",
    audience: "Женщины, которые ищут маникюр рядом",
    regionIds: [54],
    budget: 12_000,
    counterId: "123",
    goalId: "456",
    periodStart: "2026-11-05",
    periodEnd: "2026-11-18",
    creativeAssetId: randomUUID(),
    ads: [
      {
        titles: [
          "Маникюр с покрытием рядом",
          "Бережный уход за ногтями",
          "Удобная запись в студию",
        ],
        texts: [
          "Аккуратное покрытие и бережный уход в студии «Форма».",
          "Выберите удобное время и запишитесь на маникюр онлайн.",
          "Студия маникюра в Екатеринбурге рядом с вами.",
        ],
        href: "https://forma.example/",
        adImageHashes: ["approved_image_hash-1"],
      },
    ],
  };
  data.sqlite
    .prepare("UPDATE direct_changes SET plan_json=? WHERE id=?")
    .run(JSON.stringify(data.plan), data.changeId);
  data.sqlite
    .prepare("UPDATE direct_executions SET calls_json=? WHERE change_id=?")
    .run(
      JSON.stringify([
        { key: "campaign", ids: [77] },
        { key: "suspend", ids: [77], holdState: "OFF_DRAFT" },
        { key: "adgroup", ids: [88] },
        { key: "ads", ids: [99] },
      ]),
      data.changeId,
    );
  data.sqlite.prepare("UPDATE businesses SET state=? WHERE id=?").run(
    JSON.stringify({
      mode: "live",
      name: "Форма",
      website: data.plan.website,
      budget: 30_000,
      counterId: data.plan.counterId,
      goalId: data.plan.goalId,
    }),
    data.businessId,
  );
  return data;
}

function directClient(data, { ambiguous = false } = {}) {
  let state = "OFF";
  let writes = 0;
  const network = data.plan.channel === "network";
  return {
    get writes() {
      return writes;
    },
    set state(value) {
      state = value;
    },
    campaignBudgetById: async () => ({
      Campaigns: [
        {
          Id: 77,
          State: state,
          Status: "ACCEPTED",
          StatusPayment: "ALLOWED",
          Type: network ? "UNIFIED_CAMPAIGN" : "TEXT_CAMPAIGN",
          Currency: "RUB",
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
                          SpendLimit: data.plan.budget * 10_000,
                          StartDate: data.plan.periodStart,
                          EndDate: data.plan.periodEnd,
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
              }),
        },
      ],
    }),
    adGroupsByIds: async () => ({
      AdGroups: [
        {
          Id: 88,
          CampaignId: 77,
          Type: network ? "UNIFIED_AD_GROUP" : "TEXT_AD_GROUP",
        },
      ],
    }),
    adsByIds: async () => ({
      Ads: [
        {
          Id: 99,
          CampaignId: 77,
          AdGroupId: 88,
          Status: "ACCEPTED",
          State: "ON",
        },
      ],
    }),
    keywordsByIds: async () => {
      if (network)
        throw new Error("network campaign must not request keywords");
      return {
        Keywords: [
          {
            Id: 111,
            CampaignId: 77,
            AdGroupId: 88,
            Status: "ACCEPTED",
            State: "ON",
          },
        ],
      };
    },
    advertiserMarkingDetails: async () => ({
      Clients: [
        {
          Type: "CLIENT",
          TinInfo: { TinType: "LEGAL", Tin: "test-value" },
          ErirAttributes: { Organization: { Name: "test-value" } },
        },
      ],
    }),
    resumeCampaigns: async (ids) => {
      writes++;
      if (ambiguous) throw new Error("lost response");
      state = "ON";
      return { ResumeResults: ids.map((Id) => ({ Id })) };
    },
  };
}

const confirmations = (data) => ({
  enabled: true,
  advertiserConfirmed: true,
  siteConfirmed: true,
  markingConfirmed: true,
  spendConfirmed: true,
  launchConfirmed: true,
  confirmCampaignId: 77,
  confirmLimitKopecks: data.plan.budget,
  now: Date.parse("2026-11-05T09:00:00.000Z"),
});

test("PostgreSQL launch resumes one verified campaign once", async () => {
  const data = fixture();
  const client = directClient(data);
  const key = randomUUID();
  const result = await resumePostgresVerifiedCampaign(
    data.db,
    data.userId,
    data.businessId,
    data.changeId,
    key,
    client,
    data.connectionId,
    confirmations(data),
  );
  assert.equal(result.status, "succeeded");
  assert.equal(result.afterState, "ON");
  assert.equal(client.writes, 1);
  assert.equal(
    data.sqlite
      .prepare(
        "SELECT status FROM campaign_ad_lifecycle WHERE business_id=? AND change_id=?",
      )
      .get(data.businessId, data.changeId).status,
    "active",
  );
  const replay = await resumePostgresVerifiedCampaign(
    data.db,
    data.userId,
    data.businessId,
    data.changeId,
    key,
    client,
    data.connectionId,
    confirmations(data),
  );
  assert.equal(replay.id, result.id);
  assert.equal(client.writes, 1);
  assert.equal(
    (
      await postgresResumeActions(
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

test("PostgreSQL launch accepts a Yandex landing with Direct conversion attribution", async () => {
  const data = fixture();
  const state = {
    mode: "live",
    name: "Форма",
    website: data.plan.website,
    landingMode: "yandex_landing",
    budget: data.plan.budget,
  };
  data.sqlite
    .prepare("UPDATE businesses SET state=? WHERE id=?")
    .run(JSON.stringify(state), data.businessId);
  delete data.plan.counterId;
  delete data.plan.goalId;
  data.sqlite
    .prepare("UPDATE direct_changes SET plan_json=? WHERE id=?")
    .run(JSON.stringify(data.plan), data.changeId);
  const client = directClient(data);
  const result = await resumePostgresVerifiedCampaign(
    data.db,
    data.userId,
    data.businessId,
    data.changeId,
    randomUUID(),
    client,
    data.connectionId,
    confirmations(data),
  );
  assert.equal(result.status, "succeeded");
  assert.equal(result.afterState, "ON");
  assert.equal(client.writes, 1);
  data.sqlite.close();
});

test("PostgreSQL launch resumes a verified network campaign without keywords", async () => {
  const data = networkFixture();
  const client = directClient(data);
  const result = await resumePostgresVerifiedCampaign(
    data.db,
    data.userId,
    data.businessId,
    data.changeId,
    randomUUID(),
    client,
    data.connectionId,
    confirmations(data),
  );
  assert.equal(result.status, "succeeded");
  assert.equal(result.afterState, "ON");
  assert.equal(client.writes, 1);
  data.sqlite.close();
});

test("PostgreSQL launch requires every owner confirmation before a write", async () => {
  const data = fixture();
  const client = directClient(data);
  await assert.rejects(
    () =>
      resumePostgresVerifiedCampaign(
        data.db,
        data.userId,
        data.businessId,
        data.changeId,
        randomUUID(),
        client,
        data.connectionId,
        { ...confirmations(data), markingConfirmed: false },
      ),
    (error) => error?.code === "launch_confirmation_missing",
  );
  assert.equal(client.writes, 0);
  assert.equal(
    data.sqlite
      .prepare("SELECT COUNT(*) AS count FROM direct_resume_actions")
      .get().count,
    0,
  );
  data.sqlite.close();
});

test("PostgreSQL launch fails closed without configured analytics", async () => {
  const data = fixture();
  data.sqlite.prepare("UPDATE businesses SET state=? WHERE id=?").run(
    JSON.stringify({
      mode: "live",
      name: "Форма",
      website: data.plan.website,
      budget: data.plan.budget,
    }),
    data.businessId,
  );
  const client = directClient(data);
  const result = await resumePostgresVerifiedCampaign(
    data.db,
    data.userId,
    data.businessId,
    data.changeId,
    randomUUID(),
    client,
    data.connectionId,
    confirmations(data),
  );
  assert.equal(result.status, "failed_no_write");
  assert.equal(result.writeAttempted, false);
  assert.equal(client.writes, 0);
  data.sqlite.close();
});

test("an ambiguous PostgreSQL launch is never replayed and reconciles by read", async () => {
  const data = fixture();
  const client = directClient(data, { ambiguous: true });
  const result = await resumePostgresVerifiedCampaign(
    data.db,
    data.userId,
    data.businessId,
    data.changeId,
    randomUUID(),
    client,
    data.connectionId,
    confirmations(data),
  );
  assert.equal(result.status, "needs_reconciliation");
  assert.equal(client.writes, 1);
  client.state = "ON";
  const reconciled = await inspectPostgresResumeAction(
    data.db,
    data.userId,
    data.businessId,
    data.changeId,
    result.id,
    client,
  );
  assert.equal(reconciled.status, "succeeded");
  assert.equal(client.writes, 1);
  data.sqlite.close();
});

test("interrupted PostgreSQL launches are fenced by their last durable state", async () => {
  const data = fixture();
  const first = randomUUID();
  const second = randomUUID();
  const at = "2026-11-05T09:00:00.000Z";
  const insert = data.sqlite.prepare(
    `INSERT INTO direct_resume_actions
     (id,business_id,change_id,connection_id,campaign_id,idempotency_key,status,
      write_attempted,error_code,before_state,after_state,created_at,updated_at)
     VALUES(?,?,?,?,?,?,?,0,NULL,NULL,NULL,?,?)`,
  );
  insert.run(
    first,
    data.businessId,
    data.changeId,
    data.connectionId,
    77,
    randomUUID(),
    "checking",
    at,
    at,
  );
  insert.run(
    second,
    data.businessId,
    data.changeId,
    data.connectionId,
    78,
    randomUUID(),
    "sending",
    at,
    at,
  );
  assert.equal(await markInterruptedPostgresResumeActions(data.db), 2);
  assert.equal(
    data.sqlite
      .prepare("SELECT status FROM direct_resume_actions WHERE id=?")
      .get(first).status,
    "failed_no_write",
  );
  assert.equal(
    data.sqlite
      .prepare("SELECT status FROM direct_resume_actions WHERE id=?")
      .get(second).status,
    "needs_reconciliation",
  );
  data.sqlite.close();
});
