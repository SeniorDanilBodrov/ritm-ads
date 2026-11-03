import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { openDatabase } from "../server/db.js";
import {
  latestLiveShadowReview,
  runLiveShadowReview,
} from "../server/live-shadow.js";
import {
  scheduleLiveReports,
  scheduleLiveShadowReviews,
  runLiveShadowCycle,
} from "../server/live-data-worker.js";

const now = Date.parse("2026-11-03T12:00:00Z");
const digest = (value) => createHash("sha256").update(value).digest("hex");

function fixture({
  start = "2026-11-01",
  received = "2026-11-03T08:00:00Z",
  reportDateTo = "2026-11-02",
  withReport = true,
} = {}) {
  const db = openDatabase(":memory:");
  const userId = randomUUID(),
    businessId = randomUUID(),
    changeId = randomUUID();
  const connectionId = randomUUID(),
    campaignId = 715574939;
  const state = {
    mode: "live",
    timezone: "Asia/Yekaterinburg",
    counterId: "123",
    goalId: "456",
    periodStart: "2026-11-01",
    periodEnd: "2026-11-14",
    campaigns: [],
  };
  db.prepare("INSERT INTO users VALUES(?,?,?,?)").run(
    userId,
    `google:${userId}`,
    "Tester",
    new Date(now).toISOString(),
  );
  db.prepare("INSERT INTO businesses VALUES(?,?,?,1)").run(
    businessId,
    userId,
    JSON.stringify(state),
  );
  db.prepare("INSERT INTO connections VALUES(?,?,?,?)").run(
    businessId,
    "yandex",
    "encrypted",
    JSON.stringify({
      connectionId,
      sandbox: false,
      clients: [{ Login: "test-client", Currency: "RUB" }],
    }),
  );
  db.prepare(
    "INSERT INTO jobs(id,business_id,kind,status,available_at,payload) VALUES(?,?,?,'succeeded',?,?)",
  ).run(changeId, businessId, "direct_dry_run", now, "{}");
  const plan = {
    login: "test-client",
    periodStart: start,
    periodEnd: "2026-11-14",
    counterId: "123",
    goalId: "456",
  };
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
    new Date(now).toISOString(),
    new Date(now).toISOString(),
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
    JSON.stringify([{ key: "campaign", ids: [campaignId] }]),
    new Date(now).toISOString(),
    new Date(now).toISOString(),
  );
  if (withReport) {
    const reportJob = randomUUID(),
      reportId = randomUUID();
    db.prepare(
      "INSERT INTO jobs(id,business_id,kind,status,available_at,payload) VALUES(?,?,?,'succeeded',?,?)",
    ).run(
      reportJob,
      businessId,
      "report_sync",
      now,
      JSON.stringify({ signature: digest(connectionId) }),
    );
    const rows = [
      {
        Date: "2026-11-02",
        CampaignId: String(campaignId),
        spent: 15000,
        clicks: 50,
        impressions: 500,
      },
      {
        Date: "2026-11-02",
        CampaignId: "999",
        spent: 8000,
        clicks: 20,
        impressions: 200,
      },
    ];
    db.prepare(
      `INSERT INTO report_snapshots
      (id,business_id,job_id,scope,source,login,date_from,date_to,currency,
      include_vat,received_at,request_id,raw_hash,raw_tsv,rows_json,totals_json,
      previous_id,comparison_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      reportId,
      businessId,
      reportJob,
      "scope",
      "yandex",
      plan.login,
      "2026-11-01",
      reportDateTo,
      "RUB",
      1,
      received,
      null,
      "hash",
      "tsv",
      JSON.stringify(rows),
      "{}",
      null,
      "{}",
    );
  }
  return { db, userId, businessId, changeId, connectionId, campaignId, state };
}

test("live shadow review combines matching source dates without inventing campaign goals", async () => {
  const f = fixture();
  try {
    let metricaReads = 0,
      directReads = 0;
    const providers = {
      connectionId: f.connectionId,
      metrica: {
        statistics: async (counter, goal, from, to) => {
          metricaReads++;
          assert.deepEqual(
            [counter, goal, from, to],
            ["123", "456", "2026-11-01", "2026-11-02"],
          );
          return { totals: [60, 3], sampled: false };
        },
      },
      direct: {
        campaignsByIds: async (ids) => {
          directReads++;
          assert.deepEqual(ids, [f.campaignId]);
          return {
            Campaigns: [{ Id: f.campaignId, State: "ON", Status: "ACCEPTED" }],
          };
        },
      },
    };
    const key = randomUUID();
    const result = await runLiveShadowReview(
      f.db,
      f.userId,
      f.businessId,
      f.changeId,
      key,
      providers,
      now,
    );
    assert.equal(result.status, "observed");
    assert.equal(result.action, "review_attribution");
    assert.equal(result.executed, false);
    assert.equal(result.source.direct.spentKopecks, 15000);
    assert.equal(result.source.direct.clicks, 50);
    assert.equal(result.source.metrica.goalReaches, 3);
    assert.equal(result.source.campaignGoalReaches, null);
    assert.equal(result.source.campaignCpaKopecks, null);
    assert.equal(result.source.attribution, "site_wide_only");
    assert.deepEqual(
      latestLiveShadowReview(f.db, f.userId, f.businessId, f.changeId),
      result,
    );
    assert.deepEqual(
      JSON.parse(
        f.db
          .prepare("SELECT state FROM businesses WHERE id=?")
          .get(f.businessId).state,
      ),
      f.state,
    );
    assert.deepEqual(
      await runLiveShadowReview(
        f.db,
        f.userId,
        f.businessId,
        f.changeId,
        key,
        providers,
        now,
      ),
      result,
    );
    assert.equal(metricaReads, 1);
    assert.equal(directReads, 1);
  } finally {
    f.db.close();
  }
});

test("live shadow review calculates CPA only from exact Direct campaign attribution", async () => {
  const f = fixture();
  try {
    const result = await runLiveShadowReview(
      f.db,
      f.userId,
      f.businessId,
      f.changeId,
      randomUUID(),
      {
        connectionId: f.connectionId,
        metrica: {
          statistics: async () => ({ totals: [60, 3], sampled: false }),
          campaignStatistics: async (counter, goal, campaign, from, to) => {
            assert.deepEqual(
              [counter, goal, campaign, from, to],
              ["123", "456", f.campaignId, "2026-11-01", "2026-11-02"],
            );
            return { totals: [20, 2], sampled: false };
          },
        },
        direct: {
          campaignsByIds: async () => ({
            Campaigns: [{ Id: f.campaignId, State: "ON", Status: "ACCEPTED" }],
          }),
        },
      },
      now,
    );
    assert.equal(result.action, "review_campaign_performance");
    assert.equal(result.source.attribution, "direct_campaign_last_significant");
    assert.equal(result.source.campaignGoalReaches, 2);
    assert.equal(result.source.campaignCpaKopecks, 7500);
    assert.equal(result.source.attributedMetrica.campaignId, f.campaignId);
    assert.equal(
      result.source.attributedMetrica.filterDimension,
      "ym:s:lastsignDirectClickOrder",
    );
    assert.equal(result.executed, false);
  } finally {
    f.db.close();
  }
});

test("future period and missing report never call either provider", async () => {
  for (const options of [{ start: "2026-11-04" }, { withReport: false }]) {
    const f = fixture(options);
    try {
      const providers = {
        connectionId: f.connectionId,
        metrica: {
          statistics: async () => assert.fail("Metrica must not be read"),
        },
        direct: {
          campaignsByIds: async () => assert.fail("Direct must not be read"),
        },
      };
      const result = await runLiveShadowReview(
        f.db,
        f.userId,
        f.businessId,
        f.changeId,
        randomUUID(),
        providers,
        now,
      );
      assert.equal(result.status, "insufficient");
      assert.equal(result.action, "observe");
      assert.equal(
        result.blocker,
        options.start ? "period_not_started" : "direct_report_missing",
      );
      assert.equal(result.executed, false);
    } finally {
      f.db.close();
    }
  }
});

test("stale report and changed connection block live decisions", async () => {
  const f = fixture({ received: "2026-10-28T08:00:00Z" });
  try {
    const providers = {
      connectionId: f.connectionId,
      metrica: { statistics: async () => assert.fail("stale source") },
      direct: { campaignsByIds: async () => assert.fail("stale source") },
    };
    await assert.rejects(
      runLiveShadowReview(
        f.db,
        f.userId,
        f.businessId,
        f.changeId,
        randomUUID(),
        { ...providers, connectionId: randomUUID() },
        now,
      ),
      /подключение изменились/,
    );
    const result = await runLiveShadowReview(
      f.db,
      f.userId,
      f.businessId,
      f.changeId,
      randomUUID(),
      providers,
      now,
    );
    assert.equal(result.status, "insufficient");
    assert.equal(result.blocker, "direct_report_stale");
    assert.equal(result.source.campaignCpaKopecks, null);
  } finally {
    f.db.close();
  }
});

test("unusable Metrica data cannot create a shadow recommendation", async () => {
  const f = fixture();
  try {
    for (const stats of [
      { totals: [60, 3], sampled: true },
      { totals: [60, -1], sampled: false },
      { totals: [60], sampled: false },
    ]) {
      await assert.rejects(
        runLiveShadowReview(
          f.db,
          f.userId,
          f.businessId,
          f.changeId,
          randomUUID(),
          {
            connectionId: f.connectionId,
            metrica: { statistics: async () => stats },
            direct: {
              campaignsByIds: async () => ({
                Campaigns: [
                  { Id: f.campaignId, State: "OFF", Status: "DRAFT" },
                ],
              }),
            },
          },
          now,
        ),
        /проверку формата или полноты/,
      );
    }
    await assert.rejects(
      runLiveShadowReview(
        f.db,
        f.userId,
        f.businessId,
        f.changeId,
        randomUUID(),
        {
          connectionId: f.connectionId,
          metrica: {
            statistics: async () => ({ totals: [60, 3], sampled: false }),
            campaignStatistics: async () => ({
              totals: [20, 2],
              sampled: true,
            }),
          },
          direct: {
            campaignsByIds: async () => ({
              Campaigns: [{ Id: f.campaignId, State: "OFF", Status: "DRAFT" }],
            }),
          },
        },
        now,
      ),
      /Атрибуция Метрики не прошла проверку/,
    );
    assert.equal(
      latestLiveShadowReview(f.db, f.userId, f.businessId, f.changeId),
      null,
    );
  } finally {
    f.db.close();
  }
});

test("simultaneous retries with one key return one journal record", async () => {
  const f = fixture();
  try {
    const providers = {
      connectionId: f.connectionId,
      metrica: { statistics: async () => ({ totals: [0, 0], sampled: false }) },
      direct: {
        campaignsByIds: async () => ({
          Campaigns: [{ Id: f.campaignId, State: "OFF", Status: "DRAFT" }],
        }),
      },
    };
    const requestKey = randomUUID();
    const [first, second] = await Promise.all([
      runLiveShadowReview(
        f.db,
        f.userId,
        f.businessId,
        f.changeId,
        requestKey,
        providers,
        now,
      ),
      runLiveShadowReview(
        f.db,
        f.userId,
        f.businessId,
        f.changeId,
        requestKey,
        providers,
        now,
      ),
    ]);
    assert.deepEqual(second, first);
    assert.equal(
      f.db.prepare("SELECT count(*) AS n FROM direct_shadow_reviews").get().n,
      1,
    );
  } finally {
    f.db.close();
  }
});

test("daily report schedule waits for the campaign and enqueues once", () => {
  const f = fixture({ withReport: false });
  try {
    assert.equal(
      scheduleLiveReports(f.db, Date.parse("2026-10-29T12:00:00Z")),
      0,
    );
    assert.equal(scheduleLiveReports(f.db, now), 1);
    assert.equal(scheduleLiveReports(f.db, now), 0);
    const job = f.db
      .prepare("SELECT status,payload FROM jobs WHERE kind='report_sync'")
      .get();
    assert.equal(job.status, "pending");
    const payload = JSON.parse(job.payload);
    assert.deepEqual(
      [payload.source, payload.login, payload.dateFrom, payload.dateTo],
      ["yandex", "test-client", "2026-11-01", "2026-11-03"],
    );
    assert.equal(payload.signature, digest(f.connectionId));
    assert.equal(
      f.db.prepare("SELECT count(*) AS n FROM direct_shadow_reviews").get().n,
      0,
    );
  } finally {
    f.db.close();
  }
});

test("a fresh report queues one read-only shadow job and stores no campaign CPA", async () => {
  const f = fixture();
  try {
    assert.equal(scheduleLiveShadowReviews(f.db, now), 1);
    assert.equal(scheduleLiveShadowReviews(f.db, now), 0);
    let reads = 0;
    const result = await runLiveShadowCycle(f.db, {
      now,
      key: Buffer.alloc(32),
      config: {},
      connectionRunner: async (_options, read) =>
        read({
          credentials: { access_token: "test" },
          metadata: { connectionId: f.connectionId },
        }),
      metricaFactory: () => ({
        statistics: async () => {
          reads++;
          return { totals: [60, 3], sampled: false };
        },
      }),
      directFactory: () => ({
        campaignsByIds: async () => {
          reads++;
          return {
            Campaigns: [{ Id: f.campaignId, State: "OFF", Status: "DRAFT" }],
          };
        },
      }),
    });
    assert.equal(result.status, "succeeded");
    assert.equal(reads, 2);
    assert.equal((await runLiveShadowCycle(f.db, { now })).status, "idle");
    const review = latestLiveShadowReview(
      f.db,
      f.userId,
      f.businessId,
      f.changeId,
    );
    assert.equal(review.source.direct.spentKopecks, 15000);
    assert.equal(review.source.metrica.goalReaches, 3);
    assert.equal(review.source.campaignCpaKopecks, null);
    assert.equal(review.executed, false);
  } finally {
    f.db.close();
  }
});

test("post-period report covers only campaign dates", async () => {
  const later = Date.parse("2026-11-15T12:00:00Z");
  const f = fixture({
    reportDateTo: "2026-11-15",
    received: "2026-11-15T08:00:00Z",
  });
  try {
    const result = await runLiveShadowReview(
      f.db,
      f.userId,
      f.businessId,
      f.changeId,
      randomUUID(),
      {
        connectionId: f.connectionId,
        metrica: {
          statistics: async (_counter, _goal, from, to) => {
            assert.deepEqual([from, to], ["2026-11-01", "2026-11-14"]);
            return { totals: [60, 3], sampled: false };
          },
        },
        direct: {
          campaignsByIds: async () => ({
            Campaigns: [{ Id: f.campaignId, State: "OFF", Status: "DRAFT" }],
          }),
        },
      },
      later,
    );
    assert.equal(result.status, "observed");
    assert.equal(result.source.direct.dateTo, "2026-11-14");
    assert.equal(result.source.direct.snapshotDateTo, "2026-11-15");
  } finally {
    f.db.close();
  }
});

test("background source errors back off and stop after three attempts", async () => {
  const f = fixture();
  try {
    assert.equal(scheduleLiveShadowReviews(f.db, now), 1);
    let calls = 0;
    const options = {
      key: Buffer.alloc(32),
      config: {},
      connectionRunner: async () => {
        calls++;
        throw new Error("temporary provider failure");
      },
    };
    assert.equal(
      (await runLiveShadowCycle(f.db, { ...options, now })).status,
      "pending",
    );
    assert.equal(
      (await runLiveShadowCycle(f.db, { ...options, now })).status,
      "idle",
    );
    assert.equal(
      (await runLiveShadowCycle(f.db, { ...options, now: now + 300000 }))
        .status,
      "pending",
    );
    assert.equal(
      (await runLiveShadowCycle(f.db, { ...options, now: now + 1200000 }))
        .status,
      "failed",
    );
    assert.equal(calls, 3);
    assert.equal(scheduleLiveShadowReviews(f.db, now + 1200000), 0);
    assert.equal(
      latestLiveShadowReview(f.db, f.userId, f.businessId, f.changeId),
      null,
    );
  } finally {
    f.db.close();
  }
});
