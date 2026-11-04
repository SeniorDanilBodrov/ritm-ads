import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import { buildDirectCommands } from "../server/direct.js";
import { openDatabase } from "../server/db.js";
import {
  approvedDirectImageHash,
  inspectPostgresDirectImageUpload,
  uploadApprovedPostgresCreativeToDirect,
} from "../server/postgres-direct-images.js";
import { attachPostgresDirectImageHashes } from "../server/postgres-direct.js";

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

function fixture() {
  const sqlite = openDatabase(":memory:");
  const db = new AsyncSqlite(sqlite);
  const userId = randomUUID();
  const businessId = randomUUID();
  const assetId = randomUUID();
  const connectionId = randomUUID();
  const buffer = Buffer.from("verified-kie-image");
  const sha256 = createHash("sha256").update(buffer).digest("hex");
  const now = new Date().toISOString();
  sqlite
    .prepare("INSERT INTO users VALUES(?,?,?,?)")
    .run(userId, `google:${userId}`, "Tester", now);
  sqlite
    .prepare("INSERT INTO businesses VALUES(?,?,?,1)")
    .run(businessId, userId, JSON.stringify({ mode: "live" }));
  sqlite
    .prepare(
      "INSERT INTO jobs(id,business_id,kind,status,available_at,attempts,payload) VALUES(?,?,'creative_generation','succeeded',0,1,'{}')",
    )
    .run(assetId, businessId);
  sqlite
    .prepare(
      `INSERT INTO creative_assets(
        id,business_id,idempotency_key,provider,model,prompt,style,seed,
        mime_type,storage_name,byte_size,sha256,metadata_json,approved_at,
        created_at,updated_at,brief,goal,format,audience,brand_placement,company_name,hook)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      assetId,
      businessId,
      randomUUID(),
      "kie",
      "gpt-image-2-5-flare-text-to-image",
      "prompt",
      "editorial",
      42,
      "image/jpeg",
      `db64:${buffer.toString("base64")}`,
      buffer.length,
      sha256,
      JSON.stringify({ yandexDirectReady: true }),
      now,
      now,
      now,
      "",
      "leads",
      "standard",
      "",
      "none",
      "",
      "outcome",
    );
  return { sqlite, db, userId, businessId, assetId, connectionId, buffer };
}

test("approved Kie image is uploaded once, read back and attached to a Direct plan", async () => {
  const f = fixture();
  const requestKey = randomUUID();
  let writes = 0;
  let expectedName;
  const client = {
    createAdImages: async ([image]) => {
      writes += 1;
      expectedName = image.Name;
      assert.equal(image.Type, "AUTO");
      assert.deepEqual(Buffer.from(image.ImageData, "base64"), f.buffer);
      return { AddResults: [{ AdImageHash: "hash_approved_1" }] };
    },
    adImagesByHashes: async (hashes) => ({
      AdImages: [
        {
          AdImageHash: hashes[0],
          Name: expectedName,
          Type: "REGULAR",
          Associated: "YES",
        },
      ],
    }),
  };
  const uploaded = await uploadApprovedPostgresCreativeToDirect(
    f.db,
    f.userId,
    f.businessId,
    f.assetId,
    requestKey,
    client,
    f.connectionId,
    {
      enabled: true,
      uploadConfirmed: true,
      login: "owner-login",
    },
  );
  assert.equal(uploaded.status, "succeeded");
  assert.equal(uploaded.adImageHash, "hash_approved_1");
  assert.equal(writes, 1);

  const hash = await approvedDirectImageHash(
    f.db,
    f.userId,
    f.businessId,
    f.assetId,
    f.connectionId,
    "owner-login",
  );
  assert.equal(hash, "hash_approved_1");
  const built = buildDirectCommands({
    login: "owner-login",
    campaignName: "Форма · Поиск",
    website: "https://example.test",
    audience: "Маникюр рядом",
    regionIds: [54],
    budget: 30_000_00,
    targetCpa: 450_00,
    periodStart: "2026-11-05",
    periodEnd: "2026-11-20",
    creativeAssetId: f.assetId,
    ads: [
      {
        title: "Маникюр рядом",
        text: "Запишитесь на удобное время",
        href: "https://example.test",
        adImageHash: hash,
      },
    ],
    keywords: ["маникюр рядом"],
  });
  assert.equal(
    built.commands.find((item) => item.key === "ads").params.Ads[0].TextAd
      .AdImageHash,
    "hash_approved_1",
  );
  f.sqlite.close();
});

test("selected images are distributed across search ads and kept together for network", () => {
  const input = {
    ads: [
      { title: "Вариант 1", text: "Текст 1" },
      { title: "Вариант 2", text: "Текст 2" },
      { title: "Вариант 3", text: "Текст 3" },
    ],
  };
  const hashes = ["image_hash_1", "image_hash_2"];
  assert.deepEqual(
    attachPostgresDirectImageHashes(input, hashes, false).ads.map(
      (ad) => ad.adImageHash,
    ),
    ["image_hash_1", "image_hash_2", "image_hash_1"],
  );
  assert.deepEqual(
    attachPostgresDirectImageHashes(input, hashes, true).ads.map(
      (ad) => ad.adImageHashes,
    ),
    [hashes, hashes, hashes],
  );
});

test("ambiguous Direct image write is never replayed and can be reconciled by deterministic name", async () => {
  const f = fixture();
  const requestKey = randomUUID();
  let sentName;
  await assert.rejects(
    uploadApprovedPostgresCreativeToDirect(
      f.db,
      f.userId,
      f.businessId,
      f.assetId,
      requestKey,
      {
        createAdImages: async ([image]) => {
          sentName = image.Name;
          throw new Error("connection reset after send");
        },
      },
      f.connectionId,
      {
        enabled: true,
        uploadConfirmed: true,
        login: "owner-login",
      },
    ),
  );
  const pending = f.sqlite
    .prepare("SELECT * FROM jobs WHERE id=?")
    .get(requestKey);
  assert.equal(pending.status, "needs_reconciliation");

  const reconciled = await inspectPostgresDirectImageUpload(
    f.db,
    f.userId,
    f.businessId,
    f.assetId,
    requestKey,
    {
      adImages: async () => ({
        AdImages: [
          {
            AdImageHash: "hash_after_timeout",
            Name: sentName,
            Type: "WIDE",
            Associated: "NO",
          },
        ],
      }),
    },
  );
  assert.equal(reconciled.status, "succeeded");
  assert.equal(reconciled.adImageHash, "hash_after_timeout");
  f.sqlite.close();
});
