import { randomUUID } from "node:crypto";
import { test } from "node:test";
import assert from "node:assert/strict";
import { openDatabase } from "../server/db.js";
import {
  audienceExperiments,
  createAudienceExperiment,
  recordAudienceObservation,
} from "../server/audience-experiments.js";

const now = Date.parse("2026-11-01T09:00:00Z");

function fixture() {
  const db = openDatabase(":memory:"),
    userId = randomUUID(),
    businessId = randomUUID(),
    changeId = randomUUID();
  db.prepare("INSERT INTO users VALUES(?,?,?,?)").run(
    userId,
    `google:${userId}`,
    "Tester",
    new Date(now).toISOString(),
  );
  db.prepare("INSERT INTO businesses VALUES(?,?,?,1)").run(
    businessId,
    userId,
    JSON.stringify({ mode: "live" }),
  );
  db.prepare(
    "INSERT INTO jobs(id,business_id,kind,status,available_at,payload) VALUES(?,?,?,'succeeded',?,?)",
  ).run(changeId, businessId, "direct_dry_run", now, "{}");
  const plan = {
    login: "test-client",
    campaignName: "Тест аудитории",
    periodStart: "2026-11-02",
    periodEnd: "2026-11-15",
    audience: "Жители Екатеринбурга",
    ads: [
      {
        title: "Студия рядом",
        text: "Удобная запись на услугу",
        href: "https://example.test/",
      },
    ],
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
    randomUUID(),
    "fingerprint",
    "succeeded",
    null,
    1,
    JSON.stringify([{ key: "campaign", ids: [123] }]),
    new Date(now).toISOString(),
    new Date(now).toISOString(),
  );
  return { db, userId, businessId, changeId };
}

const input = {
  hypothesis:
    "Люди в радиусе трёх километров чаще записываются, чем люди в широком радиусе.",
  dimension: "geo_radius",
  control: { name: "Широкий радиус", value: "10 км" },
  variant: { name: "Рядом со студией", value: "3 км" },
  minDays: 7,
  minClicksPerVariant: 100,
  minGoalsPerVariant: 5,
  probabilityThreshold: 0.95,
  minimumRelativeLift: 0.15,
};

test("audience experiment fixes one dimension and is idempotent", () => {
  const { db, userId, businessId, changeId } = fixture(),
    key = randomUUID();
  const first = createAudienceExperiment(
    db,
    userId,
    businessId,
    changeId,
    key,
    input,
    { now },
  );
  const second = createAudienceExperiment(
    db,
    userId,
    businessId,
    changeId,
    key,
    input,
    { now },
  );
  assert.equal(second.id, first.id);
  assert.equal(first.dimension, "geo_radius");
  assert.equal(first.allocation, "50/50");
  assert.equal(first.criteria.noEarlyWinner, true);
  assert.equal(audienceExperiments(db, userId, businessId).length, 1);
  db.close();
});

test("audience experiment never selects an early winner", () => {
  const { db, userId, businessId, changeId } = fixture();
  const experiment = createAudienceExperiment(
    db,
    userId,
    businessId,
    changeId,
    randomUUID(),
    input,
    { now },
  );
  const observed = recordAudienceObservation(db, businessId, experiment.id, {
    snapshotKey: "early",
    periodFrom: "2026-11-02",
    periodTo: "2026-11-08",
    control: { clicks: 500, goals: 20 },
    variant: { clicks: 500, goals: 80 },
    source: { directReportId: "direct-1", metricaSnapshotId: "metrica-1" },
  });
  assert.equal(observed.status, "collecting");
  assert.match(observed.conclusion, /ранний выбор/i);
  db.close();
});

test("audience experiment identifies a mature practical winner", () => {
  const { db, userId, businessId, changeId } = fixture();
  const experiment = createAudienceExperiment(
    db,
    userId,
    businessId,
    changeId,
    randomUUID(),
    input,
    { now },
  );
  const observed = recordAudienceObservation(db, businessId, experiment.id, {
    snapshotKey: "final",
    periodFrom: "2026-11-02",
    periodTo: "2026-11-15",
    control: { clicks: 500, goals: 30 },
    variant: { clicks: 500, goals: 65 },
    source: { directReportId: "direct-2", metricaSnapshotId: "metrica-2" },
  });
  assert.equal(observed.status, "variant_wins");
  assert.ok(observed.evidence.probabilityVariantBetter >= 0.95);
  assert.ok(observed.evidence.relativeLift >= 0.15);
  assert.equal(observed.appliedAction, "none");
  db.close();
});

test("audience experiment remains inconclusive with unbalanced traffic", () => {
  const { db, userId, businessId, changeId } = fixture();
  const experiment = createAudienceExperiment(
    db,
    userId,
    businessId,
    changeId,
    randomUUID(),
    input,
    { now },
  );
  const observed = recordAudienceObservation(db, businessId, experiment.id, {
    snapshotKey: "unbalanced",
    periodFrom: "2026-11-02",
    periodTo: "2026-11-15",
    control: { clicks: 900, goals: 45 },
    variant: { clicks: 100, goals: 20 },
    source: { directReportId: "direct-3", metricaSnapshotId: "metrica-3" },
  });
  assert.equal(observed.status, "inconclusive");
  assert.equal(observed.evidence.allocationBalanced, false);
  db.close();
});

test("audience experiment rejects identical segments", () => {
  const { db, userId, businessId, changeId } = fixture();
  assert.throws(
    () =>
      createAudienceExperiment(
        db,
        userId,
        businessId,
        changeId,
        randomUUID(),
        { ...input, variant: { name: "То же", value: "10 км" } },
      ),
    /различаться/,
  );
  db.close();
});
