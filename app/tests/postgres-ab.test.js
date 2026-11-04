import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { openDatabase } from "../server/db.js";
import {
  bindPostgresAudienceExperiment,
  createPostgresAudienceExperiment,
  createPostgresDirectAbPlan,
  createVerifiedPostgresAbVariant,
  inspectPostgresAbVariantAction,
  markInterruptedPostgresAbActions,
  postgresDirectAbActions,
} from "../server/postgres-ab.js";

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

const NOW = Date.parse("2026-11-04T09:00:00.000Z");

function fixture() {
  const sqlite = openDatabase(":memory:");
  const db = new AsyncSqlite(sqlite);
  const userId = randomUUID();
  const businessId = randomUUID();
  const changeId = randomUUID();
  const connectionId = randomUUID();
  const at = new Date(NOW).toISOString();
  const plan = {
    login: "client",
    campaignName: "Форма · A/B",
    website: "https://forma.example/",
    periodStart: "2026-11-10",
    periodEnd: "2026-11-30",
    ads: [
      {
        title: "Маникюр рядом",
        text: "Бережный уход и удобная запись",
        href: "https://forma.example/",
      },
    ],
  };
  sqlite
    .prepare("INSERT INTO users VALUES(?,?,?,?)")
    .run(userId, `google:${userId}`, "Tester", at);
  sqlite
    .prepare("INSERT INTO businesses VALUES(?,?,?,1)")
    .run(businessId, userId, JSON.stringify({ mode: "live" }));
  sqlite
    .prepare("INSERT INTO connections VALUES(?,?,?,?)")
    .run(
      businessId,
      "yandex",
      "encrypted",
      JSON.stringify({
        connectionId,
        clients: [{ Login: "client", Currency: "RUB" }],
      }),
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
    .run(changeId, businessId, randomUUID(), JSON.stringify(plan), at, at);
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
        { key: "campaign", ids: [101] },
        { key: "adgroup", ids: [202] },
        { key: "ads", ids: [303] },
      ]),
      at,
      at,
    );
  return { sqlite, db, userId, businessId, changeId, connectionId, plan };
}

const abInput = {
  hypothesis: "Конкретная выгода повысит долю переходов на объявление.",
  variant: {
    title: "Маникюр с заботой",
    text: "Запишитесь онлайн на удобное время",
  },
  minDays: 7,
  minImpressionsPerVariant: 500,
};

async function savedAbPlan(data) {
  return createPostgresDirectAbPlan(
    data.db,
    data.userId,
    data.businessId,
    data.changeId,
    randomUUID(),
    abInput,
    { now: NOW },
  );
}

function variantClient({ ambiguous = false } = {}) {
  let created = false;
  let failReads = ambiguous;
  return {
    campaignBudgetById: async () => ({
      Campaigns: [
        { Id: 101, State: "OFF", Status: "DRAFT", Type: "TEXT_CAMPAIGN" },
      ],
    }),
    adsByIds: async (ids) => ({
      Ads: ids.map((id) =>
        String(id) === "303"
          ? {
              Id: 303,
              AdGroupId: 202,
              CampaignId: 101,
              TextAd: {
                Title: "Маникюр рядом",
                Text: "Бережный уход и удобная запись",
                Href: "https://forma.example/",
              },
            }
          : {
              Id: 404,
              AdGroupId: 202,
              CampaignId: 101,
              TextAd: {
                Title: abInput.variant.title,
                Text: abInput.variant.text,
                Href: "https://forma.example/",
              },
            },
      ),
    }),
    adsByAdGroupId: async () => {
      if (created && failReads) throw new Error("ambiguous read");
      return {
        Ads: created
          ? [
              {
                Id: 404,
                AdGroupId: 202,
                TextAd: {
                  Title: abInput.variant.title,
                  Text: abInput.variant.text,
                  Href: "https://forma.example/",
                },
              },
            ]
          : [],
      };
    },
    createAds: async () => {
      created = true;
      if (ambiguous) throw new Error("response lost");
      return { AddResults: [{ Id: 404 }] };
    },
    allowReads() {
      failReads = false;
    },
  };
}

test("postgres A/B variant is journaled, read back and idempotent", async () => {
  const data = fixture();
  const plan = await savedAbPlan(data);
  const requestKey = randomUUID();
  const client = variantClient();
  const first = await createVerifiedPostgresAbVariant(
    data.db,
    data.userId,
    data.businessId,
    data.changeId,
    requestKey,
    client,
    data.connectionId,
    {
      enabled: true,
      confirmCampaignId: Number(plan.campaignId),
      confirmControlAdId: plan.control.adId,
      variantConfirmed: true,
      now: NOW,
    },
  );
  const replay = await createVerifiedPostgresAbVariant(
    data.db,
    data.userId,
    data.businessId,
    data.changeId,
    requestKey,
    client,
    data.connectionId,
    {
      enabled: true,
      confirmCampaignId: Number(plan.campaignId),
      confirmControlAdId: plan.control.adId,
      variantConfirmed: true,
      now: NOW,
    },
  );
  assert.equal(first.status, "succeeded");
  assert.equal(first.variantAdId, "404");
  assert.equal(replay.id, first.id);
  assert.equal(
    (await postgresDirectAbActions(
      data.db,
      data.userId,
      data.businessId,
      data.changeId,
    )).length,
    1,
  );
  data.sqlite.close();
});

test("ambiguous A/B write is never replayed and is reconciled by read", async () => {
  const data = fixture();
  const plan = await savedAbPlan(data);
  const client = variantClient({ ambiguous: true });
  const action = await createVerifiedPostgresAbVariant(
    data.db,
    data.userId,
    data.businessId,
    data.changeId,
    randomUUID(),
    client,
    data.connectionId,
    {
      enabled: true,
      confirmCampaignId: Number(plan.campaignId),
      confirmControlAdId: plan.control.adId,
      variantConfirmed: true,
      now: NOW,
    },
  );
  assert.equal(action.status, "needs_reconciliation");
  client.allowReads();
  const inspected = await inspectPostgresAbVariantAction(
    data.db,
    data.userId,
    data.businessId,
    data.changeId,
    action.id,
    client,
  );
  assert.equal(inspected.status, "succeeded");
  assert.equal(inspected.variantAdId, "404");
  data.sqlite.close();
});

test("startup recovery fences interrupted PostgreSQL A/B writes", async () => {
  const data = fixture();
  const plan = await savedAbPlan(data);
  const at = new Date(NOW).toISOString();
  data.sqlite
    .prepare(
      `INSERT INTO direct_ab_actions
       (id,business_id,plan_id,change_id,connection_id,campaign_id,ad_group_id,control_ad_id,idempotency_key,status,write_attempted,created_at,updated_at)
       VALUES(?,?,?,?,?,?,?,?,?,'sending',1,?,?)`,
    )
    .run(
      randomUUID(),
      data.businessId,
      plan.id,
      data.changeId,
      data.connectionId,
      101,
      202,
      "303",
      randomUUID(),
      at,
      at,
    );
  await markInterruptedPostgresAbActions(data.db);
  const action = (
    await postgresDirectAbActions(
      data.db,
      data.userId,
      data.businessId,
      data.changeId,
    )
  )[0];
  assert.equal(action.status, "needs_reconciliation");
  assert.equal(action.writeAttempted, true);
  data.sqlite.close();
});

test("A/B write is blocked while the autopilot has an unresolved action", async () => {
  const data = fixture();
  const plan = await savedAbPlan(data);
  const at = new Date(NOW).toISOString();
  data.sqlite
    .prepare(
      `INSERT INTO optimizer_actions
       (id,business_id,change_id,review_id,action,status,reason,guard_json,created_at,updated_at)
       VALUES(?,?,?,?,?,'proposed','Проверка','{}',?,?)`,
    )
    .run(
      randomUUID(),
      data.businessId,
      data.changeId,
      randomUUID(),
      "pause_campaign",
      at,
      at,
    );
  await assert.rejects(
    createVerifiedPostgresAbVariant(
      data.db,
      data.userId,
      data.businessId,
      data.changeId,
      randomUUID(),
      variantClient(),
      data.connectionId,
      {
        enabled: true,
        confirmCampaignId: Number(plan.campaignId),
        confirmControlAdId: plan.control.adId,
        variantConfirmed: true,
        now: NOW,
      },
    ),
    /Автопилот/,
  );
  data.sqlite.close();
});

test("audience binding verifies connection, held campaigns and identical ads", async () => {
  const data = fixture();
  const experiment = await createPostgresAudienceExperiment(
    data.db,
    data.userId,
    data.businessId,
    data.changeId,
    randomUUID(),
    {
      hypothesis:
        "Люди рядом со студией чаще записываются, чем аудитория всего города.",
      dimension: "geo_radius",
      control: { name: "Город", value: "Екатеринбург" },
      variant: { name: "Рядом", value: "Радиус 3 км" },
      minDays: 7,
      minClicksPerVariant: 100,
      minGoalsPerVariant: 5,
      probabilityThreshold: 0.95,
      minimumRelativeLift: 0.15,
    },
    { now: NOW },
  );
  const copy = {
    Title: "Маникюр рядом",
    Text: "Бережный уход и удобная запись",
    Href: "https://forma.example/",
  };
  const bound = await bindPostgresAudienceExperiment(
    data.db,
    data.userId,
    data.businessId,
    experiment.id,
    {
      controlCampaignId: "101",
      variantCampaignId: "102",
      controlAdId: "303",
      variantAdId: "304",
      budgetPerVariantKopecks: 300000,
    },
    {
      campaignsByIds: async () => ({
        Campaigns: [
          { Id: 101, State: "OFF", Status: "DRAFT", Type: "TEXT_CAMPAIGN" },
          { Id: 102, State: "OFF", Status: "DRAFT", Type: "TEXT_CAMPAIGN" },
        ],
      }),
      campaignBudgetById: async (id) => ({
        Campaigns: [
          {
            Id: Number(id),
            State: "OFF",
            Status: "DRAFT",
            Type: "TEXT_CAMPAIGN",
            TextCampaign: {
              BiddingStrategy: {
                Search: {
                  BiddingStrategyType: "WB_MAXIMUM_CLICKS",
                  WbMaximumClicks: {
                    CustomPeriodBudget: {
                      SpendLimit: 3_000_000_000,
                      StartDate: "2026-11-10",
                      EndDate: "2026-11-30",
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
          { Id: 303, CampaignId: 101, TextAd: copy },
          { Id: 304, CampaignId: 102, TextAd: copy },
        ],
      }),
    },
  );
  assert.equal(bound.status, "collecting");
  assert.equal(bound.criteria.deployment.controlCampaignId, "101");
  data.sqlite.close();
});
