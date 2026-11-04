import assert from "node:assert/strict";
import test from "node:test";
import { openDatabase } from "../server/db.js";
import {
  acceptanceRunsSync,
  acceptanceRunsPostgres,
  enqueueAcceptanceRunPostgres,
  enqueueAcceptanceRunSync,
  runAcceptanceCycle,
} from "../server/acceptance-jobs.js";

class AsyncSqlite {
  constructor(database) {
    this.database = database;
    this.isAsync = true;
  }

  prepare(sql) {
    const statement = this.database.prepare(
      sql
        .replace(/\bctid\b/gi, "rowid")
        .replace(/\s+FOR UPDATE(?: SKIP LOCKED)?/gi, ""),
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
  const state = {
    mode: "live",
    name: "Форма",
    category: "Студия маникюра",
    city: "Екатеринбург",
    website: "https://forma.example/",
    service: "Маникюр с покрытием",
    benefit: "Бережный уход и удобная запись",
    price: 1900,
    budget: 3_000_000,
    targetCpa: 45_000,
    reservePercent: 10,
    timezone: "Asia/Yekaterinburg",
    periodStart: "2026-11-01",
    periodEnd: "2026-11-30",
    running: false,
    clientsTracked: false,
    counterId: "",
    goalId: "",
    campaigns: [],
    experiments: [],
    creatives: [],
    daily: [],
  };
  return {
    business: { id: "business-1", state },
    plan: {
      name: "Форма · Поиск",
      budget: state.budget,
      ads: [
        {
          title: "Маникюр с покрытием",
          text: "Бережный уход и удобная запись",
        },
      ],
    },
  };
}

function database() {
  const db = openDatabase(":memory:");
  db.prepare("INSERT INTO users VALUES(?,?,?,?)").run(
    "user-1",
    "test:user-1",
    "Тест",
    new Date(0).toISOString(),
  );
  const { business } = fixture();
  db.prepare("INSERT INTO businesses VALUES(?,?,?,1)").run(
    business.id,
    "user-1",
    JSON.stringify(business.state),
  );
  return db;
}

test("acceptance job is durable, isolated and idempotent while active", async () => {
  const db = database();
  try {
    const { business, plan } = fixture();
    const before = db
      .prepare("SELECT state,version FROM businesses WHERE id=?")
      .get(business.id);
    const first = enqueueAcceptanceRunSync(db, business, plan, 1_000);
    const repeated = enqueueAcceptanceRunSync(db, business, plan, 1_001);
    assert.equal(repeated.id, first.id);
    assert.equal(acceptanceRunsSync(db, business.id)[0].status, "pending");

    const result = await runAcceptanceCycle(db, { now: 1_000 });
    assert.equal(result.status, "succeeded");
    const stored = acceptanceRunsSync(db, business.id)[0];
    assert.equal(stored.status, "succeeded");
    assert.equal(stored.report.checks.length, 9);
    assert.equal(stored.report.externalWrites, 0);
    assert.equal(stored.report.providerCalls, 0);
    assert.deepEqual(
      db
        .prepare("SELECT state,version FROM businesses WHERE id=?")
        .get(business.id),
      before,
    );
  } finally {
    db.close();
  }
});

test("expired acceptance lease is resumed after a process restart", async () => {
  const db = database();
  try {
    const { business, plan } = fixture();
    const run = enqueueAcceptanceRunSync(db, business, plan, 1_000);
    db.prepare(
      "UPDATE jobs SET status='running',attempts=1,available_at=? WHERE id=?",
    ).run(2_000, run.id);

    const beforeExpiry = await runAcceptanceCycle(db, { now: 1_999 });
    assert.equal(beforeExpiry.status, "idle");
    const resumed = await runAcceptanceCycle(db, { now: 2_000 });
    assert.equal(resumed.status, "succeeded");
    const stored = acceptanceRunsSync(db, business.id)[0];
    assert.equal(stored.status, "succeeded");
    assert.equal(stored.attempts, 2);
  } finally {
    db.close();
  }
});

test("PostgreSQL acceptance queue follows the same durable contract", async () => {
  const sqlite = database();
  const db = new AsyncSqlite(sqlite);
  try {
    const { business, plan } = fixture();
    const before = sqlite
      .prepare("SELECT state,version FROM businesses WHERE id=?")
      .get(business.id);
    const queued = await db.transaction((tx) =>
      enqueueAcceptanceRunPostgres(tx, business, plan, 3_000),
    );
    assert.equal(queued.status, "pending");
    assert.equal(queued.availableAt, 3_000);

    const result = await runAcceptanceCycle(db, { now: 3_000 });
    assert.equal(result.status, "succeeded");
    const stored = (await acceptanceRunsPostgres(db, business.id))[0];
    assert.equal(stored.status, "succeeded");
    assert.equal(stored.report.checks.length, 9);
    assert.equal(stored.report.externalWrites, 0);
    assert.deepEqual(
      sqlite
        .prepare("SELECT state,version FROM businesses WHERE id=?")
        .get(business.id),
      before,
    );
  } finally {
    sqlite.close();
  }
});
