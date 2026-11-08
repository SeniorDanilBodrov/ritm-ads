import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { openDatabase } from "../server/db.js";
import { seedDemo } from "../server/engine.js";
import { encrypt } from "../server/security.js";
import { directAbPlans } from "../server/direct-ab.js";
import {
  DirectClient,
  ProviderError,
  parseReport,
} from "../server/providers.js";
import {
  enqueueAbReport,
  enqueueReport,
  runReportCycle,
  reportView,
  compareReports,
} from "../server/reports.js";
const now = Date.UTC(2026, 9, 24),
  raw =
    "Date\tCampaignId\tCampaignName\tImpressions\tClicks\tCost\n2026-10-01\t1\tТест\t100\t10\t12.34\n";
function fixture(live = false) {
  const db = openDatabase(":memory:"),
    key = randomBytes(32),
    state = seedDemo();
  state.periodStart = "2026-10-01";
  state.periodEnd = "2026-10-31";
  state.mode = live ? "live" : "demo";
  db.prepare("INSERT INTO users VALUES(?,?,?,?)").run(
    "u",
    "demo:u",
    "Test",
    "2026-10-24",
  );
  db.prepare("INSERT INTO businesses VALUES(?,?,?,1)").run(
    "b",
    "u",
    JSON.stringify(state),
  );
  if (live)
    db.prepare("INSERT INTO connections VALUES(?,?,?,?)").run(
      "b",
      "yandex",
      encrypt({ access_token: "test-secret" }, key, "b:yandex"),
      JSON.stringify({
        sandbox: false,
        clients: [{ Login: "account-a", Currency: "RUB" }],
      }),
    );
  return { db, key, state };
}
const enqueue = (db, options = {}, key = randomUUID()) =>
  enqueueReport(db, "u", "b", key, options, now);
const snapshots = (db) =>
  db.prepare("SELECT count(*) AS n FROM report_snapshots").get().n;

test("future period is rejected and report end is capped at the business local date", () => {
  const { db, state } = fixture();
  try {
    const queued = enqueue(db),
      payload = JSON.parse(
        db.prepare("SELECT payload FROM jobs WHERE id=?").get(queued.jobId)
          .payload,
      );
    assert.equal(payload.dateTo, "2026-10-24");
    db.prepare("UPDATE jobs SET status='cancelled'").run();
    state.periodStart = "2026-11-01";
    state.periodEnd = "2026-11-30";
    db.prepare("UPDATE businesses SET state=?").run(JSON.stringify(state));
    assert.throws(() => enqueue(db), /не начался/);
  } finally {
    db.close();
  }
});

test("A/B report is bound to the saved pair and stores ad-level rows", async () => {
  const { db, key } = fixture(true);
  try {
    const changeId = randomUUID(),
      planId = randomUUID(),
      createdAt = new Date(now).toISOString();
    db.prepare(
      "INSERT INTO jobs(id,business_id,kind,status,available_at,payload) VALUES(?,?,'direct_change','succeeded',?,'{}')",
    ).run(changeId, "b", now);
    db.prepare(
      `INSERT INTO direct_changes(
        id,business_id,idempotency_key,mode,plan_json,commands_json,created_at,updated_at
      ) VALUES(?,?,'change-key','dry-run',?,'[]',?,?)`,
    ).run(
      changeId,
      "b",
      JSON.stringify({ login: "account-a" }),
      createdAt,
      createdAt,
    );
    db.prepare(
      `INSERT INTO direct_ab_plans(
        id,business_id,change_id,connection_id,campaign_id,control_ad_id,
        idempotency_key,fingerprint,plan_json,created_at
      ) VALUES(?,? ,?,'connection',123,'401','plan-key','fingerprint',?,?)`,
    ).run(
      planId,
      "b",
      changeId,
      JSON.stringify({
        control: { adId: "401" },
        variant: { adId: "402" },
        periodStart: "2026-10-01",
        periodEnd: "2026-10-31",
        minDays: 7,
        minImpressionsPerVariant: 500,
      }),
      createdAt,
    );
    const queued = enqueueAbReport(db, "u", "b", randomUUID(), planId, now),
      payload = JSON.parse(
        db.prepare("SELECT payload FROM jobs WHERE id=?").get(queued.jobId)
          .payload,
      );
    assert.equal(payload.reportType, "ad");
    assert.deepEqual(payload.adIds, ["401", "402"]);
    const result = await runReportCycle(db, {
      now,
      key,
      clientFactory: () => ({
        report: async (_from, _to, options) => {
          assert.deepEqual(options, {
            reportType: "ad",
            adIds: ["401", "402"],
          });
          return {
            pending: false,
            includeVat: true,
            rawTsv:
              "Date\tCampaignId\tCampaignName\tAdGroupId\tAdId\tImpressions\tClicks\tCost\n" +
              "2026-10-01\t123\tТест\t20\t401\t100\t5\t12.34\n" +
              "2026-10-01\t123\tТест\t20\t402\t120\t8\t15.00\n",
          };
        },
      }),
    });
    assert.equal(result.status, "succeeded");
    const snapshot = reportView(db, "b")[0];
    assert.equal(snapshot.reportType, "ad");
    assert.equal(snapshot.abPlanId, planId);
    assert.deepEqual(
      snapshot.rows.map((row) => row.AdId),
      ["401", "402"],
    );
    let plan = directAbPlans(db, "u", "b")[0];
    assert.equal(plan.outcome, "inconclusive");
    assert.equal(plan.evidence.allocationBalanced, true);
    assert.equal(plan.evidence.sampleMet, true);
    assert.match(plan.verdict, /пока нет/);
    db.prepare(
      "UPDATE report_snapshots SET date_to='2026-10-31',rows_json=? WHERE id=?",
    ).run(
      JSON.stringify([
        {
          Date: "2026-10-31",
          CampaignId: "123",
          AdId: "401",
          impressions: 1000,
          clicks: 20,
          spent: 1000,
        },
        {
          Date: "2026-10-31",
          CampaignId: "123",
          AdId: "402",
          impressions: 1000,
          clicks: 100,
          spent: 1000,
        },
      ]),
      snapshot.id,
    );
    plan = directAbPlans(db, "u", "b")[0];
    assert.equal(plan.outcome, "variant_wins");
    assert.equal(plan.blockers.length, 0);
    assert.match(plan.verdict, /Вариант Б/);
  } finally {
    db.close();
  }
});

test("report snapshots from different date ranges are never reconciled together", async () => {
  const { db, state } = fixture();
  try {
    enqueue(db);
    await runReportCycle(db, { now });
    state.periodStart = "2026-10-02";
    db.prepare("UPDATE businesses SET state=?").run(JSON.stringify(state));
    enqueue(db);
    await runReportCycle(db, { now: now + 10000 });
    const latest = reportView(db, "b")[0];
    assert.equal(latest.comparison.status, "first");
    assert.equal(latest.previousId, null);
    assert.equal(snapshots(db), 2);
  } finally {
    db.close();
  }
});

test("report polling stops after 30 pending responses and records failure once", async () => {
  const { db, key } = fixture(true);
  try {
    enqueue(db, { login: "account-a" });
    const clientFactory = () => ({
      report: async () => ({ pending: true, retryAfter: 1 }),
    });
    for (let i = 0; i < 30; i++)
      assert.equal(
        (await runReportCycle(db, { now: now + i * 1000, key, clientFactory }))
          .status,
        i === 29 ? "failed" : "pending",
      );
    assert.equal(
      (await runReportCycle(db, { now: now + 60000, key, clientFactory }))
        .status,
      "idle",
    );
    assert.equal(snapshots(db), 0);
    assert.equal(db.prepare("SELECT count(*) AS n FROM events").get().n, 1);
  } finally {
    db.close();
  }
});

test("report queue ownership, idempotency and active-job conflict", () => {
  const { db } = fixture();
  try {
    const key = randomUUID();
    assert.throws(
      () => enqueueReport(db, "other", "b", key, {}, now),
      /не найден/,
    );
    const a = enqueue(db, {}, key);
    assert.deepEqual(enqueue(db, {}, key), a);
    assert.throws(() => enqueue(db, { scenario: "revised" }, key), /Ключ/);
    assert.throws(() => enqueue(db), /уже ожидает/);
  } finally {
    db.close();
  }
});
test("snapshot stores raw hash, normalized rows and totals without changing business", async () => {
  const { db, state } = fixture();
  try {
    enqueue(db);
    const result = await runReportCycle(db, { now });
    assert.equal(result.status, "succeeded");
    const stored = db.prepare("SELECT * FROM report_snapshots").get(),
      view = reportView(db, "b")[0];
    assert.equal(
      stored.raw_hash,
      createHash("sha256").update(stored.raw_tsv).digest("hex"),
    );
    assert.equal(
      view.totals.spent,
      state.campaigns.reduce((n, c) => n + c.spent, 0),
    );
    assert.equal(view.source, "demo");
    assert.equal(view.comparison.status, "first");
    assert.deepEqual(
      JSON.parse(db.prepare("SELECT state FROM businesses").get().state),
      state,
    );
    assert.equal(db.prepare("SELECT version FROM businesses").get().version, 1);
  } finally {
    db.close();
  }
});
test("unchanged source is deduplicated; corrected report is a new snapshot, not added spend", async () => {
  const { db } = fixture();
  try {
    enqueue(db);
    await runReportCycle(db, { now });
    const first = reportView(db, "b")[0];
    enqueue(db);
    await runReportCycle(db, { now: now + 10000 });
    assert.equal(snapshots(db), 1);
    enqueue(db, { scenario: "revised" });
    await runReportCycle(db, { now: now + 20000 });
    const latest = reportView(db, "b")[0];
    assert.equal(snapshots(db), 2);
    assert.equal(latest.previousId, first.id);
    assert.equal(latest.comparison.deltaSpent, 12500);
    assert.equal(latest.totals.spent, first.totals.spent + 12500);
    assert.equal(latest.comparison.changedRows, 1);
  } finally {
    db.close();
  }
});
test("pending report respects retry time and is not saved as zero", async () => {
  const { db } = fixture();
  try {
    enqueue(db, { scenario: "pending" });
    assert.equal((await runReportCycle(db, { now })).status, "pending");
    assert.equal(snapshots(db), 0);
    assert.equal(
      (await runReportCycle(db, { now: now + 4999 })).status,
      "idle",
    );
    assert.equal(
      (await runReportCycle(db, { now: now + 5000 })).status,
      "succeeded",
    );
    assert.ok(reportView(db, "b")[0].totals.spent > 0);
  } finally {
    db.close();
  }
});
test("malformed or out-of-period rows do not replace the previous snapshot", async () => {
  const { db } = fixture();
  try {
    enqueue(db);
    await runReportCycle(db, { now });
    const original = reportView(db, "b")[0];
    for (const bad of [
      raw.replace("12.34", "NaN"),
      raw.replace("2026-10-01", "2026-09-01"),
      "Date\tCampaignId\tCampaignName\tCost\n2026-10-01\t1\tТест\t12.34\n",
    ]) {
      const j = enqueue(db),
        payload = JSON.parse(
          db.prepare("SELECT payload FROM jobs WHERE id=?").get(j.jobId)
            .payload,
        );
      payload.rawTsv = bad;
      db.prepare("UPDATE jobs SET payload=? WHERE id=?").run(
        JSON.stringify(payload),
        j.jobId,
      );
      assert.equal(
        (await runReportCycle(db, { now: now + 10000 })).status,
        "failed",
      );
      assert.equal(snapshots(db), 1);
      assert.equal(reportView(db, "b")[0].id, original.id);
    }
  } finally {
    db.close();
  }
});
test("row reconciliation retains missing spend and compares by date plus campaign", () => {
  const a = parseReport(raw),
    b = parseReport(raw.replace("12.34", "10.00"));
  const diff = compareReports(a, b);
  assert.equal(diff.deltaSpent, -234);
  assert.equal(diff.conservativeSpent, 1234);
  const missing = compareReports(a, []);
  assert.equal(missing.missingRows, 1);
  assert.equal(missing.conservativeSpent, 1234);
  const added = compareReports([], a);
  assert.equal(added.addedRows, 1);
  assert.equal(added.conservativeSpent, 1234);
});
test("strict parser rejects unsafe numbers, malformed dates, duplicate rows and columns", () => {
  for (const invalid of [
    "",
    raw.replace("12.34", "1.001"),
    raw.replace("12.34", "9007199254740992.00"),
    raw.replace("\t100\t10\t", "\t100\tNaN\t"),
    raw.replace("2026-10-01", "2026-02-30"),
    raw + raw.split("\n")[1] + "\n",
    raw.replace("CampaignName", "CampaignId"),
  ])
    assert.throws(() => parseReport(invalid));
  assert.deepEqual(parseReport(raw.split("\n")[0] + "\n"), []);
});
test("real adapter contract: same production report request after 202", async () => {
  const { db, key } = fixture(true);
  try {
    enqueue(db, { login: "account-a" });
    const requests = [];
    const clientFactory = (opts) =>
      new DirectClient({
        ...opts,
        fetcher: async (url, options) => {
          requests.push({ url, body: options.body });
          return requests.length === 1
            ? new Response("", { status: 202, headers: { retryIn: "45" } })
            : new Response(raw, { headers: { RequestId: "trace-1" } });
        },
      });
    assert.equal(
      (await runReportCycle(db, { now, key, clientFactory })).status,
      "pending",
    );
    assert.equal(
      (await runReportCycle(db, { now: now + 44999, key, clientFactory }))
        .status,
      "idle",
    );
    assert.equal(
      (await runReportCycle(db, { now: now + 45000, key, clientFactory }))
        .status,
      "succeeded",
    );
    assert.deepEqual(requests[0], requests[1]);
    const snapshot = reportView(db, "b")[0];
    assert.equal(snapshot.source, "yandex");
    assert.equal(snapshot.totals.spent, 1234);
    assert.equal(
      db.prepare("SELECT request_id FROM report_snapshots").get().request_id,
      "trace-1",
    );
  } finally {
    db.close();
  }
});
test("ready report without rows is marked as empty, not as zero performance", async () => {
  const { db, key } = fixture(true);
  try {
    const state = JSON.parse(db.prepare("SELECT state FROM businesses WHERE id='b'").get().state);
    state.counterId = "123";
    state.goalId = "456";
    db.prepare("UPDATE businesses SET state=? WHERE id='b'").run(JSON.stringify(state));
    enqueue(db, { login: "account-a" });
    const result = await runReportCycle(db, {
      now,
      key,
      clientFactory: (opts) =>
        new DirectClient({
          ...opts,
          fetcher: async () =>
            new Response(
              "Date\tCampaignId\tCampaignName\tImpressions\tClicks\tCost\n",
              { headers: { RequestId: "empty-ready" } },
            ),
        }),
      metricaFactory: () => ({
        statistics: async () => ({ totals: [10, 9], sampled: false }),
      }),
    });
    assert.equal(result.status, "succeeded");
    assert.equal(result.empty, true);
    const report = reportView(db, "b")[0];
    assert.equal(report.empty, true);
    assert.equal(report.totals.rowCount, 0);
    assert.equal(report.rows.length, 0);
    assert.deepEqual(report.metrica, {
      status: "ready",
      counterId: "123",
      goalId: "456",
      dateFrom: "2026-10-01",
      dateTo: "2026-10-24",
      visits: 10,
      goalReaches: 9,
      sampled: false,
    });
    const latestEvent = JSON.parse(
      db.prepare("SELECT payload FROM events WHERE business_id='b' AND json_extract(payload,'$.kind')='report' ORDER BY rowid DESC LIMIT 1").get().payload,
    );
    assert.match(
      latestEvent.title,
      /данных пока нет/iu,
    );
  } finally {
    db.close();
  }
});
test("token refresh keeps a queued report bound to the same connection", async () => {
  const { db, key } = fixture(true),
    connectionId = "stable-report-connection";
  try {
    db.prepare("UPDATE connections SET encrypted=?,metadata=?").run(
      encrypt(
        {
          access_token: "expired-access",
          refresh_token: "saved-refresh",
          expires_at: now - 1,
        },
        key,
        "b:yandex",
      ),
      JSON.stringify({
        connectionId,
        sandbox: false,
        clients: [{ Login: "account-a", Currency: "RUB" }],
      }),
    );
    enqueue(db, { login: "account-a" });
    let refreshes = 0,
      usedToken;
    const result = await runReportCycle(db, {
      now,
      key,
      config: { yandexId: "client-id", yandexSecret: "client-secret" },
      refreshToken: async () => {
        refreshes++;
        return {
          access_token: "fresh-access",
          refresh_token: "fresh-refresh",
          expires_in: 3600,
        };
      },
      clientFactory: ({ accessToken }) => ({
        report: async () => {
          usedToken = accessToken;
          return { pending: false, rawTsv: raw, includeVat: true };
        },
      }),
    });
    assert.equal(result.status, "succeeded");
    assert.equal(refreshes, 1);
    assert.equal(usedToken, "fresh-access");
    assert.equal(snapshots(db), 1);
    assert.equal(
      JSON.parse(db.prepare("SELECT metadata FROM connections").get().metadata)
        .connectionId,
      connectionId,
    );
  } finally {
    db.close();
  }
});
test("unknown account and non-RUB currency are rejected before network", () => {
  const { db } = fixture(true);
  try {
    assert.throws(
      () => enqueue(db, { login: "other-account" }),
      /не принадлежит/,
    );
    db.prepare("UPDATE connections SET metadata=?").run(
      JSON.stringify({
        sandbox: false,
        clients: [{ Login: "account-a", Currency: "USD" }],
      }),
    );
    assert.throws(() => enqueue(db, { login: "account-a" }), /RUB/);
    assert.equal(db.prepare("SELECT count(*) AS n FROM jobs").get().n, 0);
  } finally {
    db.close();
  }
});
test("reconnected account cancels an in-flight report", async () => {
  const { db, key } = fixture(true);
  try {
    enqueue(db, { login: "account-a" });
    const result = await runReportCycle(db, {
      now,
      key,
      clientFactory: () => ({
        report: async () => {
          db.prepare("UPDATE connections SET encrypted=?").run("changed");
          return { rawTsv: raw, pending: false, includeVat: true };
        },
      }),
    });
    assert.equal(result.status, "cancelled");
    assert.equal(snapshots(db), 0);
  } finally {
    db.close();
  }
});
test("read failures retry at most three times and never store raw error text", async () => {
  const { db, key } = fixture(true);
  try {
    enqueue(db, { login: "account-a" });
    const clientFactory = () => ({
      report: async () => {
        throw new ProviderError("SECRET_TOKEN", true);
      },
    });
    for (const [offset, status] of [
      [0, "pending"],
      [15000, "pending"],
      [45000, "failed"],
    ])
      assert.equal(
        (await runReportCycle(db, { now: now + offset, key, clientFactory }))
          .status,
        status,
      );
    assert.equal(snapshots(db), 0);
    assert.ok(
      !JSON.stringify(db.prepare("SELECT * FROM jobs").all()).includes(
        "SECRET_TOKEN",
      ),
    );
  } finally {
    db.close();
  }
});
test("expired worker cannot overwrite a report completed by another lease", async () => {
  const { db, key } = fixture(true);
  try {
    enqueue(db, { login: "account-a" });
    let finish, started;
    const ready = new Promise((r) => (started = r));
    const first = runReportCycle(db, {
      now,
      key,
      clientFactory: () => ({
        report: () => {
          started();
          return new Promise((r) => (finish = r));
        },
      }),
    });
    await ready;
    const result = await runReportCycle(db, {
      now: now + 60000,
      key,
      clientFactory: () => ({
        report: async () => ({ pending: false, rawTsv: raw, includeVat: true }),
      }),
    });
    finish({
      pending: false,
      rawTsv: raw.replace("12.34", "99.99"),
      includeVat: true,
    });
    assert.equal((await first).status, "lease_lost");
    assert.equal(result.status, "succeeded");
    assert.equal(reportView(db, "b")[0].totals.spent, 1234);
    assert.equal(snapshots(db), 1);
  } finally {
    db.close();
  }
});
