import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { openDatabase, SCHEMA_VERSION } from "../server/db.js";
import {
  operationalExitCode,
  operationalSnapshot,
} from "../server/operations.js";

test("readiness reports only aggregate queue health and stale leases", () => {
  const db = openDatabase(":memory:"),
    businessId = randomUUID(),
    now = Date.now();
  try {
    db.prepare(
      "INSERT INTO users(id,subject,name,created_at) VALUES('u','ops:test','Ops',?)",
    ).run(new Date(now).toISOString());
    db.prepare(
      "INSERT INTO businesses(id,user_id,state,version) VALUES(?,'u','{}',1)",
    ).run(businessId);
    const insert = db.prepare(
      "INSERT INTO jobs(id,business_id,kind,status,available_at,attempts,payload) VALUES(?,?,?,?,?,0,'{}')",
    );
    insert.run(randomUUID(), businessId, "shadow_analysis", "pending", now - 1);
    insert.run(randomUUID(), businessId, "report_sync", "pending", now + 60000);
    insert.run(randomUUID(), businessId, "direct_change", "running", now - 1);
    insert.run(randomUUID(), businessId, "creative_generation", "failed", now);

    const snapshot = operationalSnapshot(db, now);
    assert.deepEqual(snapshot, {
      ok: true,
      ready: true,
      degraded: true,
      database: {
        schemaVersion: SCHEMA_VERSION,
        expectedSchemaVersion: SCHEMA_VERSION,
      },
      queues: { pending: 2, ready: 1, running: 1, stale: 1, failed: 1 },
      reconciliation: { required: 0 },
    });
    assert.equal(operationalExitCode(snapshot), 2);
  } finally {
    db.close();
  }
});

test("readiness rejects an unexpected schema without exposing records", () => {
  const db = openDatabase(":memory:");
  try {
    db.prepare("INSERT INTO schema_version(version) VALUES(?)").run(
      SCHEMA_VERSION + 1,
    );
    const snapshot = operationalSnapshot(db);
    assert.equal(snapshot.ready, false);
    assert.equal(snapshot.ok, false);
    assert.equal(operationalExitCode(snapshot), 1);
    assert.deepEqual(Object.keys(snapshot), [
      "ok",
      "ready",
      "degraded",
      "database",
      "queues",
      "reconciliation",
    ]);
  } finally {
    db.close();
  }
});

test("healthy operations return a successful monitor exit code", () => {
  const db = openDatabase(":memory:");
  try {
    assert.equal(operationalExitCode(operationalSnapshot(db)), 0);
  } finally {
    db.close();
  }
});
