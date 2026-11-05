import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import sharp from "sharp";
import { openDatabase } from "../server/db.js";
import {
  approveCreativeImage,
  LocalCreativePromptEnhancer,
  LocalImageClient,
  KieImageClient,
  creativeImagePrompt,
  creativeImages,
  enqueueCreativeImage,
  prepareAdvertisingAsset,
  purgeExpiredCreativeImages,
  removeCreativeImage,
  runCreativeCycle,
} from "../server/creative-images.js";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
const photoJpeg = await sharp({
  create: {
    width: 1280,
    height: 1280,
    channels: 3,
    background: { r: 112, g: 148, b: 104 },
  },
})
  .jpeg()
  .toBuffer();

function liveDb() {
  const db = openDatabase(":memory:"),
    userId = randomUUID(),
    businessId = randomUUID();
  db.prepare("INSERT INTO users VALUES(?,?,?,?)").run(
    userId,
    `google:${userId}`,
    "Tester",
    new Date().toISOString(),
  );
  db.prepare("INSERT INTO businesses VALUES(?,?,?,1)").run(
    businessId,
    userId,
    JSON.stringify({
      mode: "live",
      name: "Студия «Форма»",
      category: "Салон красоты",
      service: "Маникюр",
      city: "Екатеринбург",
      benefit: "Запись в день обращения",
    }),
  );
  return { db, userId, businessId };
}

const input = {
  prompt: "Мастер готовит чистое рабочее место перед приёмом клиента",
  style: "editorial",
  goal: "leads",
  hook: "outcome",
  format: "standard",
  audience: "Жители Екатеринбурга, которым важны аккуратность и удобная запись",
  brandPlacement: "bottom-left",
  seed: 42,
};

test("brand prompt reserves typography space without asking the model to draw letters", () => {
  const prompt = creativeImagePrompt(input, {
    state: {
      category: "Салон красоты",
      service: "Маникюр",
      benefit: "Запись в день обращения",
    },
  });
  assert.match(prompt, /exact Cyrillic wordmark added later/);
  assert.match(prompt, /no text, letters/);
  assert.match(prompt, /bottom-left corner/);
});

test("computer store prompt shows working devices instead of packaging", () => {
  const prompt = creativeImagePrompt(
    { ...input, brandPlacement: "none" },
    {
      state: {
        category: "Магазин компьютерной техники",
        service: "Ноутбуки, компьютеры и комплектующие",
        benefit: "Поможем подобрать технику под задачи",
      },
    },
  );
  assert.match(prompt, /actual powered-on laptop or desktop PC/);
  assert.match(prompt, /clearly visible monitor, keyboard and peripherals/);
  assert.match(prompt, /absolutely no cardboard box/);
  assert.match(prompt, /no .*closed packaging/);
});

test("generic retail prompt keeps the advertised product out of packaging", () => {
  const prompt = creativeImagePrompt(
    { ...input, brandPlacement: "none" },
    {
      state: {
        category: "Розничный магазин",
        service: "Товары для дома",
        benefit: "Помощь консультанта",
      },
    },
  );
  assert.match(prompt, /exact advertised product clearly visible/);
  assert.match(prompt, /out of its packaging/);
  assert.match(prompt, /never use a cardboard box/);
});

test("advertising processor creates Direct-ready JPEGs for every supported ratio", async () => {
  const expected = {
    standard: [1200, 900],
    square: [1080, 1080],
    wide: [1200, 675],
    vertical: [900, 1200],
  };
  for (const [format, dimensions] of Object.entries(expected)) {
    const result = await prepareAdvertisingAsset(
      {
        buffer: photoJpeg,
        mimeType: "image/jpeg",
        extension: ".jpg",
        provider: "test",
        model: "test",
      },
      format,
    );
    const metadata = await sharp(result.buffer).metadata();
    assert.deepEqual([metadata.width, metadata.height], dimensions);
    assert.equal(result.mimeType, "image/jpeg");
    assert.ok(result.buffer.length < 4 * 1024 * 1024);
  }
});

test("brand name is rendered deterministically after generation, including Cyrillic", async () => {
  const companyName = 'Студия <Форма> & "Друзья"',
    plain = await prepareAdvertisingAsset(
      {
        buffer: photoJpeg,
        mimeType: "image/jpeg",
        extension: ".jpg",
        provider: "test",
        model: "test",
      },
      "standard",
    ),
    branded = await prepareAdvertisingAsset(
      {
        buffer: photoJpeg,
        mimeType: "image/jpeg",
        extension: ".jpg",
        provider: "test",
        model: "test",
      },
      "standard",
      { companyName, brandPlacement: "bottom-right" },
    );
  assert.equal(branded.companyName, companyName);
  assert.equal(branded.brandPlacement, "bottom-right");
  assert.notDeepEqual(branded.buffer, plain.buffer);
  assert.ok(branded.buffer.length < 4 * 1024 * 1024);
});

test("local OpenVINO adapter sends a scoped request and validates the image", async () => {
  let request;
  const client = new LocalImageClient({
    baseUrl: "http://127.0.0.1:8000",
    apiToken: "secret-token",
    fetcher: async (url, options) => {
      request = { url, options };
      return {
        ok: true,
        json: async () => ({
          latency: 90,
          images: [jpeg.toString("base64")],
          error: null,
        }),
      };
    },
  });
  const result = await client.generate({
    prompt: "safe prompt",
    width: 1024,
    height: 768,
    seed: 7,
  });
  assert.equal(request.url, "http://127.0.0.1:8000/api/generate");
  assert.equal(request.options.headers.Authorization, "Bearer secret-token");
  const payload = JSON.parse(request.options.body);
  assert.equal(payload.prompt, "safe prompt");
  assert.equal(
    payload.openvino_lcm_model_id,
    "OpenVINO/stable-diffusion-v1-5-int8-ov",
  );
  assert.equal(payload.image_width, 640);
  assert.equal(payload.image_height, 480);
  assert.equal(payload.seed, 7);
  assert.equal(payload.inference_steps, 28);
  assert.equal(payload.guidance_scale, 6.5);
  assert.equal(payload.use_offline_model, false);
  assert.match(payload.negative_prompt, /extra fingers/);
  assert.equal(result.mimeType, "image/jpeg");
  assert.deepEqual(result.buffer, jpeg);
});

test("local OpenVINO adapter enables offline loading for a Windows model path", async () => {
  let payload;
  const client = new LocalImageClient({
    baseUrl: "http://127.0.0.1:8000",
    model: "C:/Users/User/stable-diffusion-v1-5-int8-ov",
    fetcher: async (_url, options) => {
      payload = JSON.parse(options.body);
      return {
        ok: true,
        json: async () => ({ images: [jpeg.toString("base64")] }),
      };
    },
  });
  await client.generate({ prompt: "safe prompt", seed: 7 });
  assert.equal(payload.use_offline_model, true);
});

test("Kie.ai GPT Image 2.5 adapter creates, polls and downloads one task", async () => {
  const requests = [];
  let polls = 0;
  const client = new KieImageClient({
    apiKey: "test-kie-key-not-a-real-secret-1234567890",
    waiter: async () => {},
    fetcher: async (url, options) => {
      requests.push({ url: String(url), options });
      if (String(url).endsWith("/jobs/createTask"))
        return {
          ok: true,
          json: async () => ({
            code: 200,
            data: { taskId: "task-image-25" },
          }),
        };
      if (String(url).includes("/jobs/recordInfo")) {
        polls += 1;
        return {
          ok: true,
          json: async () => ({
            code: 200,
            data:
              polls === 1
                ? { state: "generating" }
                : {
                    state: "success",
                    resultJson: JSON.stringify({
                      resultUrls: ["https://result.kie.ai/image.jpg"],
                    }),
                  },
          }),
        };
      }
      return {
        ok: true,
        headers: { get: () => String(jpeg.length) },
        arrayBuffer: async () => jpeg,
      };
    },
  });
  const result = await client.generate({
    prompt: "Photorealistic local nail salon, one client hand, natural light",
    width: 1024,
    height: 768,
  });
  assert.equal(requests[0].url, "https://api.kie.ai/api/v1/jobs/createTask");
  assert.equal(
    requests[0].options.headers.Authorization,
    "Bearer test-kie-key-not-a-real-secret-1234567890",
  );
  const payload = JSON.parse(requests[0].options.body);
  assert.equal(payload.model, "gpt-image-2-5-flare-text-to-image");
  assert.equal(payload.input.aspect_ratio, "4:3");
  assert.equal(payload.input.resolution, "1K");
  assert.equal(payload.input.background, "opaque");
  assert.equal(polls, 2);
  assert.equal(result.provider, "kie-ai");
  assert.equal(result.mimeType, "image/jpeg");
});

test("local Qwen enhancer turns a Russian brief into a bounded English photo prompt", async () => {
  let request;
  const enhancer = new LocalCreativePromptEnhancer({
    baseUrl: "http://host.docker.internal:11434",
    model: "qwen3.5:4b",
    fetcher: async (url, options) => {
      request = { url: String(url), body: JSON.parse(options.body) };
      return {
        ok: true,
        text: async () =>
          JSON.stringify({
            message: {
              content: JSON.stringify({
                prompt:
                  "Premium candid advertising photo of a nail technician finishing a manicure at a clean salon table, natural window light, realistic hands, polished nails in sharp focus, calm dark space in the bottom-left for a brand plate.",
              }),
            },
          }),
      };
    },
  });
  const result = await enhancer.enhance({
    basePrompt: "Photorealistic nail salon ad",
    brief: "Мастер завершает маникюр клиенту у окна",
    audience: "Женщины 25–40 лет",
  });
  assert.equal(result.enhanced, true);
  assert.doesNotMatch(result.prompt, /[А-Яа-я]/u);
  assert.match(result.prompt, /nail technician/);
  assert.match(request.url, /host\.docker\.internal:11434\/api\/chat/);
  assert.equal(request.body.think, false);
});

test("creative queue is idempotent, isolated and has no daily generation cap", () => {
  const { db, userId, businessId } = liveDb(),
    now = Date.UTC(2026, 9, 28, 12),
    key = randomUUID(),
    first = enqueueCreativeImage(db, userId, businessId, key, input, { now }),
    again = enqueueCreativeImage(db, userId, businessId, key, input, { now });
  assert.equal(first.id, again.id);
  assert.equal(db.prepare("SELECT count(*) AS n FROM jobs").get().n, 1);
  const compiledPrompt = db
    .prepare("SELECT prompt FROM creative_assets WHERE id=?")
    .get(first.id).prompt;
  assert.match(compiledPrompt, /nail technician/);
  assert.match(compiledPrompt, /one client hand/);
  assert.match(compiledPrompt, /finished result clearly visible/);
  assert.ok(compiledPrompt.length <= 500);
  assert.throws(
    () =>
      enqueueCreativeImage(
        db,
        userId,
        businessId,
        key,
        { ...input, seed: 43 },
        { now },
      ),
    /другого изображения/,
  );
  for (let index = 0; index < 5; index += 1)
    enqueueCreativeImage(
      db,
      userId,
      businessId,
      randomUUID(),
      { ...input, seed: 100 + index },
      { now },
    );
  assert.equal(
    db
      .prepare("SELECT count(*) AS n FROM creative_assets WHERE business_id=?")
      .get(businessId).n,
    6,
  );
  assert.deepEqual(creativeImages(db, randomUUID()), []);
  db.close();
});

test("demo business may use only the explicitly configured local image queue", () => {
  const { db, userId, businessId } = liveDb();
  const row = db
    .prepare("SELECT state FROM businesses WHERE id=?")
    .get(businessId);
  const state = JSON.parse(row.state);
  state.mode = "demo";
  db.prepare("UPDATE businesses SET state=? WHERE id=?").run(
    JSON.stringify(state),
    businessId,
  );
  const queued = enqueueCreativeImage(
    db,
    userId,
    businessId,
    randomUUID(),
    input,
  );
  assert.equal(queued.status, "pending");
  assert.equal(queued.provider, "local-openvino");
  db.close();
});

test("worker stores metadata and approval is always a separate user action", async () => {
  const { db, userId, businessId } = liveDb(),
    now = Date.UTC(2026, 9, 28, 12),
    queued = enqueueCreativeImage(db, userId, businessId, randomUUID(), input, {
      now,
    }),
    client = {
      generate: async () => ({
        buffer: photoJpeg,
        mimeType: "image/jpeg",
        extension: ".jpg",
        provider: "local-openvino",
        model: "OpenVINO/stable-diffusion-v1-5-int8-ov",
      }),
    },
    writer = async (_root, business, asset) => `${business}/${asset}.jpg`;
  assert.throws(
    () => approveCreativeImage(db, userId, businessId, queued.id),
    /дождитесь/,
  );
  const result = await runCreativeCycle(db, { now, client, writer });
  assert.equal(result.status, "succeeded");
  const [asset] = creativeImages(db, businessId);
  assert.equal(asset.status, "succeeded");
  assert.equal(asset.approvedAt, null);
  assert.match(asset.sha256, /^[a-f0-9]{64}$/);
  assert.ok(asset.byteSize > 0);
  assert.equal(asset.width, 1200);
  assert.equal(asset.height, 900);
  assert.equal(asset.ratio, "4:3");
  assert.equal(asset.companyName, "Студия «Форма»");
  assert.equal(asset.brandPlacement, "bottom-left");
  assert.equal(asset.hook, "outcome");
  const approved = approveCreativeImage(db, userId, businessId, queued.id);
  assert.ok(approved.approvedAt);
  assert.equal(
    approveCreativeImage(db, userId, businessId, queued.id).approvedAt,
    approved.approvedAt,
  );
  db.close();
});

test("worker retries transient provider failures without leaking details", async () => {
  const { db, userId, businessId } = liveDb(),
    now = Date.UTC(2026, 9, 28, 12),
    queued = enqueueCreativeImage(db, userId, businessId, randomUUID(), input, {
      now,
    }),
    result = await runCreativeCycle(db, {
      now,
      client: {
        generate: async () => {
          const error = new Error("upstream secret diagnostic");
          error.retryable = true;
          throw error;
        },
      },
    });
  assert.equal(result.status, "pending");
  const row = db.prepare("SELECT * FROM jobs WHERE id=?").get(queued.id);
  assert.equal(row.attempts, 1);
  assert.doesNotMatch(row.error, /secret diagnostic/);
  db.close();
});

test("owner can remove only a completed unapproved creative", async () => {
  const { db, userId, businessId } = liveDb(),
    root = await mkdtemp(join(tmpdir(), "ritm-creative-remove-")),
    queued = enqueueCreativeImage(db, userId, businessId, randomUUID(), input);
  try {
    await assert.rejects(
      removeCreativeImage(db, userId, businessId, queued.id, root),
      /Дождитесь завершения/,
    );
    await runCreativeCycle(db, {
      client: {
        generate: async () => ({
          buffer: photoJpeg,
          mimeType: "image/jpeg",
          extension: ".jpg",
          provider: "local-openvino",
          model: "test",
        }),
      },
      storageRoot: root,
    });
    const [ready] = creativeImages(db, businessId),
      filename = join(root, businessId, `${ready.id}.jpg`);
    const stored = await readFile(filename),
      metadata = await sharp(stored).metadata();
    assert.deepEqual([metadata.width, metadata.height], [1200, 900]);
    assert.deepEqual(
      await removeCreativeImage(db, userId, businessId, ready.id, root),
      { ok: true, id: ready.id },
    );
    assert.deepEqual(creativeImages(db, businessId), []);
    await assert.rejects(readFile(filename), /ENOENT/);
  } finally {
    db.close();
  }
});

test("approved creatives survive manual and automatic retention removal", async () => {
  const { db, userId, businessId } = liveDb(),
    root = await mkdtemp(join(tmpdir(), "ritm-creative-retention-")),
    old = Date.UTC(2026, 8, 1),
    first = enqueueCreativeImage(db, userId, businessId, randomUUID(), input, {
      now: old,
    }),
    second = enqueueCreativeImage(
      db,
      userId,
      businessId,
      randomUUID(),
      { ...input, seed: 43 },
      { now: old },
    );
  try {
    const complete = db.prepare(
      "UPDATE jobs SET status='succeeded' WHERE id IN (?,?)",
    );
    complete.run(first.id, second.id);
    await writeFile(join(root, "placeholder"), "keep");
    approveCreativeImage(db, userId, businessId, first.id);
    await assert.rejects(
      removeCreativeImage(db, userId, businessId, first.id, root),
      /Согласованный визуал нельзя удалить/,
    );
    assert.deepEqual(
      await purgeExpiredCreativeImages(db, root, {
        retentionDays: 30,
        now: Date.UTC(2026, 9, 30),
      }),
      { removed: 1, disabled: false },
    );
    const remaining = creativeImages(db, businessId);
    assert.equal(remaining.length, 1);
    assert.equal(remaining[0].id, first.id);
    assert.deepEqual(await purgeExpiredCreativeImages(db, root), {
      removed: 0,
      disabled: true,
    });
  } finally {
    db.close();
  }
});
