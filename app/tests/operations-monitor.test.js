import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { openDatabase } from "../server/db.js";
import {
  operationalAlertPayload,
  sendOperationalAlert,
  startOperationsMonitor,
  validateOperationsWebhook,
} from "../server/operations-monitor.js";
import { operationalSnapshot } from "../server/operations.js";

test("operations alert contains only the public aggregate snapshot", async () => {
  const db = openDatabase(":memory:"),
    businessId = randomUUID(),
    now = Date.UTC(2026, 9, 30, 12),
    calls = [];
  try {
    db.prepare(
      "INSERT INTO users(id,subject,name,created_at) VALUES('u','ops:alert','Private name',?)",
    ).run(new Date(now).toISOString());
    db.prepare(
      "INSERT INTO businesses(id,user_id,state,version) VALUES(?,'u',?,1)",
    ).run(businessId, JSON.stringify({ secret: "never-send" }));
    db.prepare(
      "INSERT INTO jobs(id,business_id,kind,status,available_at,attempts,payload,error) VALUES(?,?,?,?,?,0,?,?)",
    ).run(
      randomUUID(),
      businessId,
      "creative_generation",
      "running",
      now - 1,
      JSON.stringify({ token: "never-send" }),
      "private upstream error",
    );
    const snapshot = operationalSnapshot(db, now);
    await sendOperationalAlert("https://monitor.example/hooks/secret", snapshot, {
      bearerToken: "transport-secret",
      now,
      fetcher: async (url, options) => {
        calls.push({ url, options });
        return { ok: true };
      },
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].options.headers.Authorization, "Bearer transport-secret");
    const body = JSON.parse(calls[0].options.body);
    assert.deepEqual(body, operationalAlertPayload(snapshot, now));
    assert.equal(body.status, "degraded");
    assert.doesNotMatch(calls[0].options.body, /Private name|never-send|upstream/);
  } finally {
    db.close();
  }
});

test("operations monitor is quiet while healthy and reports degradation and recovery", async () => {
  const db = openDatabase(":memory:"),
    calls = [],
    now = Date.UTC(2026, 9, 30, 12),
    stop = startOperationsMonitor(db, {
      webhookUrl: "https://monitor.example/hooks/test",
      intervalMs: 30_000,
      now: () => now,
      fetcher: async (_url, options) => {
        calls.push(JSON.parse(options.body));
        return { ok: true };
      },
    });
  try {
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls.length, 0);
    const businessId = randomUUID();
    db.prepare(
      "INSERT INTO users(id,subject,name,created_at) VALUES('u','ops:monitor','Ops',?)",
    ).run(new Date(now).toISOString());
    db.prepare(
      "INSERT INTO businesses(id,user_id,state,version) VALUES(?,'u','{}',1)",
    ).run(businessId);
    db.prepare(
      "INSERT INTO jobs(id,business_id,kind,status,available_at,attempts,payload) VALUES(?,?,?,?,?,0,'{}')",
    ).run(randomUUID(), businessId, "report_sync", "running", now - 1);

    await stop.checkNow();
    await stop.checkNow();
    assert.equal(calls.length, 1, "unchanged degradation is not repeated");
    db.prepare("DELETE FROM jobs").run();
    await stop.checkNow();
    assert.deepEqual(
      calls.map((call) => call.status),
      ["degraded", "healthy"],
    );
  } finally {
    await stop();
    db.close();
  }
});

test("operations webhook rejects plaintext transport", () => {
  assert.throws(
    () => validateOperationsWebhook("http://monitor.example/hook"),
    /must use HTTPS/,
  );
  assert.equal(validateOperationsWebhook(""), null);
});
