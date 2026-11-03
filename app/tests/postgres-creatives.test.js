import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { test } from "node:test";
import sharp from "sharp";
import { openDatabase } from "../server/db.js";
import {
  approvePostgresCreativeImage,
  enqueuePostgresCreativeImage,
  postgresCreativeImageFile,
  postgresCreativeImages,
  runPostgresCreativeCycle,
} from "../server/postgres-creatives.js";
import { encrypt, encryptionKey } from "../server/security.js";

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
      const value = await action(this);
      this.database.exec("COMMIT");
      return value;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }
}

const input = {
  prompt: "",
  style: "editorial",
  goal: "leads",
  hook: "outcome",
  format: "standard",
  audience: "",
  brandPlacement: "bottom-left",
  seed: 42,
};

test("PostgreSQL creative flow encrypts, queues, stores and serves an approved image", async () => {
  const sqlite = openDatabase(":memory:");
  const db = new AsyncSqlite(sqlite);
  const userId = randomUUID();
  const businessId = randomUUID();
  const key = encryptionKey(Buffer.alloc(32, 9).toString("base64"), false);
  const now = new Date().toISOString();
  sqlite
    .prepare("INSERT INTO users VALUES(?,?,?,?)")
    .run(userId, `google:${userId}`, "Tester", now);
  sqlite.prepare("INSERT INTO businesses VALUES(?,?,?,1)").run(
    businessId,
    userId,
    JSON.stringify({
      mode: "live",
      name: "Студия «Форма»",
      category: "Студия маникюра",
      service: "Маникюр с покрытием",
      city: "Екатеринбург",
      benefit: "Бережный уход и удобная запись",
    }),
  );
  const apiKey = "test-key-value-that-is-never-returned";
  sqlite
    .prepare("INSERT INTO connections VALUES(?,?,?,?)")
    .run(
      businessId,
      "kie-image",
      encrypt({ apiKey }, key, `${businessId}:kie-image`),
      JSON.stringify({ purpose: "image_generation" }),
    );

  const queued = await enqueuePostgresCreativeImage(
    db,
    userId,
    businessId,
    randomUUID(),
    input,
    { model: "gpt-image-2-5-flare-text-to-image", dailyLimit: 3 },
  );
  assert.equal(queued.status, "pending");
  assert.equal(JSON.stringify(queued).includes(apiKey), false);

  const source = await sharp({
    create: {
      width: 1024,
      height: 768,
      channels: 3,
      background: { r: 85, g: 122, b: 93 },
    },
  })
    .jpeg()
    .toBuffer();
  const result = await runPostgresCreativeCycle(db, {
    key,
    config: {
      kieImageModel: "gpt-image-2-5-flare-text-to-image",
    },
    waiter: async () => {},
    fetcher: async (url, options = {}) => {
      if (String(url).endsWith("/jobs/createTask")) {
        assert.match(options.headers.Authorization, /^Bearer test-key-/);
        return {
          ok: true,
          json: async () => ({ code: 200, data: { taskId: "task-test" } }),
        };
      }
      if (String(url).includes("/jobs/recordInfo")) {
        assert.match(options.headers.Authorization, /^Bearer test-key-/);
        return {
          ok: true,
          json: async () => ({
            code: 200,
            data: {
              state: "success",
              resultJson: JSON.stringify({
                resultUrls: ["https://result.kie.ai/generated.jpg"],
              }),
            },
          }),
        };
      }
      return {
        ok: true,
        headers: { get: () => String(source.length) },
        arrayBuffer: async () => source,
      };
    },
  });
  assert.equal(result.status, "succeeded");

  const listed = await postgresCreativeImages(db, businessId);
  assert.equal(listed.length, 1);
  assert.equal(listed[0].status, "succeeded");
  assert.equal(listed[0].imageUrl.includes(queued.id), true);
  assert.equal(JSON.stringify(listed).includes("db64:"), false);

  const file = await postgresCreativeImageFile(
    db,
    userId,
    businessId,
    queued.id,
  );
  assert.equal(file.mimeType, "image/jpeg");
  const metadata = await sharp(file.buffer).metadata();
  assert.equal(metadata.width, 1200);
  assert.equal(metadata.height, 900);
  assert.equal(metadata.format, "jpeg");

  const approved = await approvePostgresCreativeImage(
    db,
    userId,
    businessId,
    queued.id,
  );
  assert.equal(approved.ok, true);
  assert.ok(approved.approvedAt);
  sqlite.close();
});
