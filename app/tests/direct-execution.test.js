import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { openDatabase } from "../server/db.js";
import { createApp } from "../server/app.js";
import { encrypt, hash, isPilotOrigin } from "../server/security.js";
import {
  beginDirectExecution,
  continueVerifiedDraftExecution,
  continueVerifiedKeywordsExecution,
  directExecution,
  finishDirectExecution,
  inspectDirectExecution,
  markInterruptedDirectExecutions,
  recordDirectExecutionCheckpoint,
  runApprovedDirectExecution,
  stopDirectExecution,
} from "../server/direct-execution.js";
import {
  inspectLifecycleAction,
  lifecycleActions,
  markInterruptedLifecycleActions,
  suspendVerifiedCampaign,
} from "../server/direct-lifecycle.js";
import {
  archiveVerifiedCampaign,
  inspectArchiveAction,
  markInterruptedArchiveActions,
} from "../server/direct-archive.js";
import {
  createDirectAbPlan,
  directAbPlans,
  directAbVariantForChange,
} from "../server/direct-ab.js";
import {
  createVerifiedAbVariant,
  inspectAbVariantAction,
  markInterruptedAbActions,
} from "../server/direct-ab-action.js";
import {
  applyDirectAbDecision,
  inspectDirectAbDecision,
  markInterruptedAbDecisionActions,
} from "../server/direct-ab-decision.js";
import {
  inspectDirectBudget,
  latestDirectBudgetCheck,
  previewDirectBudgetLimit,
} from "../server/direct-budget.js";
import {
  budgetActions,
  inspectBudgetAction,
  inspectBudgetRollback,
  markInterruptedBudgetActions,
  reduceVerifiedBudget,
  rollbackReducedBudget,
} from "../server/direct-budget-action.js";
import {
  inspectModerationAction,
  inspectModerationReadiness,
  markInterruptedModerationActions,
  moderationActions,
  submitVerifiedModeration,
} from "../server/direct-moderation.js";
import {
  inspectDirectControl,
  latestDirectControlReview,
} from "../server/direct-control.js";
import {
  inspectResumeAction,
  markInterruptedResumeActions,
  resumeActions,
  resumeVerifiedCampaign,
} from "../server/direct-resume.js";
import {
  confirmDirectPlan,
  directChangeForPreflight,
  enqueueDirectDryRun,
  evaluateDirectPreflight,
  executeDirectCommands,
  reconcileDirectObjects,
  runDirectCycle,
  saveDirectPreflight,
} from "../server/direct.js";

test("pilot origin accepts local HTTP and rejects public HTTP", () => {
  assert.equal(isPilotOrigin("http://localhost:4310"), true);
  assert.equal(isPilotOrigin("http://127.0.0.1:4310"), true);
  assert.equal(isPilotOrigin("https://ritm.example.test"), true);
  assert.equal(isPilotOrigin("http://ritm.example.test"), false);
  assert.equal(isPilotOrigin("http://localhost.evil.test"), false);
});

const date = (offset) =>
  new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Europe/Moscow",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(Date.now() + offset * 86_400_000));

async function approvedPlan(db, userId, businessId, connectionId) {
  const plan = {
    login: "test-client",
    campaignName: `Тестовая кампания ${randomUUID()}`,
    website: "https://example.test/coffee",
    audience: "Любители кофе",
    regionIds: [54],
    budget: 300_000,
    targetCpa: 45_000,
    periodStart: date(4),
    periodEnd: date(17),
    counterId: "123",
    goalId: "456",
    ads: [
      {
        title: "Кофе · рядом с вами",
        text: "Свежий кофе каждый день",
        href: "https://example.test/coffee",
      },
    ],
    keywords: ["кофе рядом", "кофейня рядом"],
  };
  db.prepare("UPDATE businesses SET state=? WHERE id=?").run(
    JSON.stringify({
      mode: "live",
      website: plan.website,
      counterId: plan.counterId,
      goalId: plan.goalId,
    }),
    businessId,
  );
  db.prepare("INSERT INTO connections VALUES(?,?,?,?)").run(
    businessId,
    "yandex",
    "test-encrypted-token",
    JSON.stringify({ connectionId }),
  );
  const queued = enqueueDirectDryRun(
    db,
    userId,
    businessId,
    randomUUID(),
    plan,
  );
  await runDirectCycle(db, { now: queued.availableAt });
  const { business, change } = directChangeForPreflight(
    db,
    userId,
    businessId,
    queued.id,
  );
  const report = evaluateDirectPreflight(business, change, {
    clients: [{ Login: plan.login, ClientId: 12, Currency: "RUB" }],
    campaigns: [],
    connectionId,
  });
  assert.equal(report.ready, true);
  saveDirectPreflight(db, userId, businessId, change.id, randomUUID(), report);
  confirmDirectPlan(db, userId, businessId, change.id, report.planFingerprint);
  return change;
}

function setup() {
  const db = openDatabase(":memory:");
  const userId = randomUUID(),
    businessId = randomUUID(),
    connectionId = randomUUID();
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
  return { db, userId, businessId, connectionId };
}

async function completedCampaign(db, userId, businessId, connectionId) {
  const change = await approvedPlan(db, userId, businessId, connectionId);
  await runApprovedDirectExecution(
    db,
    userId,
    businessId,
    change.id,
    {
      createCampaigns: async () => ({ AddResults: [{ Id: 101 }] }),
      suspendCampaigns: async () => ({ SuspendResults: [{ Id: 101 }] }),
      createAdGroups: async () => ({ AddResults: [{ Id: 202 }] }),
      createKeywords: async () => ({ AddResults: [{ Id: 301 }, { Id: 302 }] }),
      createAds: async () => ({ AddResults: [{ Id: 401 }] }),
      campaignsByIds: async () => ({
        Campaigns: [{ Id: 101, State: "SUSPENDED" }],
      }),
      adGroupsByIds: async () => ({ AdGroups: [{ Id: 202, CampaignId: 101 }] }),
      keywordsByIds: async () => ({
        Keywords: [
          { Id: 301, AdGroupId: 202 },
          { Id: 302, AdGroupId: 202 },
        ],
      }),
      adsByIds: async () => ({ Ads: [{ Id: 401, AdGroupId: 202 }] }),
    },
    { enabled: true },
  );
  return change;
}

function remoteBudget(plan, limit = plan.budget) {
  return {
    Campaigns: [
      {
        Id: 101,
        Name: plan.campaignName,
        State: "SUSPENDED",
        Status: "DRAFT",
        Type: "TEXT_CAMPAIGN",
        Currency: "RUB",
        TextCampaign: {
          BiddingStrategy: {
            Search: {
              BiddingStrategyType: "WB_MAXIMUM_CLICKS",
              WbMaximumClicks: {
                CustomPeriodBudget: {
                  SpendLimit: limit * 10_000,
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

function resumeFixture(db, businessId, connectionId, plan) {
  const now = Date.parse(`${plan.periodStart}T12:00:00Z`);
  const signature = createHash("sha256").update(connectionId).digest("hex");
  const jobId = randomUUID();
  db.prepare(
    `INSERT INTO jobs(id,business_id,kind,status,available_at,payload)
    VALUES(?,?,'report_sync','succeeded',?,?)`,
  ).run(jobId, businessId, now, JSON.stringify({ signature }));
  db.prepare(
    `INSERT INTO report_snapshots
    (id,business_id,job_id,scope,source,login,date_from,date_to,currency,include_vat,
     received_at,raw_hash,raw_tsv,rows_json,totals_json,previous_id,comparison_json)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    randomUUID(),
    businessId,
    jobId,
    "scope",
    "yandex",
    plan.login,
    plan.periodStart,
    plan.periodStart,
    "RUB",
    1,
    new Date(now).toISOString(),
    "hash",
    "tsv",
    "[]",
    "{}",
    null,
    "{}",
  );
  let state = "SUSPENDED",
    writes = 0;
  const client = {
    campaignBudgetById: async () => ({
      Campaigns: [
        {
          ...remoteBudget(plan).Campaigns[0],
          State: state,
          Status: "ACCEPTED",
          StatusPayment: "ALLOWED",
        },
      ],
    }),
    adGroupsByIds: async () => ({ AdGroups: [{ Id: 202, CampaignId: 101 }] }),
    adsByIds: async () => ({
      Ads: [
        {
          Id: 401,
          CampaignId: 101,
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
        CampaignId: 101,
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
          ErirAttributes: { Organization: { Name: "Тестовая организация" } },
        },
      ],
    }),
    resumeCampaigns: async () => {
      writes++;
      state = "ON";
      return { ResumeResults: [{ Id: 101 }] };
    },
  };
  return {
    now,
    client,
    writes: () => writes,
    setState: (value) => {
      state = value;
    },
  };
}

function moderationClient(plan, overrides = {}) {
  let adStatus = "DRAFT";
  let writes = 0;
  const client = {
    campaignBudgetById: async () => remoteBudget(plan),
    adsByIds: async () => ({
      Ads: [
        {
          Id: 401,
          CampaignId: 101,
          AdGroupId: 202,
          Status: adStatus,
          ResponsiveAd: {
            Titles: [{ Title: plan.ads[0].title }],
            Texts: [{ Text: plan.ads[0].text }],
            Href: plan.ads[0].href,
          },
        },
      ],
    }),
    keywordsByIds: async () => ({
      Keywords: [
        { Id: 301, CampaignId: 101, AdGroupId: 202 },
        { Id: 302, CampaignId: 101, AdGroupId: 202 },
      ],
    }),
    advertiserMarkingDetails: async () => ({
      Clients: [
        {
          Type: "CLIENT",
          TinInfo: { TinType: "LEGAL", Tin: "1234567890" },
          ErirAttributes: { Organization: { Name: "Тестовая организация" } },
        },
      ],
    }),
    moderateAds: async () => {
      writes++;
      adStatus = "MODERATION";
      return { ModerateResults: [{ Id: 401 }] };
    },
    ...overrides,
  };
  return {
    client,
    writes: () => writes,
    setStatus: (value) => {
      adStatus = value;
    },
  };
}

test("guarded moderation submits exact draft ad once and keeps campaign held", async () => {
  const { db, userId, businessId, connectionId } = setup();
  try {
    const change = await completedCampaign(
      db,
      userId,
      businessId,
      connectionId,
    );
    const mock = moderationClient(change.plan);
    const readiness = await inspectModerationReadiness(
      db,
      userId,
      businessId,
      change.id,
      mock.client,
      connectionId,
    );
    assert.equal(readiness.status, "technical_ready");
    assert.deepEqual(readiness.adIds, [401]);
    assert.equal(readiness.externalWrites, 0);
    await assert.rejects(
      submitVerifiedModeration(
        db,
        userId,
        businessId,
        change.id,
        randomUUID(),
        mock.client,
        connectionId,
      ),
      /отключена/,
    );
    assert.equal(mock.writes(), 0);
    const requestKey = randomUUID();
    const first = await submitVerifiedModeration(
      db,
      userId,
      businessId,
      change.id,
      requestKey,
      mock.client,
      connectionId,
      { enabled: true, advertiserConfirmed: true, siteConfirmed: true },
    );
    assert.equal(first.status, "succeeded");
    assert.equal(first.writeAttempted, true);
    assert.equal(mock.writes(), 1);
    const repeat = await submitVerifiedModeration(
      db,
      userId,
      businessId,
      change.id,
      requestKey,
      mock.client,
      connectionId,
      { enabled: true, advertiserConfirmed: true, siteConfirmed: true },
    );
    assert.deepEqual(repeat, first);
    assert.equal(mock.writes(), 1);
    assert.equal(
      moderationActions(db, userId, businessId, change.id).length,
      1,
    );
  } finally {
    db.close();
  }
});

test("moderation blocks changed ad content before sending any API write", async () => {
  const { db, userId, businessId, connectionId } = setup();
  try {
    const change = await completedCampaign(
      db,
      userId,
      businessId,
      connectionId,
    );
    const mock = moderationClient(change.plan, {
      adsByIds: async () => ({
        Ads: [
          {
            Id: 401,
            CampaignId: 101,
            AdGroupId: 202,
            Status: "DRAFT",
            ResponsiveAd: {
              Titles: [{ Title: change.plan.ads[0].title }],
              Texts: [{ Text: change.plan.ads[0].text }],
              Href: "https://wrong.example.test/",
            },
          },
        ],
      }),
    });
    const readiness = await inspectModerationReadiness(
      db,
      userId,
      businessId,
      change.id,
      mock.client,
      connectionId,
    );
    assert.ok(readiness.blockers.includes("ad_content_changed"));
    const result = await submitVerifiedModeration(
      db,
      userId,
      businessId,
      change.id,
      randomUUID(),
      mock.client,
      connectionId,
      { enabled: true, advertiserConfirmed: true, siteConfirmed: true },
    );
    assert.equal(result.status, "failed_no_write");
    assert.equal(mock.writes(), 0);
  } finally {
    db.close();
  }
});

test("uncertain moderation result is never replayed and can be reconciled by read", async () => {
  const { db, userId, businessId, connectionId } = setup();
  try {
    const change = await completedCampaign(
      db,
      userId,
      businessId,
      connectionId,
    );
    let writes = 0;
    const mock = moderationClient(change.plan, {
      moderateAds: async () => {
        writes++;
        throw new Error("timeout");
      },
    });
    const requestKey = randomUUID();
    const first = await submitVerifiedModeration(
      db,
      userId,
      businessId,
      change.id,
      requestKey,
      mock.client,
      connectionId,
      { enabled: true, advertiserConfirmed: true, siteConfirmed: true },
    );
    assert.equal(first.status, "needs_reconciliation");
    assert.equal(writes, 1);
    await assert.rejects(
      suspendVerifiedCampaign(
        db,
        userId,
        businessId,
        change.id,
        randomUUID(),
        {
          campaignsByIds: async () => {
            throw new Error("must not read");
          },
        },
        { enabled: true },
      ),
      /Модерация кампании требует сверки/,
    );
    const repeat = await submitVerifiedModeration(
      db,
      userId,
      businessId,
      change.id,
      requestKey,
      mock.client,
      connectionId,
      { enabled: true, advertiserConfirmed: true, siteConfirmed: true },
    );
    assert.equal(repeat.status, "needs_reconciliation");
    assert.equal(writes, 1);
    assert.equal(markInterruptedModerationActions(db), 0);
    mock.setStatus("MODERATION");
    const resolved = await inspectModerationAction(
      db,
      userId,
      businessId,
      change.id,
      first.id,
      mock.client,
    );
    assert.equal(resolved.status, "succeeded");
    assert.equal(writes, 1);
  } finally {
    db.close();
  }
});

function remoteDraftBudget(plan) {
  const draft = remoteBudget(plan).Campaigns[0];
  return {
    Campaigns: [
      {
        ...draft,
        State: "OFF",
        Status: "DRAFT",
        Type: "UNIFIED_CAMPAIGN",
        StartDate: plan.periodStart,
        EndDate: plan.periodEnd,
        UnifiedCampaign: {
          ...draft.TextCampaign,
          CounterIds: { Items: [Number(plan.counterId)] },
        },
        TextCampaign: undefined,
      },
    ],
  };
}

test("verified OFF draft resumes without replaying campaign add or suspension", async () => {
  const { db, userId, businessId, connectionId } = setup();
  try {
    const change = await approvedPlan(db, userId, businessId, connectionId);
    beginDirectExecution(db, userId, businessId, change.id, { enabled: true });
    recordDirectExecutionCheckpoint(db, userId, businessId, change.id, {
      phase: "before",
      key: "campaign",
    });
    recordDirectExecutionCheckpoint(db, userId, businessId, change.id, {
      phase: "acknowledged",
      key: "campaign",
      ids: [101],
    });
    recordDirectExecutionCheckpoint(db, userId, businessId, change.id, {
      phase: "before",
      key: "suspend",
    });
    stopDirectExecution(db, userId, businessId, change.id, "provider_error");
    let writes = 0;
    let groupAttempts = 0;
    const client = {
      campaignBudgetById: async () => remoteDraftBudget(change.plan),
      adGroupsByCampaignId: async () => ({ AdGroups: [] }),
      campaignsByIds: async () => ({
        Campaigns: [{ Id: 101, State: "OFF", Status: "DRAFT" }],
      }),
      createCampaigns: async () => assert.fail("campaign add must not replay"),
      suspendCampaigns: async () => assert.fail("draft cannot be suspended"),
      createAdGroups: async (groups) => {
        assert.deepEqual(groups[0].UnifiedAdGroup, { OfferRetargeting: "NO" });
        groupAttempts++;
        if (groupAttempts === 1) {
          const rejected = new Error("Rejected group schema");
          rejected.code = "provider_error";
          throw rejected;
        }
        writes++;
        return { AddResults: [{ Id: 202 }] };
      },
      createKeywords: async () => {
        writes++;
        return { AddResults: [{ Id: 301 }, { Id: 302 }] };
      },
      createAds: async () => {
        writes++;
        return { AddResults: [{ Id: 401 }] };
      },
      adGroupsByIds: async () => ({
        AdGroups: [{ Id: 202, CampaignId: 101 }],
      }),
      keywordsByIds: async () => ({
        Keywords: [
          { Id: 301, AdGroupId: 202 },
          { Id: 302, AdGroupId: 202 },
        ],
      }),
      adsByIds: async () => ({ Ads: [{ Id: 401, AdGroupId: 202 }] }),
    };
    await assert.rejects(
      continueVerifiedDraftExecution(
        db,
        userId,
        businessId,
        change.id,
        client,
        connectionId,
        { enabled: true },
      ),
      /Rejected group schema/,
    );
    assert.equal(
      directExecution(db, userId, businessId, change.id).inflightKey,
      "adgroup",
    );
    await assert.rejects(
      continueVerifiedDraftExecution(
        db,
        userId,
        businessId,
        change.id,
        client,
        connectionId,
        { enabled: true },
      ),
      /недоступно/,
    );
    const result = await continueVerifiedDraftExecution(
      db,
      userId,
      businessId,
      change.id,
      client,
      connectionId,
      { enabled: true, rejectedAddCode: 8000 },
    );
    assert.equal(result.status, "succeeded");
    assert.equal(result.calls[1].holdState, "OFF_DRAFT");
    assert.equal(result.reconciliation.status, "matched");
    assert.equal(groupAttempts, 2);
    assert.equal(writes, 3);
    const budget = await inspectDirectBudget(
      db,
      userId,
      businessId,
      change.id,
      client,
      connectionId,
    );
    assert.equal(budget.status, "matched");
    assert.equal(budget.remote.state, "OFF");
  } finally {
    db.close();
  }
});

test("archive refuses OFF/DRAFT without an API write", async () => {
  const { db, userId, businessId, connectionId } = setup();
  try {
    const change = await completedCampaign(
      db,
      userId,
      businessId,
      connectionId,
    );
    let writes = 0;
    const client = {
      campaignsByIds: async () => ({
        Campaigns: [{ Id: 101, State: "OFF", Status: "DRAFT" }],
      }),
      archiveCampaigns: async () => {
        writes++;
        throw new Error("must not send");
      },
    };
    const key = randomUUID();
    const result = await archiveVerifiedCampaign(
      db,
      userId,
      businessId,
      change.id,
      key,
      101,
      client,
      { enabled: true, confirmedNoFunds: true },
    );
    assert.equal(result.status, "failed_no_write");
    assert.equal(result.errorCode, "not_suspended");
    assert.equal(result.writeAttempted, false);
    assert.equal(writes, 0);
    const retry = await archiveVerifiedCampaign(
      db,
      userId,
      businessId,
      change.id,
      key,
      101,
      client,
      { enabled: true, confirmedNoFunds: true },
    );
    assert.equal(retry.id, result.id);
    assert.equal(writes, 0);
  } finally {
    db.close();
  }
});

test("archive checks confirmations, writes once and verifies ARCHIVED", async () => {
  const { db, userId, businessId, connectionId } = setup();
  try {
    const change = await completedCampaign(
      db,
      userId,
      businessId,
      connectionId,
    );
    let writes = 0,
      state = "SUSPENDED";
    const client = {
      campaignsByIds: async () => ({ Campaigns: [{ Id: 101, State: state }] }),
      archiveCampaigns: async () => {
        writes++;
        state = "ARCHIVED";
        return { ArchiveResults: [{ Id: 101 }] };
      },
    };
    await assert.rejects(
      archiveVerifiedCampaign(
        db,
        userId,
        businessId,
        change.id,
        randomUUID(),
        101,
        client,
        { enabled: false, confirmedNoFunds: true },
      ),
      { code: "archive_gate" },
    );
    await assert.rejects(
      archiveVerifiedCampaign(
        db,
        userId,
        businessId,
        change.id,
        randomUUID(),
        101,
        client,
        { enabled: true },
      ),
      { code: "funds_confirmation" },
    );
    await assert.rejects(
      archiveVerifiedCampaign(
        db,
        userId,
        businessId,
        change.id,
        randomUUID(),
        102,
        client,
        { enabled: true, confirmedNoFunds: true },
      ),
      /точный ID/,
    );
    assert.equal(writes, 0);
    const key = randomUUID();
    const result = await archiveVerifiedCampaign(
      db,
      userId,
      businessId,
      change.id,
      key,
      101,
      client,
      { enabled: true, confirmedNoFunds: true },
    );
    assert.equal(result.status, "succeeded");
    assert.equal(result.afterState, "ARCHIVED");
    assert.equal(result.writeAttempted, true);
    const retry = await archiveVerifiedCampaign(
      db,
      userId,
      businessId,
      change.id,
      key,
      101,
      client,
      { enabled: true, confirmedNoFunds: true },
    );
    assert.equal(retry.id, result.id);
    assert.equal(writes, 1);
  } finally {
    db.close();
  }
});

test("archive uncertain result never replays and can be read-only reconciled", async () => {
  const { db, userId, businessId, connectionId } = setup();
  try {
    const change = await completedCampaign(
      db,
      userId,
      businessId,
      connectionId,
    );
    let writes = 0,
      state = "SUSPENDED";
    const client = {
      campaignsByIds: async () => ({ Campaigns: [{ Id: 101, State: state }] }),
      archiveCampaigns: async () => {
        writes++;
        throw new Error("lost response");
      },
    };
    const key = randomUUID();
    const result = await archiveVerifiedCampaign(
      db,
      userId,
      businessId,
      change.id,
      key,
      101,
      client,
      { enabled: true, confirmedNoFunds: true },
    );
    assert.equal(result.status, "needs_reconciliation");
    assert.equal(result.writeAttempted, true);
    assert.equal(writes, 1);
    const retry = await archiveVerifiedCampaign(
      db,
      userId,
      businessId,
      change.id,
      key,
      101,
      client,
      { enabled: true, confirmedNoFunds: true },
    );
    assert.equal(retry.id, result.id);
    assert.equal(writes, 1);
    await assert.rejects(
      archiveVerifiedCampaign(
        db,
        userId,
        businessId,
        change.id,
        randomUUID(),
        101,
        client,
        { enabled: true, confirmedNoFunds: true },
      ),
      /уже выполняется или требует сверки/,
    );
    state = "ARCHIVED";
    const inspected = await inspectArchiveAction(
      db,
      userId,
      businessId,
      change.id,
      result.id,
      client,
    );
    assert.equal(inspected.status, "succeeded");
    assert.equal(writes, 1);
  } finally {
    db.close();
  }
});

test("archive restart marks incomplete writes for reconciliation", async () => {
  const { db, userId, businessId, connectionId } = setup();
  try {
    const change = await completedCampaign(
      db,
      userId,
      businessId,
      connectionId,
    );
    const at = new Date().toISOString();
    for (const [campaignId, status] of [
      [101, "checking"],
      [102, "sending"],
    ])
      db.prepare(
        `INSERT INTO direct_archive_actions(
        id,business_id,change_id,connection_id,campaign_id,idempotency_key,
        status,write_attempted,created_at,updated_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?)`,
      ).run(
        randomUUID(),
        businessId,
        change.id,
        connectionId,
        campaignId,
        randomUUID(),
        status,
        status === "sending" ? 1 : 0,
        at,
        at,
      );
    assert.equal(markInterruptedArchiveActions(db), 2);
    const rows = db
      .prepare(
        "SELECT campaign_id,status,error_code FROM direct_archive_actions ORDER BY campaign_id",
      )
      .all();
    assert.deepEqual(
      rows.map((row) => [row.campaign_id, row.status, row.error_code]),
      [
        [101, "failed_no_write", "process_interrupted_before_write"],
        [102, "needs_reconciliation", "process_interrupted"],
      ],
    );
    assert.equal(markInterruptedArchiveActions(db), 0);
  } finally {
    db.close();
  }
});

test("A/B hypothesis is fixed before traffic, idempotent and isolated", async () => {
  const { db, userId, businessId, connectionId } = setup();
  try {
    const change = await completedCampaign(
      db,
      userId,
      businessId,
      connectionId,
    );
    const input = {
      hypothesis:
        "Новый заголовок повысит долю переходов при той же аудитории.",
      variant: { title: "Кофе утром рядом", text: "Свежий кофе каждый день" },
      minDays: 14,
      minImpressionsPerVariant: 1000,
    };
    const key = randomUUID();
    const plan = createDirectAbPlan(
      db,
      userId,
      businessId,
      change.id,
      key,
      input,
    );
    assert.equal(plan.status, "planned_unpublished");
    assert.equal(plan.metric, "ctr");
    assert.equal(plan.externalWrites, 0);
    assert.equal(plan.control.adId, "401");
    assert.equal(plan.variant.adId, null);
    assert.equal(plan.blockers.length, 3);
    assert.equal(
      createDirectAbPlan(db, userId, businessId, change.id, key, input).id,
      plan.id,
    );
    assert.equal(directAbPlans(db, userId, businessId).length, 1);
    assert.throws(
      () =>
        createDirectAbPlan(db, userId, businessId, change.id, key, {
          ...input,
          hypothesis: input.hypothesis + "!",
        }),
      { code: "idempotency_conflict" },
    );
    assert.throws(
      () =>
        createDirectAbPlan(
          db,
          userId,
          businessId,
          change.id,
          randomUUID(),
          input,
        ),
      /уже зафиксирован/,
    );
    assert.throws(() => directAbPlans(db, randomUUID(), businessId), {
      status: 404,
    });
  } finally {
    db.close();
  }
});

test("A/B plan rejects late registration and an unchanged variant", async () => {
  const { db, userId, businessId, connectionId } = setup();
  try {
    const change = await completedCampaign(
      db,
      userId,
      businessId,
      connectionId,
    );
    const input = {
      hypothesis:
        "Новый заголовок повысит долю переходов при той же аудитории.",
      variant: { title: "Кофе утром рядом", text: "Свежий кофе каждый день" },
      minDays: 14,
      minImpressionsPerVariant: 1000,
    };
    assert.throws(
      () =>
        createDirectAbPlan(
          db,
          userId,
          businessId,
          change.id,
          randomUUID(),
          input,
          { now: Date.parse(change.plan.periodStart + "T12:00:00Z") },
        ),
      /до начала периода/,
    );
    assert.throws(
      () =>
        createDirectAbPlan(db, userId, businessId, change.id, randomUUID(), {
          ...input,
          variant: {
            title: change.plan.ads[0].title,
            text: change.plan.ads[0].text,
          },
        }),
      /должен отличаться/,
    );
    assert.throws(
      () =>
        createDirectAbPlan(db, userId, businessId, change.id, randomUUID(), {
          ...input,
          minImpressionsPerVariant: 10,
        }),
      /too_small|500/,
    );
    assert.equal(directAbPlans(db, userId, businessId).length, 0);
  } finally {
    db.close();
  }
});

test("A/B variant is added once to a held group and verified by read-back", async () => {
  const { db, userId, businessId, connectionId } = setup();
  try {
    const change = await completedCampaign(
      db,
      userId,
      businessId,
      connectionId,
    );
    const plan = createDirectAbPlan(
      db,
      userId,
      businessId,
      change.id,
      randomUUID(),
      {
        hypothesis: "Конкретная выгода в заголовке повысит CTR объявления.",
        variant: { title: "Кофе и десерт рядом", text: "Закажите за минуту" },
        minDays: 14,
        minImpressionsPerVariant: 1000,
      },
    );
    const control = {
      Id: 401,
      CampaignId: 101,
      AdGroupId: 202,
      Status: "DRAFT",
      ResponsiveAd: {
        Titles: [{ Title: plan.control.title }],
        Texts: [{ Text: plan.control.text }],
        Href: plan.control.href,
      },
    };
    const ads = [control];
    let writes = 0;
    const client = {
      campaignBudgetById: async () => ({
        Campaigns: [
          {
            Id: 101,
            State: "SUSPENDED",
            Status: "DRAFT",
            Type: "UNIFIED_CAMPAIGN",
          },
        ],
      }),
      adsByIds: async (ids) => ({
        Ads: ads.filter((ad) => ids.some((id) => String(id) === String(ad.Id))),
      }),
      adsByAdGroupId: async () => ({ Ads: ads }),
      keywordsByIds: async () => ({
        Keywords: [
          { Id: 301, CampaignId: 101, AdGroupId: 202 },
          { Id: 302, CampaignId: 101, AdGroupId: 202 },
        ],
      }),
      advertiserMarkingDetails: async () => ({
        Clients: [
          {
            Type: "CLIENT",
            TinInfo: { TinType: "LEGAL", Tin: "1234567890" },
            ErirAttributes: { Organization: { Name: "Организация" } },
          },
        ],
      }),
      createAds: async (items) => {
        writes++;
        assert.deepEqual(items, [
          {
            AdGroupId: 202,
            ResponsiveAd: {
              Titles: [plan.variant.title],
              Texts: [plan.variant.text],
              Href: plan.variant.href,
            },
          },
        ]);
        ads.push({
          Id: 402,
          CampaignId: 101,
          AdGroupId: 202,
          Status: "DRAFT",
          ResponsiveAd: {
            Titles: [{ Title: plan.variant.title }],
            Texts: [{ Text: plan.variant.text }],
            Href: plan.variant.href,
          },
        });
        return { AddResults: [{ Id: 402 }] };
      },
    };
    const key = randomUUID();
    const options = {
      enabled: true,
      confirmCampaignId: 101,
      confirmControlAdId: "401",
      variantConfirmed: true,
    };
    const action = await createVerifiedAbVariant(
      db,
      userId,
      businessId,
      change.id,
      key,
      client,
      connectionId,
      options,
    );
    assert.equal(action.status, "succeeded");
    assert.equal(action.variantAdId, "402");
    assert.equal(writes, 1);
    const replay = await createVerifiedAbVariant(
      db,
      userId,
      businessId,
      change.id,
      key,
      client,
      connectionId,
      options,
    );
    assert.equal(replay.id, action.id);
    assert.equal(writes, 1);
    const savedPlan = directAbPlans(db, userId, businessId)[0];
    assert.equal(savedPlan.variant.adId, "402");
    assert.equal(savedPlan.status, "variant_created_held");
    assert.equal(savedPlan.blockers.length, 2);
    const readiness = await inspectModerationReadiness(
      db,
      userId,
      businessId,
      change.id,
      client,
      connectionId,
    );
    assert.deepEqual(readiness.adIds.map(String), ["401", "402"]);
    assert.ok(!readiness.blockers.includes("ad_content_changed"));
  } finally {
    db.close();
  }
});

test("A/B variant never replays an uncertain Ads.add and reconciles by reading", async () => {
  const { db, userId, businessId, connectionId } = setup();
  try {
    const change = await completedCampaign(
      db,
      userId,
      businessId,
      connectionId,
    );
    const plan = createDirectAbPlan(
      db,
      userId,
      businessId,
      change.id,
      randomUUID(),
      {
        hypothesis: "Конкретная выгода в заголовке повысит CTR объявления.",
        variant: { title: "Кофе и десерт рядом", text: "Закажите за минуту" },
        minDays: 14,
        minImpressionsPerVariant: 1000,
      },
    );
    let groupReadable = true;
    let writes = 0;
    const variant = {
      Id: 402,
      CampaignId: 101,
      AdGroupId: 202,
      TextAd: {
        Title: plan.variant.title,
        Text: plan.variant.text,
        Href: plan.variant.href,
      },
    };
    const client = {
      campaignBudgetById: async () => ({
        Campaigns: [
          {
            Id: 101,
            State: "SUSPENDED",
            Status: "DRAFT",
            Type: "TEXT_CAMPAIGN",
          },
        ],
      }),
      adsByIds: async () => ({
        Ads: [
          {
            Id: 401,
            CampaignId: 101,
            AdGroupId: 202,
            TextAd: {
              Title: plan.control.title,
              Text: plan.control.text,
              Href: plan.control.href,
            },
          },
        ],
      }),
      adsByAdGroupId: async () => {
        if (!groupReadable) throw new Error("timeout");
        return { Ads: [] };
      },
      createAds: async () => {
        writes++;
        groupReadable = false;
        throw new Error("lost response");
      },
    };
    const key = randomUUID();
    const options = {
      enabled: true,
      confirmCampaignId: 101,
      confirmControlAdId: "401",
      variantConfirmed: true,
    };
    const action = await createVerifiedAbVariant(
      db,
      userId,
      businessId,
      change.id,
      key,
      client,
      connectionId,
      options,
    );
    assert.equal(action.status, "needs_reconciliation");
    assert.equal(writes, 1);
    assert.equal(
      (
        await createVerifiedAbVariant(
          db,
          userId,
          businessId,
          change.id,
          key,
          client,
          connectionId,
          options,
        )
      ).status,
      "needs_reconciliation",
    );
    assert.equal(writes, 1);
    groupReadable = true;
    client.adsByAdGroupId = async () => ({ Ads: [variant] });
    const inspected = await inspectAbVariantAction(
      db,
      userId,
      businessId,
      change.id,
      action.id,
      client,
    );
    assert.equal(inspected.status, "succeeded");
    assert.equal(inspected.variantAdId, "402");
  } finally {
    db.close();
  }
});

test("A/B rollback deletes only the verified draft variant and is idempotent", async () => {
  const { db, userId, businessId, connectionId } = setup();
  try {
    const change = await completedCampaign(
        db,
        userId,
        businessId,
        connectionId,
      ),
      plan = createDirectAbPlan(
        db,
        userId,
        businessId,
        change.id,
        randomUUID(),
        {
          hypothesis: "Конкретная выгода в заголовке повысит CTR объявления.",
          variant: { title: "Кофе и десерт рядом", text: "Закажите за минуту" },
          minDays: 14,
          minImpressionsPerVariant: 1000,
        },
      ),
      stored = JSON.parse(
        db
          .prepare("SELECT plan_json FROM direct_ab_plans WHERE id=?")
          .get(plan.id).plan_json,
      );
    stored.variant.adId = "402";
    db.prepare("UPDATE direct_ab_plans SET plan_json=? WHERE id=?").run(
      JSON.stringify(stored),
      plan.id,
    );
    let exists = true,
      writes = 0;
    const client = {
      adsByIds: async () => ({
        Ads: exists
          ? [
              {
                Id: 402,
                CampaignId: 101,
                AdGroupId: 202,
                State: "OFF",
                Status: "DRAFT",
              },
            ]
          : [],
      }),
      deleteAds: async (ids) => {
        writes++;
        assert.deepEqual(ids, ["402"]);
        exists = false;
        return { DeleteResults: [{ Id: 402 }] };
      },
    };
    const key = randomUUID(),
      options = {
        enabled: true,
        operation: "rollback_variant",
        confirmCampaignId: 101,
        confirmTargetAdId: "402",
        confirmed: true,
      };
    await assert.rejects(
      applyDirectAbDecision(
        db,
        userId,
        businessId,
        plan.id,
        randomUUID(),
        client,
        connectionId,
        {
          ...options,
          now: Date.parse(change.plan.periodStart + "T12:00:00Z"),
        },
      ),
      /только до начала теста/,
    );
    assert.equal(writes, 0);
    const action = await applyDirectAbDecision(
      db,
      userId,
      businessId,
      plan.id,
      key,
      client,
      connectionId,
      options,
    );
    assert.equal(action.status, "succeeded");
    assert.equal(action.afterState, "DELETED");
    assert.equal(writes, 1);
    assert.equal(
      (
        await applyDirectAbDecision(
          db,
          userId,
          businessId,
          plan.id,
          key,
          client,
          connectionId,
          options,
        )
      ).id,
      action.id,
    );
    assert.equal(writes, 1);
    assert.equal(
      directAbPlans(db, userId, businessId)[0].status,
      "variant_rolled_back",
    );
    assert.equal(directAbVariantForChange(db, businessId, change.id), null);
  } finally {
    db.close();
  }
});

test("A/B final decision suspends only the confirmed losing ad", async () => {
  const { db, userId, businessId, connectionId } = setup();
  try {
    const change = await completedCampaign(
        db,
        userId,
        businessId,
        connectionId,
      ),
      plan = createDirectAbPlan(
        db,
        userId,
        businessId,
        change.id,
        randomUUID(),
        {
          hypothesis: "Конкретная выгода в заголовке повысит CTR объявления.",
          variant: { title: "Кофе и десерт рядом", text: "Закажите за минуту" },
          minDays: 14,
          minImpressionsPerVariant: 1000,
        },
      ),
      stored = JSON.parse(
        db
          .prepare("SELECT plan_json FROM direct_ab_plans WHERE id=?")
          .get(plan.id).plan_json,
      );
    stored.variant.adId = "402";
    db.prepare("UPDATE direct_ab_plans SET plan_json=? WHERE id=?").run(
      JSON.stringify(stored),
      plan.id,
    );
    const jobId = randomUUID(),
      snapshotId = randomUUID(),
      at = new Date().toISOString();
    db.prepare(
      `INSERT INTO jobs(id,business_id,kind,status,available_at,payload)
       VALUES(?,?,'report_sync','succeeded',?,?)`,
    ).run(
      jobId,
      businessId,
      Date.now(),
      JSON.stringify({ reportType: "ad", abPlanId: plan.id }),
    );
    db.prepare(
      `INSERT INTO report_snapshots(
       id,business_id,job_id,scope,source,login,date_from,date_to,currency,include_vat,
       received_at,raw_hash,raw_tsv,rows_json,totals_json,previous_id,comparison_json)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      snapshotId,
      businessId,
      jobId,
      "ab-scope",
      "yandex",
      change.plan.login,
      change.plan.periodStart,
      change.plan.periodEnd,
      "RUB",
      1,
      at,
      "hash",
      "tsv",
      JSON.stringify([
        {
          Date: change.plan.periodEnd,
          CampaignId: "101",
          AdId: "401",
          impressions: 1000,
          clicks: 20,
          spent: 1000,
        },
        {
          Date: change.plan.periodEnd,
          CampaignId: "101",
          AdId: "402",
          impressions: 1000,
          clicks: 100,
          spent: 1000,
        },
      ]),
      "{}",
      null,
      "{}",
    );
    assert.equal(
      directAbPlans(db, userId, businessId)[0].outcome,
      "variant_wins",
    );
    let state = "ON",
      writes = 0;
    const client = {
      adsByIds: async () => ({
        Ads: [
          {
            Id: 401,
            CampaignId: 101,
            AdGroupId: 202,
            State: state,
            Status: "ACCEPTED",
          },
        ],
      }),
      suspendAds: async (ids) => {
        writes++;
        assert.deepEqual(ids, ["401"]);
        state = "SUSPENDED";
        return { SuspendResults: [{ Id: 401 }] };
      },
    };
    const action = await applyDirectAbDecision(
      db,
      userId,
      businessId,
      plan.id,
      randomUUID(),
      client,
      connectionId,
      {
        enabled: true,
        operation: "apply_outcome",
        confirmCampaignId: 101,
        confirmTargetAdId: "401",
        confirmed: true,
      },
    );
    assert.equal(action.status, "succeeded");
    assert.equal(action.targetAdId, "401");
    assert.equal(action.afterState, "SUSPENDED");
    assert.equal(writes, 1);
    assert.equal(
      directAbPlans(db, userId, businessId)[0].status,
      "outcome_applied",
    );
    assert.equal(
      directAbVariantForChange(db, businessId, change.id).adId,
      "402",
    );
  } finally {
    db.close();
  }
});

test("uncertain A/B decision is never replayed and is reconciled by read", async () => {
  const { db, userId, businessId, connectionId } = setup();
  try {
    const change = await completedCampaign(
        db,
        userId,
        businessId,
        connectionId,
      ),
      plan = createDirectAbPlan(
        db,
        userId,
        businessId,
        change.id,
        randomUUID(),
        {
          hypothesis: "Конкретная выгода в заголовке повысит CTR объявления.",
          variant: { title: "Кофе и десерт рядом", text: "Закажите за минуту" },
          minDays: 14,
          minImpressionsPerVariant: 1000,
        },
      ),
      stored = JSON.parse(
        db
          .prepare("SELECT plan_json FROM direct_ab_plans WHERE id=?")
          .get(plan.id).plan_json,
      );
    stored.variant.adId = "402";
    db.prepare("UPDATE direct_ab_plans SET plan_json=? WHERE id=?").run(
      JSON.stringify(stored),
      plan.id,
    );
    let readable = true,
      exists = true,
      writes = 0;
    const client = {
      adsByIds: async () => {
        if (!readable) throw new Error("timeout");
        return {
          Ads: exists
            ? [
                {
                  Id: 402,
                  CampaignId: 101,
                  State: "OFF",
                  Status: "DRAFT",
                },
              ]
            : [],
        };
      },
      deleteAds: async () => {
        writes++;
        exists = false;
        readable = false;
        throw new Error("lost response");
      },
    };
    const action = await applyDirectAbDecision(
      db,
      userId,
      businessId,
      plan.id,
      randomUUID(),
      client,
      connectionId,
      {
        enabled: true,
        operation: "rollback_variant",
        confirmCampaignId: 101,
        confirmTargetAdId: "402",
        confirmed: true,
      },
    );
    assert.equal(action.status, "needs_reconciliation");
    assert.equal(writes, 1);
    readable = true;
    const inspected = await inspectDirectAbDecision(
      db,
      userId,
      businessId,
      plan.id,
      action.id,
      client,
    );
    assert.equal(inspected.status, "succeeded");
    assert.equal(inspected.afterState, "DELETED");
    assert.equal(writes, 1);
  } finally {
    db.close();
  }
});

test("interrupted A/B decisions distinguish pre-send from possible writes", async () => {
  const { db, userId, businessId, connectionId } = setup();
  try {
    const change = await completedCampaign(
        db,
        userId,
        businessId,
        connectionId,
      ),
      plan = createDirectAbPlan(
        db,
        userId,
        businessId,
        change.id,
        randomUUID(),
        {
          hypothesis: "Конкретная выгода в заголовке повысит CTR объявления.",
          variant: { title: "Кофе и десерт рядом", text: "Закажите за минуту" },
          minDays: 14,
          minImpressionsPerVariant: 1000,
        },
      ),
      at = new Date().toISOString(),
      insert = db.prepare(`INSERT INTO direct_ab_decision_actions(
        id,business_id,plan_id,change_id,connection_id,campaign_id,target_ad_id,
        operation,idempotency_key,status,write_attempted,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    insert.run(
      randomUUID(),
      businessId,
      plan.id,
      change.id,
      connectionId,
      101,
      "402",
      "rollback_variant",
      randomUUID(),
      "checking",
      0,
      at,
      at,
    );
    markInterruptedAbDecisionActions(db);
    insert.run(
      randomUUID(),
      businessId,
      plan.id,
      change.id,
      connectionId,
      101,
      "402",
      "rollback_variant",
      randomUUID(),
      "sending",
      1,
      at,
      at,
    );
    markInterruptedAbDecisionActions(db);
    assert.deepEqual(
      db
        .prepare(
          "SELECT status,error_code FROM direct_ab_decision_actions ORDER BY rowid",
        )
        .all()
        .map((row) => [row.status, row.error_code]),
      [
        ["failed_no_write", "interrupted_before_send"],
        ["needs_reconciliation", "interrupted_after_send"],
      ],
    );
  } finally {
    db.close();
  }
});

test("interrupted A/B actions distinguish pre-send from possible writes", async () => {
  const { db, userId, businessId, connectionId } = setup();
  try {
    const change = await completedCampaign(
      db,
      userId,
      businessId,
      connectionId,
    );
    const plan = createDirectAbPlan(
      db,
      userId,
      businessId,
      change.id,
      randomUUID(),
      {
        hypothesis: "Конкретная выгода в заголовке повысит CTR объявления.",
        variant: { title: "Кофе и десерт рядом", text: "Закажите за минуту" },
        minDays: 14,
        minImpressionsPerVariant: 1000,
      },
    );
    const at = new Date().toISOString();
    const insert = db.prepare(`INSERT INTO direct_ab_actions(
      id,business_id,plan_id,change_id,connection_id,campaign_id,ad_group_id,
      control_ad_id,idempotency_key,status,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`);
    insert.run(
      randomUUID(),
      businessId,
      plan.id,
      change.id,
      connectionId,
      101,
      202,
      "401",
      randomUUID(),
      "checking",
      at,
      at,
    );
    assert.equal(markInterruptedAbActions(db), 1);
    insert.run(
      randomUUID(),
      businessId,
      plan.id,
      change.id,
      connectionId,
      102,
      202,
      "401",
      randomUUID(),
      "sending",
      at,
      at,
    );
    assert.equal(markInterruptedAbActions(db), 1);
    assert.deepEqual(
      db
        .prepare("SELECT status FROM direct_ab_actions ORDER BY campaign_id")
        .all()
        .map((row) => row.status),
      ["failed_no_write", "needs_reconciliation"],
    );
  } finally {
    db.close();
  }
});

test("partially accepted keywords are read back before only the ad is created", async () => {
  const { db, userId, businessId, connectionId } = setup();
  try {
    const change = await approvedPlan(db, userId, businessId, connectionId);
    beginDirectExecution(db, userId, businessId, change.id, { enabled: true });
    for (const [key, ids] of [
      ["campaign", [101]],
      ["suspend", [101]],
      ["adgroup", [202]],
    ]) {
      recordDirectExecutionCheckpoint(db, userId, businessId, change.id, {
        phase: "before",
        key,
      });
      recordDirectExecutionCheckpoint(db, userId, businessId, change.id, {
        phase: "acknowledged",
        key,
        ids,
        ...(key === "suspend" ? { holdState: "OFF_DRAFT" } : {}),
      });
      if (key === "suspend")
        recordDirectExecutionCheckpoint(db, userId, businessId, change.id, {
          phase: "suspend_verified",
          key,
        });
    }
    recordDirectExecutionCheckpoint(db, userId, businessId, change.id, {
      phase: "before",
      key: "keywords",
    });
    stopDirectExecution(db, userId, businessId, change.id, "provider_error");
    let adWrites = 0;
    const client = {
      campaignBudgetById: async () => remoteDraftBudget(change.plan),
      adGroupsByCampaignId: async () => ({
        AdGroups: [{ Id: 202, CampaignId: 101 }],
      }),
      keywordsByAdGroupId: async () => ({
        Keywords: [
          { Id: 301, AdGroupId: 202, Keyword: change.plan.keywords[0] },
          { Id: 302, AdGroupId: 202, Keyword: change.plan.keywords[1] },
          { Id: 399, AdGroupId: 202, Keyword: "---autotargeting" },
        ],
      }),
      adsByAdGroupId: async () => ({ Ads: [] }),
      campaignsByIds: async () => ({
        Campaigns: [{ Id: 101, State: "OFF", Status: "DRAFT" }],
      }),
      createCampaigns: async () => assert.fail("campaign replay"),
      createAdGroups: async () => assert.fail("group replay"),
      createKeywords: async () => assert.fail("keywords replay"),
      createAds: async (items) => {
        adWrites++;
        assert.deepEqual(items[0].ResponsiveAd, {
          Titles: ["Кофе, рядом с вами"],
          Texts: [change.plan.ads[0].text],
          Href: change.plan.ads[0].href,
          ...(change.plan.ads[0].adImageHash
            ? { AdImageHashes: [change.plan.ads[0].adImageHash] }
            : {}),
        });
        throw new Error("lost ad response");
      },
      adGroupsByIds: async () => ({ AdGroups: [{ Id: 202, CampaignId: 101 }] }),
      keywordsByIds: async () => ({
        Keywords: [
          { Id: 301, AdGroupId: 202 },
          { Id: 302, AdGroupId: 202 },
        ],
      }),
      adsByIds: async () => ({
        Ads: [{ Id: "1925476440579438319", AdGroupId: 202 }],
      }),
    };
    await assert.rejects(
      continueVerifiedKeywordsExecution(
        db,
        userId,
        businessId,
        change.id,
        client,
        connectionId,
        { enabled: true },
      ),
      /lost ad response/,
    );
    assert.equal(
      directExecution(db, userId, businessId, change.id).inflightKey,
      "ads",
    );
    await assert.rejects(
      continueVerifiedKeywordsExecution(
        db,
        userId,
        businessId,
        change.id,
        client,
        connectionId,
        { enabled: true },
      ),
      /не совпадают с планом/,
    );
    assert.equal(adWrites, 1);
    client.adsByAdGroupId = async () => ({
      Ads: [
        {
          Id: "1925476440579438319",
          AdGroupId: 202,
          State: "OFF",
          Status: "DRAFT",
          Type: "RESPONSIVE_AD",
          ResponsiveAd: {
            Titles: [{ Title: "Кофе, рядом с вами" }],
            Texts: [{ Text: change.plan.ads[0].text }],
            Href: change.plan.ads[0].href,
          },
        },
      ],
    });
    const result = await continueVerifiedKeywordsExecution(
      db,
      userId,
      businessId,
      change.id,
      client,
      connectionId,
      { enabled: true },
    );
    assert.equal(result.status, "succeeded");
    assert.deepEqual(result.calls[3].ids, [301, 302]);
    assert.deepEqual(result.calls[4].ids, ["1925476440579438319"]);
    assert.equal(adWrites, 1);
  } finally {
    db.close();
  }
});

test("a rejected keyword is repaired once without replaying accepted phrases", async () => {
  const { db, userId, businessId, connectionId } = setup();
  try {
    const change = await approvedPlan(db, userId, businessId, connectionId);
    beginDirectExecution(db, userId, businessId, change.id, { enabled: true });
    for (const [key, ids] of [
      ["campaign", [101]],
      ["suspend", [101]],
      ["adgroup", [202]],
    ]) {
      recordDirectExecutionCheckpoint(db, userId, businessId, change.id, {
        phase: "before",
        key,
      });
      recordDirectExecutionCheckpoint(db, userId, businessId, change.id, {
        phase: "acknowledged",
        key,
        ids,
        ...(key === "suspend" ? { holdState: "OFF_DRAFT" } : {}),
      });
      if (key === "suspend")
        recordDirectExecutionCheckpoint(db, userId, businessId, change.id, {
          phase: "suspend_verified",
          key,
        });
    }
    recordDirectExecutionCheckpoint(db, userId, businessId, change.id, {
      phase: "before",
      key: "keywords",
    });
    stopDirectExecution(db, userId, businessId, change.id, "provider_error");
    let keywordWrites = 0;
    let remoteKeywords = [
      { Id: 301, AdGroupId: 202, Keyword: change.plan.keywords[0] },
    ];
    const client = {
      campaignBudgetById: async () => remoteDraftBudget(change.plan),
      adGroupsByCampaignId: async () => ({
        AdGroups: [{ Id: 202, CampaignId: 101 }],
      }),
      keywordsByAdGroupId: async () => ({
        Keywords: [
          ...remoteKeywords,
          { Id: 399, AdGroupId: 202, Keyword: "---autotargeting" },
        ],
      }),
      adsByAdGroupId: async () => ({ Ads: [] }),
      createCampaigns: async () => assert.fail("campaign replay"),
      createAdGroups: async () => assert.fail("group replay"),
      createKeywords: async (items) => {
        keywordWrites++;
        assert.deepEqual(items, [
          { AdGroupId: 202, Keyword: change.plan.keywords[1] },
        ]);
        remoteKeywords = [
          ...remoteKeywords,
          { Id: 302, AdGroupId: 202, Keyword: change.plan.keywords[1] },
        ];
        return { AddResults: [{ Id: 302 }] };
      },
      createAds: async () => ({ AddResults: [{ Id: 401 }] }),
      campaignsByIds: async () => ({
        Campaigns: [{ Id: 101, State: "OFF", Status: "DRAFT" }],
      }),
      adGroupsByIds: async () => ({
        AdGroups: [{ Id: 202, CampaignId: 101 }],
      }),
      keywordsByIds: async () => ({
        Keywords: [
          { Id: 301, AdGroupId: 202 },
          { Id: 302, AdGroupId: 202 },
        ],
      }),
      adsByIds: async () => ({ Ads: [{ Id: 401, AdGroupId: 202 }] }),
    };
    const result = await continueVerifiedKeywordsExecution(
      db,
      userId,
      businessId,
      change.id,
      client,
      connectionId,
      { enabled: true, rejectedAddCode: 5002 },
    );
    assert.equal(result.status, "succeeded");
    assert.equal(keywordWrites, 1);
    assert.deepEqual(result.calls[3].ids, [301, 302]);
    assert.deepEqual(result.calls[4].ids, [401]);
  } finally {
    db.close();
  }
});

test("budget check reads Direct strategy and previews a held future period without writes", async () => {
  const { db, userId, businessId, connectionId } = setup();
  try {
    const change = await completedCampaign(
      db,
      userId,
      businessId,
      connectionId,
    );
    let reads = 0;
    const result = await inspectDirectBudget(
      db,
      userId,
      businessId,
      change.id,
      {
        campaignBudgetById: async (id) => {
          reads++;
          assert.equal(id, 101);
          return remoteBudget(change.plan);
        },
      },
      connectionId,
    );
    assert.equal(result.status, "matched");
    assert.equal(result.remote.limitKopecks, change.plan.budget);
    assert.equal(result.report, null);
    assert.equal(result.safeToResumeOrChangeLimit, false);
    assert.equal(reads, 1);
    assert.deepEqual(
      latestDirectBudgetCheck(db, userId, businessId, change.id),
      result,
    );
    const preview = previewDirectBudgetLimit(
      db,
      userId,
      businessId,
      change.id,
      change.plan.budget - 10_000,
    );
    assert.equal(preview.mode, "read_only_preview");
    assert.equal(preview.externalWrites, 0);
    assert.equal(preview.canApply, false);
    assert.equal(preview.preliminaryChecksPassed, true);
    assert.equal(preview.knownReportedSpentKopecks, 0);
    const increase = previewDirectBudgetLimit(
      db,
      userId,
      businessId,
      change.id,
      change.plan.budget + 1,
    );
    assert.ok(
      increase.blockers.some((item) => item.includes("Выше исходного")),
    );
    const stale = previewDirectBudgetLimit(
      db,
      userId,
      businessId,
      change.id,
      change.plan.budget - 10_000,
      Date.parse(result.checkedAt) + 11 * 60_000,
    );
    assert.ok(stale.blockers.some((item) => item.includes("старше 10 минут")));
    await assert.rejects(
      inspectDirectBudget(
        db,
        userId,
        businessId,
        change.id,
        {
          campaignBudgetById: async () => {
            reads++;
          },
        },
        "different-connection",
      ),
      /Кабинет изменился/,
    );
    assert.equal(reads, 1);
  } finally {
    db.close();
  }
});

test("budget check isolates report provenance and flags an external limit change", async () => {
  const { db, userId, businessId, connectionId } = setup();
  try {
    const change = await completedCampaign(
      db,
      userId,
      businessId,
      connectionId,
    );
    const jobId = randomUUID(),
      snapshotId = randomUUID();
    const now = new Date().toISOString();
    const sig = createHash("sha256").update(connectionId).digest("hex");
    db.prepare(
      "INSERT INTO jobs(id,business_id,kind,status,available_at,payload) VALUES(?,?,'report_sync','succeeded',?,?)",
    ).run(jobId, businessId, Date.now(), JSON.stringify({ signature: sig }));
    db.prepare(
      `INSERT INTO report_snapshots
      (id,business_id,job_id,scope,source,login,date_from,date_to,currency,include_vat,
       received_at,raw_hash,raw_tsv,rows_json,totals_json,previous_id,comparison_json)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      snapshotId,
      businessId,
      jobId,
      "scope",
      "yandex",
      change.plan.login,
      change.plan.periodStart,
      change.plan.periodEnd,
      "RUB",
      1,
      now,
      "hash",
      "tsv",
      JSON.stringify([
        { Date: change.plan.periodStart, CampaignId: "101", spent: 1200 },
      ]),
      JSON.stringify({ spent: 1200 }),
      null,
      "{}",
    );
    const result = await inspectDirectBudget(
      db,
      userId,
      businessId,
      change.id,
      {
        campaignBudgetById: async () =>
          remoteBudget(change.plan, change.plan.budget - 10000),
      },
      connectionId,
    );
    assert.equal(result.status, "drift");
    assert.ok(result.findings.includes("limit_differs_from_plan"));
    assert.equal(result.report.snapshotId, snapshotId);
    assert.equal(result.report.reportedSpentKopecks, 1200);
    assert.equal(result.report.safeForAutomaticLimitChange, false);
    assert.equal(result.safeToResumeOrChangeLimit, false);
    const preview = previewDirectBudgetLimit(
      db,
      userId,
      businessId,
      change.id,
      1000,
    );
    assert.equal(preview.canApply, false);
    assert.ok(
      preview.blockers.some((item) => item.includes("расход уже выше")),
    );
    assert.ok(preview.blockers.some((item) => item.includes("отличаются")));
  } finally {
    db.close();
  }
});

test("budget reduction is decrease-only, idempotent and verified by read-back", async () => {
  const { db, userId, businessId, connectionId } = setup();
  try {
    const change = await completedCampaign(
      db,
      userId,
      businessId,
      connectionId,
    );
    await inspectDirectBudget(
      db,
      userId,
      businessId,
      change.id,
      { campaignBudgetById: async () => remoteBudget(change.plan) },
      connectionId,
    );
    let currentLimit = change.plan.budget;
    let writes = 0;
    const client = {
      campaignBudgetById: async () => remoteBudget(change.plan, currentLimit),
      updateTextCampaignPeriodBudget: async (id, input) => {
        writes++;
        assert.equal(id, 101);
        assert.equal(input.spendLimitKopecks, 250_000);
        assert.equal(input.startDate, change.plan.periodStart);
        assert.equal(input.endDate, change.plan.periodEnd);
        currentLimit = input.spendLimitKopecks;
        return { UpdateResults: [{ Id: 101 }] };
      },
    };
    const key = randomUUID();
    const confirmations = {
      enabled: true,
      proposedLimitKopecks: 250_000,
      confirmCampaignId: 101,
      confirmPreviousLimitKopecks: change.plan.budget,
      budgetConfirmed: true,
    };
    const result = await reduceVerifiedBudget(
      db,
      userId,
      businessId,
      change.id,
      key,
      client,
      connectionId,
      confirmations,
    );
    assert.equal(result.status, "succeeded");
    assert.equal(result.confirmedLimitKopecks, 250_000);
    assert.equal(writes, 1);
    const replay = await reduceVerifiedBudget(
      db,
      userId,
      businessId,
      change.id,
      key,
      client,
      connectionId,
      confirmations,
    );
    assert.equal(replay.id, result.id);
    assert.equal(writes, 1);
    assert.equal(budgetActions(db, userId, businessId, change.id).length, 1);
  } finally {
    db.close();
  }
});

test("a confirmed reduction can only be rolled back to the original owner budget", async () => {
  const { db, userId, businessId, connectionId } = setup();
  try {
    const change = await completedCampaign(
      db,
      userId,
      businessId,
      connectionId,
    );
    await inspectDirectBudget(
      db,
      userId,
      businessId,
      change.id,
      { campaignBudgetById: async () => remoteBudget(change.plan) },
      connectionId,
    );
    let currentLimit = change.plan.budget;
    let writes = 0;
    const client = {
      campaignBudgetById: async () => remoteBudget(change.plan, currentLimit),
      updateTextCampaignPeriodBudget: async (id, input) => {
        writes++;
        assert.equal(id, 101);
        assert.equal(
          input.spendLimitKopecks,
          writes === 1 ? 250_000 : change.plan.budget,
        );
        currentLimit = input.spendLimitKopecks;
        return { UpdateResults: [{ Id: 101 }] };
      },
    };
    const reduced = await reduceVerifiedBudget(
      db,
      userId,
      businessId,
      change.id,
      randomUUID(),
      client,
      connectionId,
      {
        enabled: true,
        proposedLimitKopecks: 250_000,
        confirmCampaignId: 101,
        confirmPreviousLimitKopecks: change.plan.budget,
        budgetConfirmed: true,
      },
    );
    assert.equal(reduced.status, "succeeded");
    const key = randomUUID();
    const options = {
      enabled: true,
      spendConfirmed: true,
      confirmCurrentLimitKopecks: 250_000,
      confirmRestoredLimitKopecks: change.plan.budget,
    };
    const restored = await rollbackReducedBudget(
      db,
      userId,
      businessId,
      reduced.id,
      key,
      client,
      connectionId,
      options,
    );
    assert.equal(restored.rollback.status, "succeeded");
    assert.equal(
      restored.rollback.confirmedLimitKopecks,
      change.plan.budget,
    );
    assert.equal(currentLimit, change.plan.budget);
    assert.equal(writes, 2);
    const replay = await rollbackReducedBudget(
      db,
      userId,
      businessId,
      reduced.id,
      key,
      client,
      connectionId,
      options,
    );
    assert.equal(replay.rollback.status, "succeeded");
    assert.equal(writes, 2);
  } finally {
    db.close();
  }
});

test("an uncertain budget rollback is never replayed and uses read-only reconciliation", async () => {
  const { db, userId, businessId, connectionId } = setup();
  try {
    const change = await completedCampaign(
      db,
      userId,
      businessId,
      connectionId,
    );
    await inspectDirectBudget(
      db,
      userId,
      businessId,
      change.id,
      { campaignBudgetById: async () => remoteBudget(change.plan) },
      connectionId,
    );
    let currentLimit = change.plan.budget;
    let writes = 0;
    let readsFail = false;
    const client = {
      campaignBudgetById: async () => {
        if (readsFail) throw new Error("timeout");
        return remoteBudget(change.plan, currentLimit);
      },
      updateTextCampaignPeriodBudget: async (_id, input) => {
        writes++;
        currentLimit = input.spendLimitKopecks;
        if (writes === 2) {
          readsFail = true;
          throw new Error("lost response");
        }
        return { UpdateResults: [{ Id: 101 }] };
      },
    };
    const reduced = await reduceVerifiedBudget(
      db,
      userId,
      businessId,
      change.id,
      randomUUID(),
      client,
      connectionId,
      {
        enabled: true,
        proposedLimitKopecks: 250_000,
        confirmCampaignId: 101,
        confirmPreviousLimitKopecks: change.plan.budget,
        budgetConfirmed: true,
      },
    );
    const key = randomUUID();
    const options = {
      enabled: true,
      spendConfirmed: true,
      confirmCurrentLimitKopecks: 250_000,
      confirmRestoredLimitKopecks: change.plan.budget,
    };
    const uncertain = await rollbackReducedBudget(
      db,
      userId,
      businessId,
      reduced.id,
      key,
      client,
      connectionId,
      options,
    );
    assert.equal(uncertain.rollback.status, "needs_reconciliation");
    assert.equal(writes, 2);
    const replay = await rollbackReducedBudget(
      db,
      userId,
      businessId,
      reduced.id,
      key,
      client,
      connectionId,
      options,
    );
    assert.equal(replay.rollback.status, "needs_reconciliation");
    assert.equal(writes, 2);
    readsFail = false;
    const reconciled = await inspectBudgetRollback(
      db,
      userId,
      businessId,
      reduced.id,
      client,
    );
    assert.equal(reconciled.rollback.status, "succeeded");
    assert.equal(writes, 2);
  } finally {
    db.close();
  }
});

test("budget reduction never increases a limit and never replays an uncertain write", async () => {
  const { db, userId, businessId, connectionId } = setup();
  try {
    const change = await completedCampaign(
      db,
      userId,
      businessId,
      connectionId,
    );
    await inspectDirectBudget(
      db,
      userId,
      businessId,
      change.id,
      { campaignBudgetById: async () => remoteBudget(change.plan) },
      connectionId,
    );
    let readsFail = false;
    let writes = 0;
    const client = {
      campaignBudgetById: async () => {
        if (readsFail) throw new Error("timeout");
        return remoteBudget(change.plan);
      },
      updateTextCampaignPeriodBudget: async () => {
        writes++;
        readsFail = true;
        throw new Error("lost response");
      },
    };
    await assert.rejects(
      reduceVerifiedBudget(
        db,
        userId,
        businessId,
        change.id,
        randomUUID(),
        client,
        connectionId,
        {
          enabled: true,
          proposedLimitKopecks: change.plan.budget + 1,
          confirmCampaignId: 101,
          confirmPreviousLimitKopecks: change.plan.budget,
          budgetConfirmed: true,
        },
      ),
      /только уменьшение/,
    );
    assert.equal(writes, 0);
    const key = randomUUID();
    const options = {
      enabled: true,
      proposedLimitKopecks: 250_000,
      confirmCampaignId: 101,
      confirmPreviousLimitKopecks: change.plan.budget,
      budgetConfirmed: true,
    };
    const uncertain = await reduceVerifiedBudget(
      db,
      userId,
      businessId,
      change.id,
      key,
      client,
      connectionId,
      options,
    );
    assert.equal(uncertain.status, "needs_reconciliation");
    assert.equal(writes, 1);
    const replay = await reduceVerifiedBudget(
      db,
      userId,
      businessId,
      change.id,
      key,
      client,
      connectionId,
      options,
    );
    assert.equal(replay.status, "needs_reconciliation");
    assert.equal(writes, 1);
    readsFail = false;
    const inspected = await inspectBudgetAction(
      db,
      userId,
      businessId,
      change.id,
      uncertain.id,
      client,
    );
    assert.equal(inspected.status, "not_applied");
    assert.equal(inspected.confirmedLimitKopecks, change.plan.budget);
  } finally {
    db.close();
  }
});

test("interrupted budget actions distinguish pre-send from possible writes", async () => {
  const { db, userId, businessId, connectionId } = setup();
  try {
    const change = await completedCampaign(
      db,
      userId,
      businessId,
      connectionId,
    );
    const now = new Date().toISOString();
    const insert = db.prepare(`INSERT INTO direct_budget_actions(
      id,business_id,change_id,connection_id,campaign_id,idempotency_key,check_id,
      previous_limit,requested_limit,status,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`);
    for (const [status, campaignId] of [
      ["checking", 101],
      ["sending", 102],
    ])
      insert.run(
        randomUUID(),
        businessId,
        change.id,
        connectionId,
        campaignId,
        randomUUID(),
        randomUUID(),
        300_000,
        250_000,
        status,
        now,
        now,
      );
    assert.equal(markInterruptedBudgetActions(db), 2);
    assert.deepEqual(
      db
        .prepare(
          "SELECT status FROM direct_budget_actions ORDER BY campaign_id",
        )
        .all()
        .map((row) => row.status),
      ["failed_no_write", "needs_reconciliation"],
    );
  } finally {
    db.close();
  }
});

test("control review reads the real draft and blocks paid launch without writes", async () => {
  const { db, userId, businessId, connectionId } = setup();
  try {
    const change = await completedCampaign(
      db,
      userId,
      businessId,
      connectionId,
    );
    let reads = 0;
    const client = {
      campaignBudgetById: async () => {
        reads++;
        return {
          Campaigns: [
            {
              ...remoteDraftBudget(change.plan).Campaigns[0],
              StatusPayment: "DISALLOWED",
            },
          ],
        };
      },
      adGroupsByIds: async () => {
        reads++;
        return {
          AdGroups: [{ Id: 202, CampaignId: 101, Status: "DRAFT" }],
        };
      },
      adsByIds: async () => {
        reads++;
        return {
          Ads: [
            {
              Id: 401,
              CampaignId: 101,
              AdGroupId: 202,
              State: "OFF",
              Status: "DRAFT",
            },
          ],
        };
      },
      keywordsByIds: async () => {
        reads++;
        return {
          Keywords: [301, 302].map((Id) => ({
            Id,
            CampaignId: 101,
            AdGroupId: 202,
            State: "ON",
            Status: "ACCEPTED",
          })),
        };
      },
      resumeCampaigns: async () =>
        assert.fail("control review must not resume"),
      suspendCampaigns: async () =>
        assert.fail("control review must not write"),
    };
    const key = randomUUID();
    const result = await inspectDirectControl(
      db,
      userId,
      businessId,
      change.id,
      key,
      client,
      connectionId,
    );
    assert.equal(result.status, "blocked");
    assert.equal(result.safeToResume, false);
    assert.equal(result.externalWrites, 0);
    assert.equal(result.budget.spentKopecks, null);
    assert.ok(result.blockers.includes("period_not_started"));
    assert.ok(result.blockers.includes("campaign_not_accepted"));
    assert.ok(result.blockers.includes("ads_not_ready"));
    assert.ok(result.blockers.includes("payment_not_confirmed"));
    assert.deepEqual(
      await inspectDirectControl(
        db,
        userId,
        businessId,
        change.id,
        key,
        client,
        connectionId,
      ),
      result,
    );
    assert.equal(reads, 4);
    assert.deepEqual(
      latestDirectControlReview(db, userId, businessId, change.id),
      result,
    );
  } finally {
    db.close();
  }
});

test("control review distinguishes technical readiness from launch approval", async () => {
  const { db, userId, businessId, connectionId } = setup();
  try {
    const change = await completedCampaign(
      db,
      userId,
      businessId,
      connectionId,
    );
    const now = Date.parse(`${change.plan.periodStart}T12:00:00Z`);
    const jobId = randomUUID(),
      snapshotId = randomUUID();
    const signature = createHash("sha256").update(connectionId).digest("hex");
    db.prepare(
      `INSERT INTO jobs(id,business_id,kind,status,available_at,payload)
      VALUES(?,?,'report_sync','succeeded',?,?)`,
    ).run(jobId, businessId, now, JSON.stringify({ signature }));
    db.prepare(
      `INSERT INTO report_snapshots
      (id,business_id,job_id,scope,source,login,date_from,date_to,currency,include_vat,
       received_at,raw_hash,raw_tsv,rows_json,totals_json,previous_id,comparison_json)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      snapshotId,
      businessId,
      jobId,
      "scope",
      "yandex",
      change.plan.login,
      change.plan.periodStart,
      change.plan.periodStart,
      "RUB",
      1,
      new Date(now).toISOString(),
      "hash",
      "tsv",
      "[]",
      "{}",
      null,
      "{}",
    );
    const result = await inspectDirectControl(
      db,
      userId,
      businessId,
      change.id,
      randomUUID(),
      {
        campaignBudgetById: async () => ({
          Campaigns: [
            {
              ...remoteBudget(change.plan).Campaigns[0],
              Status: "ACCEPTED",
              StatusPayment: "ALLOWED",
            },
          ],
        }),
        adGroupsByIds: async () => ({
          AdGroups: [{ Id: 202, CampaignId: 101 }],
        }),
        adsByIds: async () => ({
          Ads: [
            {
              Id: 401,
              CampaignId: 101,
              AdGroupId: 202,
              State: "ON",
              Status: "ACCEPTED",
              ResponsiveAd: {
                Titles: [{ Title: change.plan.ads[0].title }],
                Texts: [{ Text: change.plan.ads[0].text }],
                Href: change.plan.ads[0].href,
              },
            },
          ],
        }),
        keywordsByIds: async () => ({
          Keywords: [301, 302].map((Id) => ({
            Id,
            CampaignId: 101,
            AdGroupId: 202,
            State: "ON",
            Status: "ACCEPTED",
          })),
        }),
      },
      connectionId,
      now,
    );
    assert.equal(result.status, "technical_ready");
    assert.deepEqual(result.blockers, []);
    assert.equal(result.budget.spentKopecks, 0);
    assert.equal(result.safeToResume, false);
    assert.equal(result.manualChecks.length, 3);
  } finally {
    db.close();
  }
});

test("resume is gated, verifies the period cap, and sends Campaigns.resume once", async () => {
  const { db, userId, businessId, connectionId } = setup();
  try {
    const change = await completedCampaign(
      db,
      userId,
      businessId,
      connectionId,
    );
    const fixture = resumeFixture(db, businessId, connectionId, change.plan);
    const confirmed = {
      enabled: true,
      advertiserConfirmed: true,
      siteConfirmed: true,
      markingConfirmed: true,
      spendConfirmed: true,
      confirmCampaignId: 101,
      confirmLimitKopecks: change.plan.budget,
      now: fixture.now,
    };
    await assert.rejects(
      resumeVerifiedCampaign(
        db,
        userId,
        businessId,
        change.id,
        randomUUID(),
        fixture.client,
        connectionId,
        { ...confirmed, enabled: false },
      ),
      /отключён/,
    );
    await assert.rejects(
      resumeVerifiedCampaign(
        db,
        userId,
        businessId,
        change.id,
        randomUUID(),
        fixture.client,
        connectionId,
        { ...confirmed, confirmLimitKopecks: change.plan.budget + 1 },
      ),
      /лимит/,
    );
    assert.equal(fixture.writes(), 0);
    const key = randomUUID();
    const first = await resumeVerifiedCampaign(
      db,
      userId,
      businessId,
      change.id,
      key,
      fixture.client,
      connectionId,
      confirmed,
    );
    assert.equal(first.status, "succeeded");
    assert.equal(first.afterState, "ON");
    assert.equal(fixture.writes(), 1);
    const repeat = await resumeVerifiedCampaign(
      db,
      userId,
      businessId,
      change.id,
      key,
      fixture.client,
      connectionId,
      confirmed,
    );
    assert.deepEqual(repeat, first);
    assert.equal(fixture.writes(), 1);
    assert.equal(resumeActions(db, userId, businessId, change.id).length, 1);
  } finally {
    db.close();
  }
});

test("resume rejects a changed ad before any external write", async () => {
  const { db, userId, businessId, connectionId } = setup();
  try {
    const change = await completedCampaign(
      db,
      userId,
      businessId,
      connectionId,
    );
    const fixture = resumeFixture(db, businessId, connectionId, change.plan);
    const changed = {
      ...fixture.client,
      adsByIds: async () => ({
        Ads: [
          {
            Id: 401,
            CampaignId: 101,
            AdGroupId: 202,
            State: "ON",
            Status: "ACCEPTED",
            ResponsiveAd: {
              Titles: [{ Title: "Другой заголовок" }],
              Texts: [{ Text: change.plan.ads[0].text }],
              Href: change.plan.ads[0].href,
            },
          },
        ],
      }),
    };
    const action = await resumeVerifiedCampaign(
      db,
      userId,
      businessId,
      change.id,
      randomUUID(),
      changed,
      connectionId,
      {
        enabled: true,
        advertiserConfirmed: true,
        siteConfirmed: true,
        markingConfirmed: true,
        spendConfirmed: true,
        confirmCampaignId: 101,
        confirmLimitKopecks: change.plan.budget,
        now: fixture.now,
      },
    );
    assert.equal(action.status, "failed_no_write");
    assert.equal(action.writeAttempted, false);
    assert.equal(fixture.writes(), 0);
  } finally {
    db.close();
  }
});

test("uncertain resume is never replayed and is resolved only by reading Direct", async () => {
  const { db, userId, businessId, connectionId } = setup();
  try {
    const change = await completedCampaign(
      db,
      userId,
      businessId,
      connectionId,
    );
    const fixture = resumeFixture(db, businessId, connectionId, change.plan);
    const confirmed = {
      enabled: true,
      advertiserConfirmed: true,
      siteConfirmed: true,
      markingConfirmed: true,
      spendConfirmed: true,
      confirmCampaignId: 101,
      confirmLimitKopecks: change.plan.budget,
      now: fixture.now,
    };
    const key = randomUUID();
    const client = {
      ...fixture.client,
      resumeCampaigns: async () => {
        fixture.setState("SUSPENDED");
        throw new Error("timeout after write");
      },
    };
    const action = await resumeVerifiedCampaign(
      db,
      userId,
      businessId,
      change.id,
      key,
      client,
      connectionId,
      confirmed,
    );
    assert.equal(action.status, "needs_reconciliation");
    assert.equal(action.writeAttempted, true);
    assert.equal(
      (
        await resumeVerifiedCampaign(
          db,
          userId,
          businessId,
          change.id,
          key,
          client,
          connectionId,
          confirmed,
        )
      ).status,
      "needs_reconciliation",
    );
    await assert.rejects(
      resumeVerifiedCampaign(
        db,
        userId,
        businessId,
        change.id,
        randomUUID(),
        client,
        connectionId,
        confirmed,
      ),
      /сверки/,
    );
    assert.equal(
      (
        await inspectResumeAction(
          db,
          userId,
          businessId,
          change.id,
          action.id,
          client,
        )
      ).status,
      "needs_reconciliation",
    );
    fixture.setState("ON");
    assert.equal(
      (
        await inspectResumeAction(
          db,
          userId,
          businessId,
          change.id,
          action.id,
          client,
        )
      ).status,
      "succeeded",
    );
  } finally {
    db.close();
  }
});

test("interrupted resume marks pre-send safe and possible write uncertain", async () => {
  const { db, userId, businessId, connectionId } = setup();
  try {
    const change = await completedCampaign(
      db,
      userId,
      businessId,
      connectionId,
    );
    const values = ["checking", "sending"];
    for (const status of values)
      db.prepare(
        `INSERT INTO direct_resume_actions
      (id,business_id,change_id,connection_id,campaign_id,idempotency_key,status,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?)`,
      ).run(
        randomUUID(),
        businessId,
        change.id,
        connectionId,
        status === "checking" ? 101 : 102,
        randomUUID(),
        status,
        new Date().toISOString(),
        new Date().toISOString(),
      );
    assert.equal(markInterruptedResumeActions(db), 2);
    const statuses = db
      .prepare("SELECT status FROM direct_resume_actions ORDER BY campaign_id")
      .all();
    assert.deepEqual(
      statuses.map((item) => item.status),
      ["failed_no_write", "needs_reconciliation"],
    );
  } finally {
    db.close();
  }
});

test("suspend journals one external call, verifies read-back and rejects duplicate dispatch", async () => {
  const { db, userId, businessId, connectionId } = setup();
  try {
    const change = await completedCampaign(
      db,
      userId,
      businessId,
      connectionId,
    );
    let state = "ON",
      writes = 0,
      reads = 0;
    const client = {
      campaignsByIds: async () => {
        reads++;
        return { Campaigns: [{ Id: 101, State: state }] };
      },
      suspendCampaigns: async () => {
        writes++;
        state = "SUSPENDED";
        return { SuspendResults: [{ Id: 101 }] };
      },
    };
    const key = randomUUID();
    await assert.rejects(
      suspendVerifiedCampaign(db, userId, businessId, change.id, key, client),
      /отключено/,
    );
    const result = await suspendVerifiedCampaign(
      db,
      userId,
      businessId,
      change.id,
      key,
      client,
      { enabled: true },
    );
    assert.equal(result.status, "succeeded");
    assert.equal(result.beforeState, "ON");
    assert.equal(result.afterState, "SUSPENDED");
    assert.equal(result.writeAttempted, true);
    assert.equal(writes, 1);
    assert.equal(reads, 2);
    const replay = await suspendVerifiedCampaign(
      db,
      userId,
      businessId,
      change.id,
      key,
      client,
      { enabled: true },
    );
    assert.deepEqual(replay, result);
    assert.equal(writes, 1);
    assert.equal(lifecycleActions(db, userId, businessId, change.id).length, 1);
  } finally {
    db.close();
  }
});

test("suspend request for an OFF draft records a safe no-write result", async () => {
  const { db, userId, businessId, connectionId } = setup();
  try {
    const change = await completedCampaign(
      db,
      userId,
      businessId,
      connectionId,
    );
    let reads = 0;
    const client = {
      campaignsByIds: async () => {
        reads++;
        return { Campaigns: [{ Id: 101, State: "OFF", Status: "DRAFT" }] };
      },
      suspendCampaigns: async () => assert.fail("draft must not be suspended"),
    };
    const key = randomUUID();
    const result = await suspendVerifiedCampaign(
      db,
      userId,
      businessId,
      change.id,
      key,
      client,
      { enabled: true },
    );
    assert.equal(result.status, "succeeded");
    assert.equal(result.afterState, "OFF");
    assert.equal(result.writeAttempted, false);
    assert.equal(reads, 1);
    const events = db
      .prepare("SELECT payload FROM events WHERE business_id=?")
      .all(businessId);
    assert.ok(
      events.some(
        (item) =>
          JSON.parse(item.payload).kind === "direct_campaign_already_held",
      ),
    );
    const replay = await suspendVerifiedCampaign(
      db,
      userId,
      businessId,
      change.id,
      key,
      client,
      { enabled: true },
    );
    assert.deepEqual(replay, result);
    assert.equal(reads, 1);
  } finally {
    db.close();
  }
});

test("lost suspend response is reconciled by read; uncertain state is never retried", async () => {
  const { db, userId, businessId, connectionId } = setup();
  try {
    const change = await completedCampaign(
      db,
      userId,
      businessId,
      connectionId,
    );
    let state = "ON",
      writes = 0;
    const client = {
      campaignsByIds: async () => ({ Campaigns: [{ Id: 101, State: state }] }),
      suspendCampaigns: async () => {
        writes++;
        state = "SUSPENDED";
        throw new Error("lost response");
      },
    };
    const success = await suspendVerifiedCampaign(
      db,
      userId,
      businessId,
      change.id,
      randomUUID(),
      client,
      { enabled: true },
    );
    assert.equal(success.status, "succeeded");
    assert.equal(writes, 1);
    state = "ON";
    client.suspendCampaigns = async () => {
      writes++;
      throw new Error("lost response");
    };
    const key = randomUUID();
    const uncertain = await suspendVerifiedCampaign(
      db,
      userId,
      businessId,
      change.id,
      key,
      client,
      { enabled: true },
    );
    assert.equal(uncertain.status, "needs_reconciliation");
    assert.equal(writes, 2);
    await suspendVerifiedCampaign(
      db,
      userId,
      businessId,
      change.id,
      key,
      client,
      { enabled: true },
    );
    assert.equal(writes, 2);
    assert.equal(markInterruptedLifecycleActions(db), 0);
    state = "SUSPENDED";
    const inspected = await inspectLifecycleAction(
      db,
      userId,
      businessId,
      change.id,
      uncertain.id,
      client,
    );
    assert.equal(inspected.status, "succeeded");
    assert.equal(writes, 2);
  } finally {
    db.close();
  }
});

test("failed precheck sends no suspend and allows a fresh explicit request", async () => {
  const { db, userId, businessId, connectionId } = setup();
  try {
    const change = await completedCampaign(
      db,
      userId,
      businessId,
      connectionId,
    );
    let writes = 0;
    const failed = await suspendVerifiedCampaign(
      db,
      userId,
      businessId,
      change.id,
      randomUUID(),
      {
        campaignsByIds: async () => {
          throw new Error("read unavailable");
        },
        suspendCampaigns: async () => {
          writes++;
        },
      },
      { enabled: true },
    );
    assert.equal(failed.status, "failed_no_write");
    assert.equal(failed.writeAttempted, false);
    assert.equal(writes, 0);
    const next = await suspendVerifiedCampaign(
      db,
      userId,
      businessId,
      change.id,
      randomUUID(),
      {
        campaignsByIds: async () => ({
          Campaigns: [{ Id: 101, State: "SUSPENDED" }],
        }),
        suspendCampaigns: async () => {
          writes++;
        },
      },
      { enabled: true },
    );
    assert.equal(next.status, "succeeded");
    assert.equal(next.writeAttempted, false);
    assert.equal(writes, 0);
  } finally {
    db.close();
  }
});

test("restart distinguishes pre-send and possibly sent suspend actions", async () => {
  const { db, userId, businessId, connectionId } = setup();
  try {
    const change = await completedCampaign(
      db,
      userId,
      businessId,
      connectionId,
    );
    const at = new Date().toISOString();
    const insert = db.prepare(`INSERT INTO direct_lifecycle_actions
      (id,business_id,change_id,connection_id,campaign_id,idempotency_key,kind,status,created_at,updated_at)
      VALUES(?,?,?,?,?,?,'suspend',?,?,?)`);
    const checkingId = randomUUID(),
      sendingId = randomUUID();
    insert.run(
      checkingId,
      businessId,
      change.id,
      connectionId,
      101,
      randomUUID(),
      "checking",
      at,
      at,
    );
    insert.run(
      sendingId,
      businessId,
      change.id,
      connectionId,
      102,
      randomUUID(),
      "sending",
      at,
      at,
    );
    assert.equal(markInterruptedLifecycleActions(db), 2);
    const actions = lifecycleActions(db, userId, businessId, change.id);
    assert.equal(
      actions.find((item) => item.id === checkingId).status,
      "failed_no_write",
    );
    assert.equal(
      actions.find((item) => item.id === sendingId).status,
      "needs_reconciliation",
    );
  } finally {
    db.close();
  }
});

test("interrupted execution reads acknowledged IDs and never replays an uncertain add", async () => {
  const { db, userId, businessId, connectionId } = setup();
  try {
    const change = await approvedPlan(db, userId, businessId, connectionId);
    beginDirectExecution(db, userId, businessId, change.id, { enabled: true });
    for (const item of [
      { phase: "before", key: "campaign" },
      { phase: "acknowledged", key: "campaign", ids: [101] },
      { phase: "before", key: "suspend" },
      { phase: "acknowledged", key: "suspend", ids: [101] },
      { phase: "suspend_verified", key: "suspend" },
      { phase: "before", key: "adgroup" },
      { phase: "acknowledged", key: "adgroup", ids: [202] },
      { phase: "before", key: "keywords" },
    ])
      recordDirectExecutionCheckpoint(db, userId, businessId, change.id, item);
    stopDirectExecution(db, userId, businessId, change.id);
    const reads = [];
    const client = {
      campaignsByIds: async (ids) => {
        reads.push(["campaigns", ids]);
        return { Campaigns: [{ Id: 101, State: "SUSPENDED" }] };
      },
      adGroupsByIds: async (ids) => {
        reads.push(["adgroups", ids]);
        return { AdGroups: [{ Id: 202, CampaignId: 101 }] };
      },
      keywordsByIds: async () => assert.fail("unknown IDs cannot be read"),
      adsByIds: async () => assert.fail("unknown IDs cannot be read"),
    };
    await assert.rejects(
      inspectDirectExecution(
        db,
        userId,
        businessId,
        change.id,
        client,
        "other-connection",
      ),
      /Кабинет изменился/,
    );
    const result = await inspectDirectExecution(
      db,
      userId,
      businessId,
      change.id,
      client,
      connectionId,
    );
    assert.equal(result.status, "needs_reconciliation");
    assert.equal(result.reconciliation.status, "incomplete");
    assert.equal(result.reconciliation.unresolvedStep, "keywords");
    assert.deepEqual(reads, [
      ["campaigns", [101]],
      ["adgroups", [202]],
    ]);
  } finally {
    db.close();
  }
});

test("completed remote objects can be verified after an interrupted read-back", async () => {
  const { db, userId, businessId, connectionId } = setup();
  try {
    const change = await approvedPlan(db, userId, businessId, connectionId);
    beginDirectExecution(db, userId, businessId, change.id, { enabled: true });
    for (const item of [
      { phase: "before", key: "campaign" },
      { phase: "acknowledged", key: "campaign", ids: [101] },
      { phase: "before", key: "suspend" },
      { phase: "acknowledged", key: "suspend", ids: [101] },
      { phase: "suspend_verified", key: "suspend" },
      { phase: "before", key: "adgroup" },
      { phase: "acknowledged", key: "adgroup", ids: [202] },
      { phase: "before", key: "keywords" },
      { phase: "acknowledged", key: "keywords", ids: [301, 302] },
      { phase: "before", key: "ads" },
      { phase: "acknowledged", key: "ads", ids: [401] },
    ])
      recordDirectExecutionCheckpoint(db, userId, businessId, change.id, item);
    stopDirectExecution(
      db,
      userId,
      businessId,
      change.id,
      "readback_interrupted",
    );
    const result = await inspectDirectExecution(
      db,
      userId,
      businessId,
      change.id,
      {
        campaignsByIds: async () => ({
          Campaigns: [{ Id: 101, State: "SUSPENDED" }],
        }),
        adGroupsByIds: async () => ({
          AdGroups: [{ Id: 202, CampaignId: 101 }],
        }),
        keywordsByIds: async () => ({
          Keywords: [
            { Id: 301, AdGroupId: 202 },
            { Id: 302, AdGroupId: 202 },
          ],
        }),
        adsByIds: async () => ({ Ads: [{ Id: 401, AdGroupId: 202 }] }),
      },
      connectionId,
    );
    assert.equal(result.status, "succeeded");
    assert.equal(result.reconciliation.status, "matched");
    assert.equal(result.reconciliation.readCalls, 4);
  } finally {
    db.close();
  }
});

test("write journal records every remote ID and only finishes after full read-back", async () => {
  const { db, userId, businessId, connectionId } = setup();
  try {
    const change = await approvedPlan(db, userId, businessId, connectionId);
    assert.throws(
      () => beginDirectExecution(db, userId, businessId, change.id),
      /отключена/,
    );
    const started = beginDirectExecution(db, userId, businessId, change.id, {
      enabled: true,
    });
    assert.equal(started.status, "running");
    assert.equal(
      db
        .prepare("SELECT consumed_at FROM direct_approvals WHERE change_id=?")
        .get(change.id).consumed_at !== null,
      true,
    );
    const client = {
      createCampaigns: async () => ({ AddResults: [{ Id: 101 }] }),
      suspendCampaigns: async () => ({ SuspendResults: [{ Id: 101 }] }),
      createAdGroups: async () => ({ AddResults: [{ Id: 202 }] }),
      createKeywords: async () => ({
        AddResults: [{ Id: 301 }, { Id: 302 }],
      }),
      createAds: async () => ({ AddResults: [{ Id: 401 }] }),
      campaignsByIds: async () => ({
        Campaigns: [{ Id: 101, State: "SUSPENDED" }],
      }),
      adGroupsByIds: async () => ({
        AdGroups: [{ Id: 202, CampaignId: 101 }],
      }),
      keywordsByIds: async () => ({
        Keywords: [
          { Id: 301, AdGroupId: 202 },
          { Id: 302, AdGroupId: 202 },
        ],
      }),
      adsByIds: async () => ({ Ads: [{ Id: 401, AdGroupId: 202 }] }),
    };
    const result = await executeDirectCommands(client, change.commands, {
      checkpoint: (item) =>
        recordDirectExecutionCheckpoint(
          db,
          userId,
          businessId,
          change.id,
          item,
        ),
    });
    const beforeFinish = directExecution(db, userId, businessId, change.id);
    assert.deepEqual(
      beforeFinish.calls.map((item) => item.ids),
      [[101], [101], [202], [301, 302], [401]],
    );
    assert.equal(beforeFinish.suspendVerified, true);
    assert.throws(
      () =>
        finishDirectExecution(db, userId, businessId, change.id, {
          status: "matched",
          matched: true,
        }),
      /Полная сверка/,
    );
    const reconciliation = await reconcileDirectObjects(client, result.calls);
    const finished = finishDirectExecution(
      db,
      userId,
      businessId,
      change.id,
      reconciliation,
    );
    assert.equal(finished.status, "succeeded");
    assert.equal(finished.reconciliation.matched, true);
    assert.throws(
      () =>
        beginDirectExecution(db, userId, businessId, change.id, {
          enabled: true,
        }),
      /уже передавался|устарели/,
    );
  } finally {
    db.close();
  }
});

test("uncertain remote result remains visible and cannot be retried automatically", async () => {
  const { db, userId, businessId, connectionId } = setup();
  try {
    const change = await approvedPlan(db, userId, businessId, connectionId);
    beginDirectExecution(db, userId, businessId, change.id, {
      enabled: true,
    });
    recordDirectExecutionCheckpoint(db, userId, businessId, change.id, {
      phase: "before",
      key: "campaign",
    });
    assert.throws(
      () =>
        recordDirectExecutionCheckpoint(db, userId, businessId, change.id, {
          phase: "acknowledged",
          key: "campaign",
          ids: [101, 102],
        }),
      /Некорректное подтверждение/,
    );
    const stopped = stopDirectExecution(
      db,
      userId,
      businessId,
      change.id,
      "provider_timeout",
    );
    assert.equal(stopped.status, "needs_reconciliation");
    assert.equal(stopped.inflightKey, "campaign");
    assert.deepEqual(stopped.calls, []);
    assert.throws(
      () =>
        recordDirectExecutionCheckpoint(db, userId, businessId, change.id, {
          phase: "before",
          key: "campaign",
        }),
      /остановлено/,
    );
    assert.throws(
      () => directExecution(db, randomUUID(), businessId, change.id),
      /найден/,
    );
  } finally {
    db.close();
  }
});

test("restart marks unfinished writes for reconciliation without replay", async () => {
  const { db, userId, businessId, connectionId } = setup();
  try {
    const change = await approvedPlan(db, userId, businessId, connectionId);
    beginDirectExecution(db, userId, businessId, change.id, {
      enabled: true,
    });
    recordDirectExecutionCheckpoint(db, userId, businessId, change.id, {
      phase: "before",
      key: "campaign",
    });
    assert.equal(markInterruptedDirectExecutions(db), 1);
    assert.equal(markInterruptedDirectExecutions(db), 0);
    const view = directExecution(db, userId, businessId, change.id);
    assert.equal(view.status, "needs_reconciliation");
    assert.equal(view.inflightKey, "campaign");
    assert.equal(view.errorCode, "process_interrupted");
  } finally {
    db.close();
  }
});

test("orchestrator preserves an ambiguous campaign result and blocks replay", async () => {
  const { db, userId, businessId, connectionId } = setup();
  try {
    const change = await approvedPlan(db, userId, businessId, connectionId);
    let writes = 0;
    await assert.rejects(
      runApprovedDirectExecution(
        db,
        userId,
        businessId,
        change.id,
        {
          createCampaigns: async () => {
            writes++;
            throw new Error("connection lost after remote request");
          },
        },
        { enabled: true },
      ),
      /connection lost/,
    );
    const view = directExecution(db, userId, businessId, change.id);
    assert.equal(view.status, "needs_reconciliation");
    assert.equal(view.inflightKey, "campaign");
    assert.equal(writes, 1);
    await assert.rejects(
      runApprovedDirectExecution(
        db,
        userId,
        businessId,
        change.id,
        { createCampaigns: async () => writes++ },
        { enabled: true },
      ),
      /устарели|уже передавался/,
    );
    assert.equal(writes, 1);
  } finally {
    db.close();
  }
});

test("guarded HTTP pilot creates one suspended plan and rejects duplicate dispatch", async () => {
  const { db, userId, businessId, connectionId } = setup();
  const encryptionKey = randomBytes(32);
  let server;
  try {
    const change = await approvedPlan(db, userId, businessId, connectionId);
    db.prepare(
      "UPDATE connections SET encrypted=? WHERE business_id=? AND provider='yandex'",
    ).run(
      encrypt(
        {
          access_token: "test-access-token",
          refresh_token: "test-refresh-token",
          expires_at: Date.now() + 86_400_000,
        },
        encryptionKey,
        businessId + ":yandex",
      ),
      businessId,
    );
    const session = randomUUID();
    db.prepare("INSERT INTO sessions VALUES(?,?,?)").run(
      hash(session),
      userId,
      Date.now() + 60_000,
    );
    let writes = 0;
    let suspendWrites = 0;
    let remoteState = "SUSPENDED";
    const client = {
      createCampaigns: async () => {
        writes++;
        return { AddResults: [{ Id: 101 }] };
      },
      suspendCampaigns: async () => {
        suspendWrites++;
        remoteState = "SUSPENDED";
        return { SuspendResults: [{ Id: 101 }] };
      },
      createAdGroups: async () => ({ AddResults: [{ Id: 202 }] }),
      createKeywords: async () => ({
        AddResults: [{ Id: 301 }, { Id: 302 }],
      }),
      createAds: async () => ({ AddResults: [{ Id: 401 }] }),
      campaignsByIds: async () => ({
        Campaigns: [{ Id: 101, State: remoteState }],
      }),
      campaignBudgetById: async () => remoteBudget(change.plan),
      adGroupsByIds: async () => ({
        AdGroups: [{ Id: 202, CampaignId: 101 }],
      }),
      keywordsByIds: async () => ({
        Keywords: [
          { Id: 301, AdGroupId: 202 },
          { Id: 302, AdGroupId: 202 },
        ],
      }),
      adsByIds: async () => ({ Ads: [{ Id: 401, AdGroupId: 202 }] }),
    };
    const config = {
      production: true,
      origin: "http://localhost:4310",
      demo: false,
      sandbox: false,
      encryptionConfigured: true,
      directWritePilot: true,
    };
    server = createApp({
      db,
      config,
      key: encryptionKey,
      directFactory: () => client,
    }).listen(0, "127.0.0.1");
    await new Promise((resolve) => server.once("listening", resolve));
    const url = `http://127.0.0.1:${server.address().port}/api/businesses/${businessId}/direct/${change.id}`;
    const send = () =>
      fetch(url + "/execute", {
        method: "POST",
        headers: {
          Cookie: `ritm_session=${session}`,
          Origin: config.origin,
          "X-Ritm-Request": "1",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          planFingerprint: hash(JSON.stringify(change.plan)),
        }),
      });
    const first = await send();
    assert.equal(first.status, 200);
    assert.equal((await first.json()).status, "succeeded");
    const second = await send();
    assert.equal(second.status, 409);
    assert.equal(writes, 1);
    const saved = db
      .prepare(
        "SELECT status,calls_json FROM direct_executions WHERE change_id=?",
      )
      .get(change.id);
    assert.equal(saved.status, "succeeded");
    assert.equal(JSON.parse(saved.calls_json).length, 5);
    remoteState = "ON";
    const suspendKey = randomUUID();
    const suspend = () =>
      fetch(url + "/suspend", {
        method: "POST",
        headers: {
          Cookie: `ritm_session=${session}`,
          Origin: config.origin,
          "X-Ritm-Request": "1",
          "Content-Type": "application/json",
          "Idempotency-Key": suspendKey,
        },
        body: "{}",
      });
    const stopped = await suspend();
    assert.equal(stopped.status, 200);
    assert.equal((await stopped.json()).afterState, "SUSPENDED");
    const repeated = await suspend();
    assert.equal(repeated.status, 200);
    assert.equal(suspendWrites, 2); // one create-time stop, one later lifecycle stop
    const latest = db
      .prepare(
        "SELECT status,after_state FROM direct_lifecycle_actions WHERE change_id=?",
      )
      .get(change.id);
    assert.equal(latest.status, "succeeded");
    assert.equal(latest.after_state, "SUSPENDED");
    const budget = await fetch(url + "/budget-check", {
      method: "POST",
      headers: {
        Cookie: `ritm_session=${session}`,
        Origin: config.origin,
        "X-Ritm-Request": "1",
        "Content-Type": "application/json",
      },
      body: "{}",
    });
    assert.equal(budget.status, 200);
    const budgetResult = await budget.json();
    assert.equal(budgetResult.status, "matched");
    assert.equal(budgetResult.safeToResumeOrChangeLimit, false);
    const storedBudget = db
      .prepare(
        "SELECT COUNT(*) AS count FROM direct_budget_checks WHERE change_id=?",
      )
      .get(change.id);
    assert.equal(storedBudget.count, 1);
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    db.close();
  }
});

test("HTTP pilot rejects a reconnected Yandex account before any Direct write", async () => {
  const { db, userId, businessId, connectionId } = setup();
  const encryptionKey = randomBytes(32);
  let server;
  try {
    const change = await approvedPlan(db, userId, businessId, connectionId);
    db.prepare(
      "UPDATE connections SET encrypted=?,metadata=? WHERE business_id=? AND provider='yandex'",
    ).run(
      encrypt(
        {
          access_token: "replacement-access-token",
          refresh_token: "replacement-refresh-token",
          expires_at: Date.now() + 86_400_000,
        },
        encryptionKey,
        businessId + ":yandex",
      ),
      JSON.stringify({ connectionId: randomUUID() }),
      businessId,
    );
    const session = randomUUID();
    db.prepare("INSERT INTO sessions VALUES(?,?,?)").run(
      hash(session),
      userId,
      Date.now() + 60_000,
    );
    let writes = 0;
    const config = {
      production: true,
      origin: "http://localhost:4310",
      demo: false,
      sandbox: false,
      encryptionConfigured: true,
      directWritePilot: true,
    };
    server = createApp({
      db,
      config,
      key: encryptionKey,
      directFactory: () => ({
        createCampaigns: async () => {
          writes++;
          return { AddResults: [{ Id: 101 }] };
        },
      }),
    }).listen(0, "127.0.0.1");
    await new Promise((resolve) => server.once("listening", resolve));
    const response = await fetch(
      `http://127.0.0.1:${server.address().port}/api/businesses/${businessId}/direct/${change.id}/execute`,
      {
        method: "POST",
        headers: {
          Cookie: `ritm_session=${session}`,
          Origin: config.origin,
          "X-Ritm-Request": "1",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          planFingerprint: hash(JSON.stringify(change.plan)),
        }),
      },
    );
    assert.equal(response.status, 409);
    assert.equal((await response.json()).code, "stale_preflight");
    assert.equal(writes, 0);
    assert.equal(
      db.prepare("SELECT COUNT(*) AS n FROM direct_executions").get().n,
      0,
    );
    assert.equal(
      db
        .prepare("SELECT consumed_at FROM direct_approvals WHERE change_id=?")
        .get(change.id).consumed_at,
      null,
    );
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    db.close();
  }
});
