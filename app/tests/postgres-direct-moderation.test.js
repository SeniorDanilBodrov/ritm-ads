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
        { key: "adgroup", ids: [88] },
        { key: "ads", ids: [99] },
      ]),
      data.changeId,
    );
  return data;
}

const networkCampaign = (plan, overrides = {}) => ({
  Id: 77,
  State: "OFF",
  Status: "DRAFT",
  Type: "UNIFIED_CAMPAIGN",
  Currency: "RUB",
  UnifiedCampaign: {
    BiddingStrategy: {
      Search: { BiddingStrategyType: "SERVING_OFF" },
      Network: {
        BiddingStrategyType: "WB_MAXIMUM_CLICKS",
        PlacementTypes: { Network: "YES", Maps: "NO" },
        WbMaximumClicks: {
          CustomPeriodBudget: {
            SpendLimit: plan.budget * 10_000,
            StartDate: plan.periodStart,
            EndDate: plan.periodEnd,
            AutoContinue: "NO",
          },
        },
      },
    },
  },
  ...overrides,
});

const searchCampaign = (plan, overrides = {}) => ({
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
  ...overrides,
});

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
          Status: submitted ? "PREACCEPTED" : "DRAFT",
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

test("moderation accepts a search campaign migrated by Direct to unified objects", async () => {
  const data = fixture();
  let adReads = 0;
  const execution = data.sqlite
    .prepare("SELECT calls_json FROM direct_executions WHERE change_id=?")
    .get(data.changeId);
  const calls = JSON.parse(execution.calls_json);
  calls.find((item) => item.key === "keywords").ids = [111, 112];
  data.sqlite
    .prepare("UPDATE direct_executions SET calls_json=? WHERE change_id=?")
    .run(JSON.stringify(calls), data.changeId);
  const client = {
    campaignBudgetById: async () => ({
      Campaigns: [
        {
          Id: 77,
          State: "OFF",
          Status: "DRAFT",
          Type: "UNIFIED_CAMPAIGN",
          Currency: "RUB",
          UnifiedCampaign: {
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
      Ads:
        ++adReads === 1
          ? []
          : [
        {
          Id: 99,
          CampaignId: 77,
          AdGroupId: 88,
          Status: "DRAFT",
          State: "OFF",
          Type: "RESPONSIVE_AD",
          ResponsiveAd: {
            Titles: [{ Title: data.plan.ads[0].title, Status: "ACCEPTED" }],
            Texts: [{ Text: data.plan.ads[0].text, Status: "ACCEPTED" }],
            AdImages: { Items: [] },
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
  };

  const readiness = await inspectPostgresModerationReadiness(
    data.db,
    data.userId,
    data.businessId,
    data.changeId,
    client,
    data.connectionId,
    Date.parse("2026-11-04T10:00:00.000Z"),
  );

  assert.equal(readiness.status, "technical_ready");
  assert.deepEqual(readiness.blockers, []);
  assert.deepEqual(readiness.warnings, ["keyword_coverage_reduced"]);
  assert.deepEqual(readiness.keywordCoverage, { planned: 2, active: 1 });
  assert.equal(adReads, 2);
  data.sqlite.close();
});

test("network moderation verifies responsive copy and image without keywords", async () => {
  const data = networkFixture();
  let keywordReads = 0;
  const client = {
    campaignBudgetById: async () => ({
      Campaigns: [networkCampaign(data.plan)],
    }),
    adGroupsByIds: async () => ({
      AdGroups: [{ Id: 88, CampaignId: 77, Type: "UNIFIED_AD_GROUP" }],
    }),
    adsByIds: async () => ({
      Ads: [
        {
          Id: 99,
          CampaignId: 77,
          AdGroupId: 88,
          Status: "DRAFT",
          ResponsiveAd: {
            Titles: data.plan.ads[0].titles.map((Title) => ({ Title })),
            Texts: data.plan.ads[0].texts.map((Text) => ({ Text })),
            Href: data.plan.ads[0].href,
            AdImages: {
              Items: [
                {
                  ImageHash: "approved_image_hash-1",
                  Status: "UNKNOWN",
                  StatusClarification: null,
                },
              ],
            },
          },
        },
      ],
    }),
    keywordsByIds: async () => {
      keywordReads++;
      throw new Error("network campaign must not request keywords");
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
  };
  const readiness = await inspectPostgresModerationReadiness(
    data.db,
    data.userId,
    data.businessId,
    data.changeId,
    client,
    data.connectionId,
    Date.parse("2026-11-04T10:00:00.000Z"),
  );
  assert.equal(readiness.status, "technical_ready");
  assert.deepEqual(readiness.blockers, []);
  assert.equal(keywordReads, 0);
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

test("accepted ad stays launch-ready while its held campaign keeps it OFF", async () => {
  const data = fixture();
  const reportJobId = randomUUID();
  data.sqlite
    .prepare(
      "INSERT INTO jobs(id,business_id,kind,status,available_at,attempts,payload,error) VALUES(?,?,'report_sync','succeeded',0,1,'{}',NULL)",
    )
    .run(reportJobId, data.businessId);
  data.sqlite
    .prepare(
      `INSERT INTO report_snapshots
       (id,business_id,job_id,scope,source,login,date_from,date_to,currency,include_vat,received_at,request_id,raw_hash,raw_tsv,rows_json,totals_json,previous_id,comparison_json)
       VALUES(?,?,?,'campaign','yandex','test-login','2026-11-05','2026-11-05','RUB',1,'2026-11-05T08:55:00.000Z',NULL,'hash','header',?,'{}',NULL,'{}')`,
    )
    .run(
      randomUUID(),
      data.businessId,
      reportJobId,
      JSON.stringify([{ CampaignId: "77", Date: "2026-11-05", spent: 0 }]),
    );
  const client = {
    campaignBudgetById: async () => ({
      Campaigns: [
        {
          Id: 77,
          State: "OFF",
          Status: "ACCEPTED",
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
    }),
    adGroupsByIds: async () => ({
      AdGroups: [{ Id: 88, CampaignId: 77 }],
    }),
    adsByIds: async () => ({
      Ads: [
        {
          Id: 99,
          CampaignId: 77,
          AdGroupId: 88,
          Status: "ACCEPTED",
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
  const result = await inspectPostgresDirectControl(
    data.db,
    data.userId,
    data.businessId,
    data.changeId,
    randomUUID(),
    client,
    data.connectionId,
    Date.parse("2026-11-05T09:00:00.000Z"),
  );
  assert.equal(result.blockers.includes("ads_not_ready"), false);
  assert.equal(result.blockers.includes("ads_under_review"), false);
  assert.deepEqual(result.blockers, []);
  assert.equal(result.status, "technical_ready");
  assert.equal(result.budget.spentKopecks, 0);
  data.sqlite.close();
});

test("Yandex landing uses Direct conversions without requiring Metrica", async () => {
  const data = fixture();
  const state = JSON.parse(
    data.sqlite
      .prepare("SELECT state FROM businesses WHERE id=?")
      .get(data.businessId).state,
  );
  state.landingMode = "yandex_landing";
  delete state.counterId;
  delete state.goalId;
  data.sqlite
    .prepare("UPDATE businesses SET state=? WHERE id=?")
    .run(JSON.stringify(state), data.businessId);
  delete data.plan.counterId;
  delete data.plan.goalId;
  data.sqlite
    .prepare("UPDATE direct_changes SET plan_json=? WHERE id=?")
    .run(JSON.stringify(data.plan), data.changeId);
  const reportJobId = randomUUID();
  data.sqlite
    .prepare(
      "INSERT INTO jobs(id,business_id,kind,status,available_at,attempts,payload,error) VALUES(?,?,'report_sync','succeeded',0,1,'{}',NULL)",
    )
    .run(reportJobId, data.businessId);
  data.sqlite
    .prepare(
      `INSERT INTO report_snapshots
       (id,business_id,job_id,scope,source,login,date_from,date_to,currency,include_vat,received_at,request_id,raw_hash,raw_tsv,rows_json,totals_json,previous_id,comparison_json)
       VALUES(?,?,?,'campaign','yandex','test-login','2026-11-05','2026-11-05','RUB',1,'2026-11-05T08:55:00.000Z',NULL,'direct-conversions','header',?,'{}',NULL,'{}')`,
    )
    .run(
      randomUUID(),
      data.businessId,
      reportJobId,
      JSON.stringify([
        {
          CampaignId: "77",
          Date: "2026-11-05",
          spent: 0,
          conversions: 0,
        },
      ]),
    );
  const client = {
    campaignBudgetById: async () => ({
      Campaigns: [
        searchCampaign(data.plan, {
          Status: "ACCEPTED",
          StatusPayment: "ALLOWED",
        }),
      ],
    }),
    adGroupsByIds: async () => ({
      AdGroups: [{ Id: 88, CampaignId: 77 }],
    }),
    adsByIds: async () => ({
      Ads: [
        {
          Id: 99,
          CampaignId: 77,
          AdGroupId: 88,
          Status: "ACCEPTED",
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
  const result = await inspectPostgresDirectControl(
    data.db,
    data.userId,
    data.businessId,
    data.changeId,
    randomUUID(),
    client,
    data.connectionId,
    Date.parse("2026-11-05T09:00:00.000Z"),
  );
  assert.equal(result.status, "technical_ready");
  assert.deepEqual(result.blockers, []);
  assert.deepEqual(result.analytics, {
    source: "direct_conversions",
    ready: true,
  });
  data.sqlite.close();
});

test("accepted network ad reaches launch readiness without keyword objects", async () => {
  const data = networkFixture();
  const reportJobId = randomUUID();
  data.sqlite
    .prepare(
      "INSERT INTO jobs(id,business_id,kind,status,available_at,attempts,payload,error) VALUES(?,?,'report_sync','succeeded',0,1,'{}',NULL)",
    )
    .run(reportJobId, data.businessId);
  data.sqlite
    .prepare(
      `INSERT INTO report_snapshots
       (id,business_id,job_id,scope,source,login,date_from,date_to,currency,include_vat,received_at,request_id,raw_hash,raw_tsv,rows_json,totals_json,previous_id,comparison_json)
       VALUES(?,?,?,'campaign','yandex','test-login','2026-11-05','2026-11-05','RUB',1,'2026-11-05T08:55:00.000Z',NULL,'network-hash','header',?,'{}',NULL,'{}')`,
    )
    .run(
      randomUUID(),
      data.businessId,
      reportJobId,
      JSON.stringify([{ CampaignId: "77", Date: "2026-11-05", spent: 0 }]),
    );
  let keywordReads = 0;
  const client = {
    campaignBudgetById: async () => ({
      Campaigns: [
        networkCampaign(data.plan, {
          Status: "ACCEPTED",
          StatusPayment: "ALLOWED",
        }),
      ],
    }),
    adGroupsByIds: async () => ({
      AdGroups: [{ Id: 88, CampaignId: 77, Type: "UNIFIED_AD_GROUP" }],
    }),
    adsByIds: async () => ({
      Ads: [
        {
          Id: 99,
          CampaignId: 77,
          AdGroupId: 88,
          Status: "ACCEPTED",
          State: "OFF",
        },
      ],
    }),
    keywordsByIds: async () => {
      keywordReads++;
      throw new Error("network campaign must not request keywords");
    },
  };
  const result = await inspectPostgresDirectControl(
    data.db,
    data.userId,
    data.businessId,
    data.changeId,
    randomUUID(),
    client,
    data.connectionId,
    Date.parse("2026-11-05T09:00:00.000Z"),
  );
  assert.equal(result.status, "technical_ready");
  assert.deepEqual(result.blockers, []);
  assert.equal(result.remote.keywords, 0);
  assert.equal(keywordReads, 0);
  data.sqlite.close();
});

test("missing analytics keeps an accepted campaign blocked", async () => {
  const data = fixture();
  data.sqlite.prepare("UPDATE businesses SET state=? WHERE id=?").run(
    JSON.stringify({
      mode: "live",
      name: "Форма",
      website: data.plan.website,
    }),
    data.businessId,
  );
  const reportJobId = randomUUID();
  data.sqlite
    .prepare(
      "INSERT INTO jobs(id,business_id,kind,status,available_at,attempts,payload,error) VALUES(?,?,'report_sync','succeeded',0,1,'{}',NULL)",
    )
    .run(reportJobId, data.businessId);
  data.sqlite
    .prepare(
      `INSERT INTO report_snapshots
       (id,business_id,job_id,scope,source,login,date_from,date_to,currency,include_vat,received_at,request_id,raw_hash,raw_tsv,rows_json,totals_json,previous_id,comparison_json)
       VALUES(?,?,?,'campaign','yandex','test-login','2026-11-05','2026-11-05','RUB',1,'2026-11-05T08:55:00.000Z',NULL,'analytics-missing','header',?,'{}',NULL,'{}')`,
    )
    .run(
      randomUUID(),
      data.businessId,
      reportJobId,
      JSON.stringify([{ CampaignId: "77", Date: "2026-11-05", spent: 0 }]),
    );
  const client = {
    campaignBudgetById: async () => ({
      Campaigns: [
        searchCampaign(data.plan, {
          Status: "ACCEPTED",
          StatusPayment: "ALLOWED",
        }),
      ],
    }),
    adGroupsByIds: async () => ({
      AdGroups: [{ Id: 88, CampaignId: 77 }],
    }),
    adsByIds: async () => ({
      Ads: [
        {
          Id: 99,
          CampaignId: 77,
          AdGroupId: 88,
          Status: "ACCEPTED",
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
  const result = await inspectPostgresDirectControl(
    data.db,
    data.userId,
    data.businessId,
    data.changeId,
    randomUUID(),
    client,
    data.connectionId,
    Date.parse("2026-11-05T09:00:00.000Z"),
  );
  assert.equal(result.status, "blocked");
  assert.ok(result.blockers.includes("analytics_not_configured"));
  assert.equal(result.externalWrites, 0);
  data.sqlite.close();
});
