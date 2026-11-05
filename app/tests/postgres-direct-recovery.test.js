import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { openDatabase } from "../server/db.js";
import { buildDirectCommands } from "../server/direct.js";
import { continuePostgresDirectExecution } from "../server/postgres-direct.js";

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
  const now = "2026-11-05T10:00:00.000Z";
  const plan = {
    login: "test-login",
    campaignName: "PROcomp · Поиск",
    website: "https://example.test/",
    audience: "Покупатели компьютерной техники",
    regionIds: [54],
    budget: 19_500_00,
    targetCpa: 1_500_00,
    periodStart: "2026-11-06",
    periodEnd: "2026-11-19",
    counterId: "123",
    goalId: "456",
    keywords: [
      "купить компьютер, Екатеринбург",
      "ПК/ноутбук & комплектующие",
      "игровой компьютер — Екатеринбург",
    ],
    ads: [
      {
        title: "Компьютеры в Екатеринбурге",
        text: "Подберите компьютер для работы или игр",
        href: "https://example.test/",
      },
      {
        title: "Магазин компьютерной техники",
        text: "Компьютеры и комплектующие с удобным выбором",
        href: "https://example.test/",
      },
    ],
  };
  const commands = buildDirectCommands(plan).commands;
  sqlite
    .prepare("INSERT INTO users VALUES(?,?,?,?)")
    .run(userId, `google:${userId}`, "Tester", now);
  sqlite.prepare("INSERT INTO businesses VALUES(?,?,?,1)").run(
    businessId,
    userId,
    JSON.stringify({ mode: "live", name: "PROcomp", budget: plan.budget }),
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
       VALUES(?,?,?,'dry_run',?,?,NULL,NULL,?,?)`,
    )
    .run(
      changeId,
      businessId,
      randomUUID(),
      JSON.stringify(plan),
      JSON.stringify(commands),
      now,
      now,
    );
  sqlite
    .prepare(
      `INSERT INTO direct_executions
       (change_id,business_id,connection_id,plan_fingerprint,status,inflight_key,suspend_verified,calls_json,started_at,updated_at,error_code,reconciliation_json)
       VALUES(?,?,?,'fingerprint','needs_reconciliation','keywords',1,?,?,?,'provider_error',?)`,
    )
    .run(
      changeId,
      businessId,
      connectionId,
      JSON.stringify([
        { key: "campaign", ids: [101] },
        { key: "suspend", ids: [101], holdState: "OFF_DRAFT" },
        { key: "adgroup", ids: [202] },
      ]),
      now,
      now,
      JSON.stringify({
        status: "keyword_repair_sending",
        unresolvedStep: "keywords",
        keywordRepair: { attempted: true, missingCount: 3 },
      }),
    );
  sqlite
    .prepare(
      "INSERT INTO campaign_ad_lifecycle(business_id,change_id,status,reason,updated_at) VALUES(?,?,'needs_reconciliation',?,?)",
    )
    .run(businessId, changeId, "Требуется сверка", now);
  return { sqlite, db, userId, businessId, changeId, plan };
}

test("PostgreSQL recovery adds only missing normalized phrases and then creates ads", async () => {
  const data = fixture();
  const remoteKeywords = [];
  const remoteAds = [];
  const writes = [];
  const campaign = {
    Id: 101,
    Name: data.plan.campaignName,
    State: "OFF",
    Status: "DRAFT",
    Type: "UNIFIED_CAMPAIGN",
  };
  const client = {
    campaignsByIds: async () => ({ Campaigns: [campaign] }),
    adGroupsByIds: async () => ({
      AdGroups: [{ Id: 202, CampaignId: 101, Status: "ACCEPTED" }],
    }),
    keywordsByAdGroupId: async () => ({ Keywords: [...remoteKeywords] }),
    adsByAdGroupId: async () => ({ Ads: [...remoteAds] }),
    createKeywords: async (items) => {
      writes.push(["keywords", items]);
      items.forEach((item, index) =>
        remoteKeywords.push({
          Id: 301 + index,
          AdGroupId: item.AdGroupId,
          Keyword: item.Keyword,
        }),
      );
      return { AddResults: items.map((_, index) => ({ Id: 301 + index })) };
    },
    createAds: async (items) => {
      writes.push(["ads", items]);
      items.forEach((item, index) =>
        remoteAds.push({
          Id: 401 + index,
          AdGroupId: item.AdGroupId,
          State: "OFF",
          Status: "DRAFT",
          Type: "RESPONSIVE_AD",
          ResponsiveAd: item.ResponsiveAd,
        }),
      );
      return { AddResults: items.map((_, index) => ({ Id: 401 + index })) };
    },
    keywordsByIds: async (ids) => ({
      Keywords: remoteKeywords.filter((item) => ids.includes(item.Id)),
    }),
    adsByIds: async (ids) => ({
      Ads: remoteAds.filter((item) => ids.includes(item.Id)),
    }),
  };

  const result = await continuePostgresDirectExecution(
    data.db,
    data.userId,
    data.businessId,
    data.changeId,
    client,
    { enabled: true, now: Date.parse("2026-11-05T12:00:00.000Z") },
  );

  assert.equal(result.status, "succeeded");
  assert.deepEqual(
    writes.map(([kind]) => kind),
    ["keywords", "ads"],
  );
  assert.equal(writes[0][1][0].Keyword, "купить компьютер Екатеринбург");
  assert.equal(writes[0][1][1].Keyword, "ПК ноутбук комплектующие");
  assert.equal(writes[0][1][2].Keyword, "игровой компьютер Екатеринбург");
  assert.equal(writes[0][1].length, 3);
  assert.equal(writes[1][1].length, 2);
  const stored = data.sqlite
    .prepare(
      "SELECT status,inflight_key,calls_json FROM direct_executions WHERE change_id=?",
    )
    .get(data.changeId);
  assert.equal(stored.status, "succeeded");
  assert.equal(stored.inflight_key, null);
  assert.deepEqual(
    JSON.parse(stored.calls_json).map((item) => item.key),
    ["campaign", "suspend", "adgroup", "keywords", "ads"],
  );
});

test("PostgreSQL recovery continues with confirmed phrases after one repair attempt", async () => {
  const data = fixture();
  const previous = data.sqlite
    .prepare("SELECT reconciliation_json FROM direct_executions WHERE change_id=?")
    .get(data.changeId);
  const reconciliation = JSON.parse(previous.reconciliation_json);
  reconciliation.keywordRepair.version = 2;
  reconciliation.keywordRepair.attemptedAt = "2026-11-05T11:00:00.000Z";
  data.sqlite
    .prepare("UPDATE direct_executions SET reconciliation_json=? WHERE change_id=?")
    .run(JSON.stringify(reconciliation), data.changeId);

  const remoteKeywords = [
    {
      Id: 301,
      AdGroupId: 202,
      Keyword: "купить компьютер Екатеринбург",
    },
    {
      Id: 302,
      AdGroupId: 202,
      Keyword: "ПК ноутбук комплектующие",
    },
  ];
  const remoteAds = [];
  const writes = [];
  const campaign = {
    Id: 101,
    Name: data.plan.campaignName,
    State: "OFF",
    Status: "DRAFT",
    Type: "UNIFIED_CAMPAIGN",
  };
  const client = {
    campaignsByIds: async () => ({ Campaigns: [campaign] }),
    adGroupsByIds: async () => ({
      AdGroups: [{ Id: 202, CampaignId: 101, Status: "ACCEPTED" }],
    }),
    keywordsByAdGroupId: async () => ({ Keywords: [...remoteKeywords] }),
    adsByAdGroupId: async () => ({ Ads: [...remoteAds] }),
    createKeywords: async () => {
      writes.push("keywords");
      throw new Error("keywords must not be replayed");
    },
    createAds: async (items) => {
      writes.push("ads");
      items.forEach((item, index) =>
        remoteAds.push({
          Id: 401 + index,
          AdGroupId: item.AdGroupId,
          State: "OFF",
          Status: "DRAFT",
          Type: "RESPONSIVE_AD",
          ResponsiveAd: item.ResponsiveAd,
        }),
      );
      return { AddResults: items.map((_, index) => ({ Id: 401 + index })) };
    },
    keywordsByIds: async (ids) => ({
      Keywords: remoteKeywords.filter((item) => ids.includes(item.Id)),
    }),
    adsByIds: async (ids) => ({
      Ads: remoteAds.filter((item) => ids.includes(item.Id)),
    }),
  };

  const result = await continuePostgresDirectExecution(
    data.db,
    data.userId,
    data.businessId,
    data.changeId,
    client,
    { enabled: true, now: Date.parse("2026-11-05T12:00:00.000Z") },
  );

  assert.equal(result.status, "succeeded");
  assert.deepEqual(writes, ["ads"]);
  const stored = data.sqlite
    .prepare(
      "SELECT status,calls_json,reconciliation_json FROM direct_executions WHERE change_id=?",
    )
    .get(data.changeId);
  assert.equal(stored.status, "succeeded");
  assert.deepEqual(
    JSON.parse(stored.calls_json).find((item) => item.key === "keywords").ids,
    [301, 302],
  );
  assert.equal(JSON.parse(stored.reconciliation_json).matched, true);
  data.sqlite.close();
});
