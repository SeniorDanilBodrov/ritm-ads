import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, unlinkSync, rmdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, events } from "../server/db.js";
import { seedDemo } from "../server/engine.js";
import { runShadowCycle } from "../server/worker.js";
const report = {
  provider: "rules",
  version: "test/1",
  executed: false,
  proposals: [],
};
const analyst = async () => structuredClone(report);

test("worker rejects a report claiming actions were executed", async () => {
  const db = openDatabase(":memory:");
  try {
    fixture(db);
    const r = await runShadowCycle(db, {
      analyst: async () => ({ ...report, executed: true }),
    });
    assert.equal(r.status, "pending");
    assert.equal(state(db).analysis, undefined);
  } finally {
    db.close();
  }
});
function fixture(db) {
  const s = seedDemo();
  s.shadowAnalysis = true;
  db.prepare("INSERT INTO users VALUES(?,?,?,?)").run(
    "user",
    "demo:user",
    "Test",
    "2026-10-24",
  );
  db.prepare("INSERT INTO businesses VALUES(?,?,?,?)").run(
    "business",
    "user",
    JSON.stringify(s),
    1,
  );
  return s;
}
function state(db) {
  return JSON.parse(db.prepare("SELECT state FROM businesses").get().state);
}
function mutate(db, fn) {
  const s = state(db);
  fn(s);
  db.prepare("UPDATE businesses SET state=?,version=version+1").run(
    JSON.stringify(s),
  );
}
test("scheduled analysis commits report and job atomically without changing money", async () => {
  const db = openDatabase(":memory:");
  try {
    const initial = fixture(db);
    assert.equal(
      (await runShadowCycle(db, { now: 100000, analyst })).status,
      "succeeded",
    );
    const s = state(db);
    assert.deepEqual(s.campaigns, initial.campaigns);
    assert.equal(s.budget, initial.budget);
    assert.equal(s.sequence, initial.sequence);
    assert.equal(s.analysis.source, "scheduled");
    assert.equal(s.analysis.stateVersion, 2);
    assert.equal(
      db.prepare("SELECT status FROM jobs").get().status,
      "succeeded",
    );
    assert.equal(events(db, "business").length, 1);
    assert.equal(
      (await runShadowCycle(db, { now: 10000000, analyst })).status,
      "idle",
    );
    assert.equal(events(db, "business").length, 1);
  } finally {
    db.close();
  }
});
test("changed snapshots are checked no more than once an hour after success", async () => {
  const db = openDatabase(":memory:");
  try {
    fixture(db);
    await runShadowCycle(db, { now: 100000, analyst });
    mutate(db, (s) => (s.targetCpa += 100));
    assert.equal(
      (await runShadowCycle(db, { now: 100001, analyst })).status,
      "idle",
    );
    assert.equal(
      (await runShadowCycle(db, { now: 3700000, analyst })).status,
      "succeeded",
    );
  } finally {
    db.close();
  }
});
test("disabled schedules do not enqueue work", async () => {
  const db = openDatabase(":memory:");
  try {
    fixture(db);
    mutate(db, (s) => (s.shadowAnalysis = false));
    assert.equal((await runShadowCycle(db, { analyst })).status, "idle");
    assert.equal(db.prepare("SELECT count(*) AS n FROM jobs").get().n, 0);
  } finally {
    db.close();
  }
});
test("failure retries with backoff, stops after three and hides provider errors", async () => {
  const db = openDatabase(":memory:");
  try {
    const initial = fixture(db),
      broken = async () => {
        throw new Error("SECRET_TOKEN");
      };
    assert.equal(
      (await runShadowCycle(db, { now: 100000, analyst: broken })).status,
      "pending",
    );
    assert.equal(
      (await runShadowCycle(db, { now: 100001, analyst: broken })).status,
      "idle",
    );
    assert.equal(
      (await runShadowCycle(db, { now: 115000, analyst: broken })).status,
      "pending",
    );
    assert.equal(
      (await runShadowCycle(db, { now: 145000, analyst: broken })).status,
      "failed",
    );
    assert.equal(
      (await runShadowCycle(db, { now: 9000000, analyst: broken })).status,
      "idle",
    );
    const job = db.prepare("SELECT * FROM jobs").get();
    assert.equal(job.attempts, 3);
    assert.ok(!JSON.stringify(job).includes("SECRET_TOKEN"));
    assert.deepEqual(state(db), initial);
    assert.equal(events(db, "business").length, 1);
  } finally {
    db.close();
  }
});
test("changes while analysis runs cancel its result", async () => {
  const db = openDatabase(":memory:");
  try {
    fixture(db);
    const r = await runShadowCycle(db, {
      analyst: async () => {
        mutate(db, (s) => (s.targetCpa = 46000));
        return report;
      },
    });
    assert.equal(r.status, "cancelled");
    assert.equal(state(db).analysis, undefined);
    assert.equal(state(db).targetCpa, 46000);
    assert.equal(events(db, "business").length, 0);
  } finally {
    db.close();
  }
});
test("disabling schedule during analysis prevents saving its result", async () => {
  const db = openDatabase(":memory:");
  try {
    fixture(db);
    const r = await runShadowCycle(db, {
      analyst: async () => {
        mutate(db, (s) => (s.shadowAnalysis = false));
        return report;
      },
    });
    assert.equal(r.status, "cancelled");
    assert.equal(state(db).analysis, undefined);
  } finally {
    db.close();
  }
});
test("concurrent cycles claim one job and fence expired workers", async () => {
  const db = openDatabase(":memory:");
  try {
    fixture(db);
    let release, started;
    const ready = new Promise((r) => (started = r));
    const first = runShadowCycle(db, {
      now: 100000,
      analyst: () => {
        started();
        return new Promise((r) => (release = r));
      },
    });
    await ready;
    assert.equal(
      (await runShadowCycle(db, { now: 100001, analyst })).status,
      "idle",
    );
    assert.equal(
      (await runShadowCycle(db, { now: 160000, analyst })).status,
      "succeeded",
    );
    release(report);
    assert.equal((await first).status, "lease_lost");
    assert.equal(events(db, "business").length, 1);
    assert.equal(db.prepare("SELECT attempts FROM jobs").get().attempts, 2);
  } finally {
    db.close();
  }
});
test("pending retry survives closing and reopening SQLite", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ritm-worker-test-")),
    file = join(dir, "test.sqlite");
  let db;
  try {
    db = openDatabase(file);
    fixture(db);
    await runShadowCycle(db, {
      now: 100000,
      analyst: async () => {
        throw new Error();
      },
    });
    db.close();
    db = openDatabase(file);
    assert.equal(
      (await runShadowCycle(db, { now: 115000, analyst })).status,
      "succeeded",
    );
    assert.equal(state(db).analysis.source, "scheduled");
  } finally {
    db?.close();
    for (const suffix of ["", "-wal", "-shm"])
      if (existsSync(file + suffix)) unlinkSync(file + suffix);
    rmdirSync(dir);
  }
});
