import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { openDatabase } from "../server/db.js";
import {
  buildDirectCommands,
  confirmDirectPlan,
  directChangeForPreflight,
  directChanges,
  enqueueDirectDryRun,
  evaluateDirectPreflight,
  executeDirectCommands,
  previousDirectPreflight,
  reconcileDirectObjects,
  runDirectCycle,
  saveDirectPreflight,
} from "../server/direct.js";

const plan = () => ({
  login: "client-login",
  campaignName: "Ремонт · Екатеринбург",
  website: "https://example.test/service",
  audience: "Владельцы квартир",
  regionIds: [54],
  budget: 50_000_00,
  targetCpa: 1_500_00,
  periodStart: "2026-10-25",
  periodEnd: "2026-11-25",
  counterId: "123",
  goalId: "456",
  ads: [
    {
      title: "Ремонт без лишних хлопот",
      text: "Смета заранее и понятные сроки.",
      href: "https://example.test/service",
    },
  ],
  keywords: ["ремонт квартир", "ремонт екатеринбург"],
  negativeKeywords: ["вакансии", "обучение"],
});

function liveDb() {
  const db = openDatabase(":memory:"),
    userId = randomUUID(),
    businessId = randomUUID();
  db.prepare("INSERT INTO users VALUES(?,?,?,?)").run(
    userId,
    `google:${userId}`,
    "Tester",
    new Date().toISOString(),
  );
  db.prepare("INSERT INTO businesses VALUES(?,?,?,1)").run(
    businessId,
    userId,
    JSON.stringify({ mode: "live" }),
  );
  return { db, userId, businessId };
}

test("Direct dry-run builds ordered commands with references and no external call", () => {
  const built = buildDirectCommands(plan());
  assert.deepEqual(
    built.commands.map((command) => `${command.service}.${command.method}`),
    [
      "campaigns.add",
      "campaigns.suspend",
      "adgroups.add",
      "keywords.add",
      "ads.add",
    ],
  );
  assert.deepEqual(built.commands[1].params.SelectionCriteria.Ids, [
    { $ref: "campaign.Id" },
  ]);
  assert.deepEqual(built.commands[2].params.AdGroups[0].CampaignId, {
    $ref: "campaign.Id",
  });
  assert.deepEqual(
    built.commands[0].params.Campaigns[0].TextCampaign.BiddingStrategy.Search
      .WbMaximumClicks.CustomPeriodBudget,
    {
      SpendLimit: plan().budget * 10_000,
      StartDate: plan().periodStart,
      EndDate: plan().periodEnd,
      AutoContinue: "NO",
    },
  );
  assert.equal(
    built.commands[0].params.Campaigns[0].TextCampaign.CounterIds.Items[0],
    123,
  );
  assert.deepEqual(
    built.commands[0].params.Campaigns[0].NegativeKeywords.Items,
    ["вакансии", "обучение"],
  );
  assert.equal(built.summary.externalCalls, 0);
  assert.ok(
    built.commands.every((command) =>
      /^[a-f0-9]{64}$/.test(command.fingerprint),
    ),
  );
});

test("Direct queue is idempotent and reconciles prepared dry-run commands", async () => {
  const { db, userId, businessId } = liveDb(),
    key = randomUUID(),
    first = enqueueDirectDryRun(db, userId, businessId, key, plan()),
    again = enqueueDirectDryRun(db, userId, businessId, key, plan());
  assert.equal(first.id, again.id);
  assert.equal(db.prepare("SELECT count(*) AS n FROM jobs").get().n, 1);
  const result = await runDirectCycle(db, { now: first.availableAt });
  assert.equal(result.status, "succeeded");
  const [view] = directChanges(db, businessId);
  assert.equal(view.status, "succeeded");
  assert.equal(view.reconciliation.expectedCommands, 5);
  assert.equal(view.reconciliation.preparedCommands, 5);
  assert.equal(view.reconciliation.externalCalls, 0);
  assert.throws(
    () =>
      enqueueDirectDryRun(db, userId, businessId, key, {
        ...plan(),
        campaignName: "Другой план",
      }),
    /другого плана/,
  );
  db.close();
});

test("read-only preflight exposes spend blockers and persists one report per key", async () => {
  const { db, userId, businessId } = liveDb();
  db.prepare("UPDATE businesses SET state=? WHERE id=?").run(
    JSON.stringify({
      mode: "live",
      website: plan().website,
      counterId: plan().counterId,
      goalId: plan().goalId,
      timezone: "Asia/Yekaterinburg",
    }),
    businessId,
  );
  const queued = enqueueDirectDryRun(
    db,
    userId,
    businessId,
    randomUUID(),
    plan(),
  );
  await runDirectCycle(db, { now: queued.availableAt });
  const { business, change } = directChangeForPreflight(
    db,
    userId,
    businessId,
    queued.id,
  );
  const report = evaluateDirectPreflight(business, change, {
    clients: [{ Login: plan().login, ClientId: 42, Currency: "RUB" }],
    campaigns: [],
    now: Date.parse("2026-10-28T12:00:00Z"),
  });
  assert.equal(report.ready, false);
  assert.equal(report.remote.writeCalls, 0);
  assert.deepEqual(report.findings.map((finding) => finding.code).sort(), [
    "start_not_future",
  ]);
  const key = randomUUID();
  assert.deepEqual(
    saveDirectPreflight(db, userId, businessId, queued.id, key, report),
    report,
  );
  assert.deepEqual(
    saveDirectPreflight(db, userId, businessId, queued.id, key, report),
    report,
  );
  assert.deepEqual(
    previousDirectPreflight(db, businessId, key, queued.id),
    report,
  );
  assert.deepEqual(directChanges(db, businessId)[0].preflight, report);
  assert.equal(
    db.prepare("SELECT count(*) AS n FROM direct_preflights").get().n,
    1,
  );
  assert.throws(
    () => directChangeForPreflight(db, randomUUID(), businessId, queued.id),
    /найден/,
  );
  db.close();
});

test("future bounded plan passes local preflight without any write", async () => {
  const { db, userId, businessId } = liveDb();
  const futurePlan = {
    ...plan(),
    periodStart: "2026-11-01",
    periodEnd: "2026-11-25",
  };
  db.prepare("UPDATE businesses SET state=? WHERE id=?").run(
    JSON.stringify({
      mode: "live",
      website: futurePlan.website,
      counterId: futurePlan.counterId,
      goalId: futurePlan.goalId,
    }),
    businessId,
  );
  const queued = enqueueDirectDryRun(
    db,
    userId,
    businessId,
    randomUUID(),
    futurePlan,
  );
  await runDirectCycle(db, { now: queued.availableAt });
  const { business, change } = directChangeForPreflight(
    db,
    userId,
    businessId,
    queued.id,
  );
  const report = evaluateDirectPreflight(business, change, {
    clients: [{ Login: futurePlan.login, ClientId: 42, Currency: "RUB" }],
    campaigns: [],
    now: Date.parse("2026-10-28T12:00:00Z"),
  });
  assert.equal(report.ready, true);
  assert.deepEqual(report.findings, []);
  assert.equal(report.remote.writeCalls, 0);
  db.close();
});

test("preflight blocks a period budget below the current Direct minimum", async () => {
  const { db, userId, businessId } = liveDb();
  try {
    const input = {
      ...plan(),
      budget: 30_000,
      periodStart: "2026-11-01",
      periodEnd: "2026-11-14",
    };
    const queued = enqueueDirectDryRun(
      db,
      userId,
      businessId,
      randomUUID(),
      input,
    );
    await runDirectCycle(db, { now: queued.availableAt });
    const { business, change } = directChangeForPreflight(
      db,
      userId,
      businessId,
      queued.id,
    );
    const report = evaluateDirectPreflight(business, change, {
      clients: [{ Login: input.login, ClientId: 42, Currency: "RUB" }],
      campaigns: [],
      now: Date.parse("2026-10-29T12:00:00Z"),
    });
    assert.equal(report.ready, false);
    assert.ok(
      report.findings.some(
        (finding) => finding.code === "period_budget_minimum",
      ),
    );
  } finally {
    db.close();
  }
});

test("preflight rejects altered cap or missing suspend before ad creation", async () => {
  const { db, userId, businessId } = liveDb();
  const futurePlan = {
    ...plan(),
    periodStart: "2026-11-01",
    periodEnd: "2026-11-25",
  };
  db.prepare("UPDATE businesses SET state=? WHERE id=?").run(
    JSON.stringify({
      mode: "live",
      website: futurePlan.website,
      counterId: futurePlan.counterId,
      goalId: futurePlan.goalId,
    }),
    businessId,
  );
  const queued = enqueueDirectDryRun(
    db,
    userId,
    businessId,
    randomUUID(),
    futurePlan,
  );
  await runDirectCycle(db, { now: queued.availableAt });
  const { business, change } = directChangeForPreflight(
    db,
    userId,
    businessId,
    queued.id,
  );
  const modified = structuredClone(change);
  modified.commands[0].params.Campaigns[0].TextCampaign.BiddingStrategy.Search.WbMaximumClicks.CustomPeriodBudget.AutoContinue =
    "YES";
  modified.commands.splice(1, 1);
  const report = evaluateDirectPreflight(business, modified, {
    clients: [{ Login: futurePlan.login, Currency: "RUB" }],
    now: Date.parse("2026-10-28T12:00:00Z"),
  });
  assert.equal(report.ready, false);
  for (const code of ["plan_changed", "period_cap_invalid", "suspend_order"])
    assert.ok(report.findings.some((finding) => finding.code === code));
  db.close();
});

test("confirmation is scoped to one fresh plan and connection, with no external write", async () => {
  const { db, userId, businessId } = liveDb();
  const futurePlan = {
    ...plan(),
    periodStart: "2026-11-01",
    periodEnd: "2026-11-25",
  };
  db.prepare("UPDATE businesses SET state=? WHERE id=?").run(
    JSON.stringify({
      mode: "live",
      website: futurePlan.website,
      counterId: futurePlan.counterId,
      goalId: futurePlan.goalId,
    }),
    businessId,
  );
  db.prepare("INSERT INTO connections VALUES(?,?,?,?)").run(
    businessId,
    "yandex",
    "encrypted-test-value",
    JSON.stringify({ connectionId: "connection-one" }),
  );
  const queued = enqueueDirectDryRun(
    db,
    userId,
    businessId,
    randomUUID(),
    futurePlan,
  );
  await runDirectCycle(db, { now: queued.availableAt });
  const { business, change } = directChangeForPreflight(
    db,
    userId,
    businessId,
    queued.id,
  );
  const now = Date.parse("2026-10-28T12:00:00Z");
  const report = evaluateDirectPreflight(business, change, {
    clients: [{ Login: futurePlan.login, Currency: "RUB" }],
    connectionId: "connection-one",
    now,
  });
  saveDirectPreflight(db, userId, businessId, queued.id, randomUUID(), report);
  assert.throws(
    () =>
      confirmDirectPlan(db, userId, businessId, queued.id, "0".repeat(64), now),
    /устарела/,
  );
  const first = confirmDirectPlan(
    db,
    userId,
    businessId,
    queued.id,
    report.planFingerprint,
    now,
  );
  assert.equal(first.externalWrites, 0);
  assert.deepEqual(
    confirmDirectPlan(
      db,
      userId,
      businessId,
      queued.id,
      report.planFingerprint,
      now + 1,
    ),
    first,
  );
  assert.deepEqual(directChanges(db, businessId)[0].approval, first);
  assert.equal(
    db.prepare("SELECT count(*) AS n FROM direct_approvals").get().n,
    1,
  );
  assert.throws(
    () =>
      confirmDirectPlan(
        db,
        randomUUID(),
        businessId,
        queued.id,
        report.planFingerprint,
        now,
      ),
    /найден/,
  );
  assert.throws(
    () =>
      confirmDirectPlan(
        db,
        userId,
        businessId,
        queued.id,
        report.planFingerprint,
        now + 11 * 60_000,
      ),
    /устарела/,
  );
  db.prepare("UPDATE connections SET metadata=? WHERE business_id=?").run(
    JSON.stringify({ connectionId: "connection-two" }),
    businessId,
  );
  assert.throws(
    () =>
      confirmDirectPlan(
        db,
        userId,
        businessId,
        queued.id,
        report.planFingerprint,
        now + 2,
      ),
    /устарела/,
  );
  saveDirectPreflight(db, userId, businessId, queued.id, randomUUID(), {
    ...report,
    checkedAt: new Date(now + 1_000).toISOString(),
  });
  assert.equal(directChanges(db, businessId)[0].approval, null);
  db.close();
});

test("preflight blocks wrong account, duplicate campaign and incomplete campaign list", async () => {
  const { db, userId, businessId } = liveDb();
  const queued = enqueueDirectDryRun(
    db,
    userId,
    businessId,
    randomUUID(),
    plan(),
  );
  await runDirectCycle(db, { now: queued.availableAt });
  const { business, change } = directChangeForPreflight(
    db,
    userId,
    businessId,
    queued.id,
  );
  const report = evaluateDirectPreflight(business, change, {
    clients: [{ Login: "other-login", Currency: "RUB" }],
    campaigns: [{ Name: plan().campaignName }],
    limitedBy: { Campaigns: 1 },
  });
  assert.equal(report.ready, false);
  for (const code of [
    "account_missing",
    "duplicate_campaign",
    "campaign_list_incomplete",
  ])
    assert.ok(report.findings.some((finding) => finding.code === code));
  db.close();
});

test("Direct queue retries with backoff and stops after four failures", async () => {
  const { db, userId, businessId } = liveDb(),
    item = enqueueDirectDryRun(db, userId, businessId, randomUUID(), plan()),
    fail = async () => {
      throw new Error("secret provider detail");
    };
  let now = item.availableAt;
  for (let attempt = 1; attempt <= 4; attempt++) {
    const result = await runDirectCycle(db, { now, executeDryRun: fail });
    assert.equal(result.status, attempt === 4 ? "failed" : "pending");
    now += 5_000 * 2 ** (attempt - 1);
  }
  const row = db.prepare("SELECT * FROM jobs WHERE id=?").get(item.id);
  assert.equal(row.status, "failed");
  assert.equal(row.attempts, 4);
  assert.doesNotMatch(row.error, /secret provider detail/);
  db.close();
});

test("Direct plan validation rejects empty geography, unsafe URL and oversized ad", () => {
  assert.throws(() => buildDirectCommands({ ...plan(), regionIds: [] }));
  assert.throws(() =>
    buildDirectCommands({ ...plan(), website: "javascript:alert(1)" }),
  );
  assert.throws(() =>
    buildDirectCommands({
      ...plan(),
      ads: [{ ...plan().ads[0], title: "x".repeat(57) }],
    }),
  );
});

test("live adapter resolves remote IDs in order and reconciles the campaign", async () => {
  const seen = [],
    client = {
      createCampaigns: async (items) => {
        seen.push(["campaigns", items]);
        return { AddResults: [{ Id: 101 }] };
      },
      suspendCampaigns: async (ids) => {
        seen.push(["suspend", ids]);
        return { SuspendResults: [{ Id: ids[0] }] };
      },
      createAdGroups: async (items) => {
        seen.push(["adgroups", items]);
        return { AddResults: [{ Id: 202 }] };
      },
      createKeywords: async (items) => {
        seen.push(["keywords", items]);
        return { AddResults: items.map((_, index) => ({ Id: 300 + index })) };
      },
      createAds: async (items) => {
        seen.push(["ads", items]);
        return { AddResults: [{ Id: 401 }] };
      },
      campaignsByIds: async (ids) => ({
        Campaigns: [{ Id: ids[0], State: "SUSPENDED" }],
      }),
    },
    result = await executeDirectCommands(
      client,
      buildDirectCommands(plan()).commands,
    );
  assert.deepEqual(
    seen.map(([service]) => service),
    ["campaigns", "suspend", "adgroups", "keywords", "ads"],
  );
  assert.deepEqual(seen[1][1], [101]);
  assert.equal(seen[2][1][0].CampaignId, 101);
  assert.equal(seen[3][1][0].AdGroupId, 202);
  assert.equal(seen[4][1][0].AdGroupId, 202);
  assert.equal(result.reconciliation.status, "matched");
  assert.equal(result.externalCalls, 7);
});

test("unified campaign keeps the selected image when converting a text ad", async () => {
  const input = plan();
  input.ads[0].adImageHash = "approved_image_hash-1";
  let createdAds;
  await executeDirectCommands(
    {
      createCampaigns: async () => ({ AddResults: [{ Id: 101 }] }),
      campaignsByIds: async () => ({
        Campaigns: [
          {
            Id: 101,
            State: "OFF",
            Status: "DRAFT",
            Type: "UNIFIED_CAMPAIGN",
          },
        ],
      }),
      createAdGroups: async () => ({ AddResults: [{ Id: 202 }] }),
      createKeywords: async (items) => ({
        AddResults: items.map((_, index) => ({ Id: 300 + index })),
      }),
      createAds: async (items) => {
        createdAds = items;
        return { AddResults: [{ Id: 401 }] };
      },
    },
    buildDirectCommands(input).commands,
  );
  assert.deepEqual(createdAds[0].ResponsiveAd.AdImageHashes, [
    "approved_image_hash-1",
  ]);
});

test("live adapter stops before ad objects if suspend state is not read back", async () => {
  const seen = [];
  await assert.rejects(
    executeDirectCommands(
      {
        createCampaigns: async () => ({ AddResults: [{ Id: 101 }] }),
        suspendCampaigns: async () => ({ SuspendResults: [{ Id: 101 }] }),
        campaignsByIds: async () => ({
          Campaigns: [{ Id: 101, State: "OFF" }],
        }),
        createAdGroups: async () => seen.push("adgroup"),
        createKeywords: async () => seen.push("keyword"),
        createAds: async () => seen.push("ad"),
      },
      buildDirectCommands(plan()).commands,
    ),
    /SUSPENDED не подтверждено/,
  );
  assert.deepEqual(seen, []);
});

test("live adapter rejects partial add results and altered command plans", async () => {
  const commands = buildDirectCommands(plan()).commands;
  const touched = structuredClone(commands);
  touched[0].params.Campaigns[0].Name = "Другой план";
  let calls = 0;
  await assert.rejects(
    executeDirectCommands({ createCampaigns: async () => calls++ }, touched),
    /изменился после dry-run/,
  );
  assert.equal(calls, 0);

  await assert.rejects(
    executeDirectCommands(
      {
        createCampaigns: async () => ({ AddResults: [{ Id: 101 }] }),
        suspendCampaigns: async () => ({ SuspendResults: [{ Id: 101 }] }),
        campaignsByIds: async () => ({
          Campaigns: [{ Id: 101, State: "SUSPENDED" }],
        }),
        createAdGroups: async () => ({ AddResults: [{ Id: 202 }] }),
        createKeywords: async () => ({ AddResults: [{ Id: 301 }] }),
        createAds: async () => {
          calls++;
          return { AddResults: [{ Id: 401 }] };
        },
      },
      commands,
    ),
    /не вернул идентификаторы/,
  );
  assert.equal(calls, 0);
});

test("failed campaign suspension prevents creating any ad objects", async () => {
  const seen = [];
  await assert.rejects(
    executeDirectCommands(
      {
        createCampaigns: async () => ({ AddResults: [{ Id: 101 }] }),
        campaignsByIds: async () => ({
          Campaigns: [{ Id: 101, State: "ON", Status: "ACCEPTED" }],
        }),
        suspendCampaigns: async () => ({
          SuspendResults: [{ Errors: [{ Code: 1 }] }],
        }),
        createAdGroups: async () => seen.push("adgroup"),
        createKeywords: async () => seen.push("keyword"),
        createAds: async () => seen.push("ad"),
      },
      buildDirectCommands(plan()).commands,
    ),
    /остановку кампании/,
  );
  assert.deepEqual(seen, []);
});

test("read-back does not accept a campaign that is serving", async () => {
  const calls = [
    { key: "campaign", ids: [101] },
    { key: "suspend", ids: [101] },
    { key: "adgroup", ids: [202] },
    { key: "keywords", ids: [303] },
    { key: "ads", ids: [404] },
  ];
  const result = await reconcileDirectObjects(
    {
      campaignsByIds: async () => ({ Campaigns: [{ Id: 101, State: "ON" }] }),
      adGroupsByIds: async () => ({ AdGroups: [{ Id: 202, CampaignId: 101 }] }),
      keywordsByIds: async () => ({ Keywords: [{ Id: 303, AdGroupId: 202 }] }),
      adsByIds: async () => ({ Ads: [{ Id: 404, AdGroupId: 202 }] }),
    },
    calls,
  );
  assert.equal(result.matched, false);
  assert.equal(result.status, "mismatch");
});

test("read-back accepts the selected image on a responsive ad", async () => {
  const calls = [
    { key: "campaign", ids: [101] },
    { key: "suspend", ids: [101] },
    { key: "adgroup", ids: [202] },
    { key: "keywords", ids: [303] },
    { key: "ads", ids: [404] },
  ];
  const input = plan();
  input.ads[0].adImageHash = "approved_image_hash-1";
  const result = await reconcileDirectObjects(
    {
      campaignsByIds: async () => ({
        Campaigns: [{ Id: 101, State: "OFF", Status: "DRAFT" }],
      }),
      adGroupsByIds: async () => ({ AdGroups: [{ Id: 202, CampaignId: 101 }] }),
      keywordsByIds: async () => ({ Keywords: [{ Id: 303, AdGroupId: 202 }] }),
      adsByIds: async () => ({
        Ads: [
          {
            Id: 404,
            AdGroupId: 202,
            ResponsiveAd: {
              AdImages: [{ AdImageHash: "approved_image_hash-1" }],
            },
          },
        ],
      }),
    },
    calls,
    input,
  );
  assert.equal(result.matched, true);
  assert.equal(result.status, "matched");
});
