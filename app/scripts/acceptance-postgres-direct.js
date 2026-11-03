import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { PostgresDatabase } from "../server/postgres-async.js";
import {
  confirmPostgresDirectPlan,
  executePostgresDirectPlan,
  postgresDirectChanges,
  preflightPostgresDirectPlan,
  preparePostgresDirectPlan,
} from "../server/postgres-direct.js";

if (process.env.DATABASE_SMOKE_TEST !== "true")
  throw new Error("Укажите DATABASE_SMOKE_TEST=true для изолированной ветки.");
if (!/^postgres(?:ql)?:\/\//i.test(process.env.DATABASE_URL || ""))
  throw new Error("Для проверки PostgreSQL задайте DATABASE_URL.");

const db = await PostgresDatabase.connect(process.env.DATABASE_URL, {
  ssl: process.env.POSTGRES_SSL !== "false",
});
const userId = randomUUID();
const businessId = randomUUID();
const connectionId = randomUUID();
const tomorrow = new Date(Date.now() + 86_400_000);
const end = new Date(Date.now() + 14 * 86_400_000);
const date = (value) => value.toISOString().slice(0, 10);
const state = {
  mode: "live",
  name: "Форма",
  category: "студия маникюра",
  city: "Екатеринбург",
  website: "https://example.test/record",
  landingMode: "external",
  service: "маникюр с покрытием",
  benefit: "бережный уход и удобная запись",
  budget: 3_000_000,
  targetCpa: 150_000,
  counterId: "12345",
  goalId: "67890",
  creatives: [
    {
      id: "approved-text",
      title: "Маникюр с покрытием рядом",
      text: "Бережный уход и удобная запись в студию «Форма».",
      status: "approved",
    },
  ],
  postgresPilot: { planConfirmedAt: new Date().toISOString() },
};
const plan = {
  login: "ritm-test",
  campaignName: `Ritm acceptance ${randomUUID()}`,
  website: state.website,
  audience: "Ищут маникюр с покрытием рядом",
  regionIds: [54],
  budget: state.budget,
  targetCpa: state.targetCpa,
  periodStart: date(tomorrow),
  periodEnd: date(end),
  counterId: state.counterId,
  goalId: state.goalId,
  ads: [
    {
      title: state.creatives[0].title,
      text: state.creatives[0].text,
      href: state.website,
    },
  ],
  keywords: ["маникюр с покрытием екатеринбург", "маникюр рядом"],
  negativeKeywords: ["обучение", "вакансия"],
};

const fake = {
  campaigns: async () => ({ Campaigns: [] }),
  createCampaigns: async () => ({ AddResults: [{ Id: 101 }] }),
  campaignsByIds: async () => ({
    Campaigns: [
      {
        Id: 101,
        Name: plan.campaignName,
        State: "OFF",
        Status: "DRAFT",
        Type: "TEXT_CAMPAIGN",
      },
    ],
  }),
  suspendCampaigns: async () => ({ SuspendResults: [{ Id: 101 }] }),
  createAdGroups: async () => ({ AddResults: [{ Id: 201 }] }),
  createKeywords: async (items) => ({
    AddResults: items.map((_, index) => ({ Id: 301 + index })),
  }),
  createAds: async (items) => ({
    AddResults: items.map((_, index) => ({ Id: 401 + index })),
  }),
  adGroupsByIds: async () => ({
    AdGroups: [{ Id: 201, CampaignId: 101 }],
  }),
  keywordsByIds: async (ids) => ({
    Keywords: ids.map((id) => ({ Id: id, AdGroupId: 201 })),
  }),
  adsByIds: async (ids) => ({
    Ads: ids.map((id) => ({ Id: id, AdGroupId: 201 })),
  }),
};

let changeId = null;
try {
  await db
    .prepare("INSERT INTO users VALUES(?,?,?,?)")
    .run(
      userId,
      `acceptance:${userId}`,
      "Acceptance",
      new Date().toISOString(),
    );
  await db
    .prepare("INSERT INTO businesses(id,user_id,state,version) VALUES(?,?,?,1)")
    .run(businessId, userId, JSON.stringify(state));
  await db.prepare("INSERT INTO connections VALUES(?,?,?,?)").run(
    businessId,
    "yandex",
    "acceptance-only",
    JSON.stringify({
      connectionId,
      validation: "verified",
      clients: [{ Login: plan.login, ClientId: 1, Currency: "RUB" }],
    }),
  );

  const prepared = await preparePostgresDirectPlan(
    db,
    userId,
    businessId,
    randomUUID(),
    plan,
  );
  changeId = prepared.id;
  assert.equal(prepared.status, "succeeded");
  assert.equal(prepared.reconciliation.status, "prepared");

  const checked = await preflightPostgresDirectPlan(
    db,
    userId,
    businessId,
    changeId,
    randomUUID(),
    {
      clientForLogin: fake,
      clients: [{ Login: plan.login, ClientId: 1, Currency: "RUB" }],
      connectionId,
    },
  );
  assert.equal(checked.ready, true);

  const approval = await confirmPostgresDirectPlan(
    db,
    userId,
    businessId,
    changeId,
    checked.planFingerprint,
  );
  assert.equal(approval.status, "confirmed");

  const execution = await executePostgresDirectPlan(
    db,
    userId,
    businessId,
    changeId,
    checked.planFingerprint,
    fake,
  );
  assert.equal(execution.status, "succeeded");
  assert.equal(execution.calls.length, 5);
  assert.equal(execution.reconciliation.matched, true);
  await assert.rejects(
    () =>
      executePostgresDirectPlan(
        db,
        userId,
        businessId,
        changeId,
        checked.planFingerprint,
        fake,
      ),
    (error) => error?.code === "direct_execution_exists",
  );

  const visible = await postgresDirectChanges(db, userId, businessId);
  assert.equal(visible[0].execution.status, "succeeded");
  assert.equal(visible[0].approval, null);
  console.log(
    JSON.stringify({
      ok: true,
      scenario: "postgres-disabled-direct-campaign",
      externalNetworkWrites: 0,
    }),
  );
} finally {
  await db.transaction(async (tx) => {
    if (changeId) {
      await tx
        .prepare("DELETE FROM direct_executions WHERE change_id=?")
        .run(changeId);
      await tx
        .prepare("DELETE FROM direct_approvals WHERE change_id=?")
        .run(changeId);
      await tx
        .prepare("DELETE FROM direct_preflights WHERE change_id=?")
        .run(changeId);
      await tx
        .prepare("DELETE FROM campaign_ad_lifecycle WHERE change_id=?")
        .run(changeId);
      await tx.prepare("DELETE FROM direct_changes WHERE id=?").run(changeId);
      await tx.prepare("DELETE FROM jobs WHERE id=?").run(changeId);
    }
    await tx
      .prepare("DELETE FROM connections WHERE business_id=?")
      .run(businessId);
    await tx.prepare("DELETE FROM events WHERE business_id=?").run(businessId);
    await tx.prepare("DELETE FROM businesses WHERE id=?").run(businessId);
    await tx.prepare("DELETE FROM users WHERE id=?").run(userId);
  });
  await db.close();
}
