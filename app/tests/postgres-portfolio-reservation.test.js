import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { openDatabase } from "../server/db.js";
import { reservePostgresCampaignBudget } from "../server/postgres-direct.js";

class AsyncSqlite {
  constructor(database) {
    this.database = database;
  }

  prepare(sql) {
    const statement = this.database.prepare(
      sql.replace(/\s+FOR UPDATE(?: SKIP LOCKED)?/gi, ""),
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
      const result = await action(this);
      this.database.exec("COMMIT");
      return result;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }
}

function fixture(ownerLimitKopecks = 3_000_000) {
  const sqlite = openDatabase(":memory:");
  const db = new AsyncSqlite(sqlite);
  const userId = randomUUID();
  const businessId = randomUUID();
  const now = "2026-11-04T13:00:00.000Z";
  sqlite
    .prepare("INSERT INTO users VALUES(?,?,?,?)")
    .run(userId, `google:${userId}`, "Tester", now);
  sqlite.prepare("INSERT INTO businesses VALUES(?,?,?,1)").run(
    businessId,
    userId,
    JSON.stringify({
      mode: "live",
      name: "Форма",
      budget: ownerLimitKopecks,
    }),
  );
  return { sqlite, db, userId, businessId, now };
}

test("PostgreSQL campaign reservation keeps the portfolio inside the owner limit", async () => {
  const data = fixture();
  const searchId = randomUUID();
  const networkId = randomUUID();

  await data.db.transaction((tx) =>
    reservePostgresCampaignBudget(
      tx,
      data.userId,
      data.businessId,
      searchId,
      2_000_000,
      data.now,
    ),
  );
  data.sqlite
    .prepare("INSERT INTO campaign_ad_lifecycle VALUES(?,?,?,?,?)")
    .run(
      data.businessId,
      searchId,
      "paused",
      "Кампания создана выключенной.",
      data.now,
    );
  await assert.rejects(
    data.db.transaction((tx) =>
      reservePostgresCampaignBudget(
        tx,
        data.userId,
        data.businessId,
        networkId,
        1_100_000,
        data.now,
      ),
    ),
    (error) => error.code === "portfolio_budget_exceeded",
  );
  const rows = data.sqlite
    .prepare(
      "SELECT change_id,limit_kopecks FROM campaign_budget_allocations ORDER BY change_id",
    )
    .all()
    .map((row) => ({ ...row }));
  assert.deepEqual(rows, [{ change_id: searchId, limit_kopecks: 2_000_000 }]);
});

test("retrying the same campaign replaces its own reservation without double counting", async () => {
  const data = fixture();
  const changeId = randomUUID();
  await data.db.transaction((tx) =>
    reservePostgresCampaignBudget(
      tx,
      data.userId,
      data.businessId,
      changeId,
      1_000_000,
      data.now,
    ),
  );
  const result = await data.db.transaction((tx) =>
    reservePostgresCampaignBudget(
      tx,
      data.userId,
      data.businessId,
      changeId,
      1_500_000,
      data.now,
    ),
  );
  assert.equal(result.reservedKopecks, 0);
  assert.equal(result.availableKopecks, 1_500_000);
  assert.equal(
    data.sqlite
      .prepare(
        "SELECT limit_kopecks FROM campaign_budget_allocations WHERE change_id=?",
      )
      .get(changeId).limit_kopecks,
    1_500_000,
  );
});

test("production reservation locks the business before reading allocations", async () => {
  const queries = [];
  const tx = {
    prepare(sql) {
      queries.push(sql);
      if (sql.includes("FROM businesses"))
        return {
          get: async () => ({
            id: "business",
            state: JSON.stringify({ budget: 3_000_000 }),
          }),
        };
      if (sql.includes("SELECT cba.change_id")) return { all: async () => [] };
      return { run: async () => ({ changes: 1 }) };
    },
  };
  await reservePostgresCampaignBudget(
    tx,
    "user",
    "business",
    "change",
    1_000_000,
  );
  assert.match(queries[0], /businesses[\s\S]+FOR UPDATE/i);
  assert.match(queries[1], /campaign_budget_allocations[\s\S]+FOR UPDATE/i);
});
