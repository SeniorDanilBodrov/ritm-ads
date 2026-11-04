import { createHash, randomUUID } from "node:crypto";
import { AppError } from "./db.js";
import {
  CreativeProviderError,
  KieImageClient,
  advertisingFormats,
  creativeBrandName,
  creativeImagePrompt,
  creativeImageSchema,
  creativeImageView,
  prepareAdvertisingAsset,
} from "./creative-images.js";
import { decrypt } from "./security.js";

const MAX_ATTEMPTS = 3;
const DATABASE_ASSET_PREFIX = "db64:";
const CREATIVE_VIEW_COLUMNS = `
  a.id,a.business_id,a.idempotency_key,a.provider,a.model,a.prompt,a.brief,
  a.style,a.goal,a.hook,a.format,a.audience,a.brand_placement,a.company_name,
  a.seed,a.mime_type,a.byte_size,a.sha256,a.metadata_json,a.approved_at,
  a.created_at,a.updated_at,
  CASE WHEN a.storage_name IS NULL THEN NULL ELSE 'stored' END AS storage_name,
  j.status,j.attempts,j.error`;

async function businessForUser(db, userId, businessId) {
  const row = await db
    .prepare("SELECT * FROM businesses WHERE id=? AND user_id=?")
    .get(businessId, userId);
  if (!row)
    throw new AppError(
      404,
      "Бизнес не найден. Создайте его в настройках.",
      "business_missing",
    );
  return { ...row, state: JSON.parse(row.state) };
}

async function addEvent(db, businessId, payload) {
  const value = { id: randomUUID(), at: new Date().toISOString(), ...payload };
  await db
    .prepare("INSERT INTO events VALUES(?,?,?,?)")
    .run(value.id, businessId, value.at, JSON.stringify(value));
  return value;
}

function databaseAsset(buffer) {
  return DATABASE_ASSET_PREFIX + buffer.toString("base64");
}

function readDatabaseAsset(value) {
  if (!String(value || "").startsWith(DATABASE_ASSET_PREFIX))
    throw new AppError(404, "Файл изображения не найден.");
  const buffer = Buffer.from(
    value.slice(DATABASE_ASSET_PREFIX.length),
    "base64",
  );
  if (!buffer.length)
    throw new AppError(500, "Сохранённое изображение повреждено.");
  return buffer;
}

export async function postgresCreativeImages(db, businessId) {
  const rows = await db
    .prepare(
      `SELECT ${CREATIVE_VIEW_COLUMNS}
       FROM creative_assets a JOIN jobs j ON j.id=a.id
       WHERE a.business_id=? ORDER BY a.created_at DESC LIMIT 30`,
    )
    .all(businessId);
  return rows.map(creativeImageView);
}

export async function enqueuePostgresCreativeImage(
  db,
  userId,
  businessId,
  idempotencyKey,
  rawInput,
  { model, now = Date.now() },
) {
  const input = creativeImageSchema.parse(rawInput);
  return db.transaction(async (tx) => {
    const business = await businessForUser(tx, userId, businessId);
    const companyName =
      input.brandPlacement === "none"
        ? ""
        : creativeBrandName(business.state.name);
    const existing = await tx
      .prepare(
        `SELECT ${CREATIVE_VIEW_COLUMNS}
         FROM creative_assets a JOIN jobs j ON j.id=a.id
         WHERE a.business_id=? AND a.idempotency_key=?`,
      )
      .get(business.id, idempotencyKey);
    if (existing) {
      const same =
        existing.prompt === creativeImagePrompt(input, business) &&
        existing.style === input.style &&
        existing.goal === input.goal &&
        existing.hook === input.hook &&
        existing.format === input.format &&
        existing.audience === input.audience &&
        existing.brand_placement === input.brandPlacement &&
        existing.company_name === companyName &&
        (input.seed === undefined || Number(existing.seed) === input.seed);
      if (!same)
        throw new AppError(
          409,
          "Ключ уже использован для другого изображения.",
          "idempotency_conflict",
        );
      return creativeImageView(existing);
    }

    const id = randomUUID();
    const at = new Date(now).toISOString();
    const seed = input.seed ?? Math.floor(Math.random() * 2_147_483_648);
    const prompt = creativeImagePrompt(input, business);
    await tx
      .prepare(
        "INSERT INTO jobs(id,business_id,kind,status,available_at,attempts,payload) VALUES(?,?,'creative_generation','pending',?,0,?)",
      )
      .run(id, business.id, now, JSON.stringify({ model, provider: "kie" }));
    await tx
      .prepare(
        `INSERT INTO creative_assets(
          id,business_id,idempotency_key,provider,model,prompt,brief,style,goal,hook,format,audience,brand_placement,company_name,seed,created_at,updated_at)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        id,
        business.id,
        idempotencyKey,
        "kie",
        model,
        prompt,
        input.prompt,
        input.style,
        input.goal,
        input.hook,
        input.format,
        input.audience,
        input.brandPlacement,
        companyName,
        seed,
        at,
        at,
      );
    await addEvent(tx, business.id, {
      kind: "creative_generation",
      title: "Изображение поставлено в очередь",
      reason:
        "Рита подготовит один вариант по данным о бизнесе. Он не попадёт в рекламу без вашей проверки.",
      rule: "creative/kie-gpt-image-2.5@1",
      jobId: id,
    });
    return creativeImageView({
      id,
      business_id: business.id,
      status: "pending",
      attempts: 0,
      brief: input.prompt,
      style: input.style,
      goal: input.goal,
      hook: input.hook,
      format: input.format,
      audience: input.audience,
      brand_placement: input.brandPlacement,
      company_name: companyName,
      seed,
      provider: "kie",
      model,
      error: null,
      created_at: at,
      updated_at: at,
    });
  });
}

async function claimCreativeJob(db, now) {
  return db.transaction(async (tx) => {
    const abandoned = await tx
      .prepare(
        "SELECT id,attempts FROM jobs WHERE kind='creative_generation' AND status='running' AND available_at<=? FOR UPDATE SKIP LOCKED",
      )
      .all(now);
    for (const job of abandoned) {
      const failed = Number(job.attempts) >= MAX_ATTEMPTS;
      await tx
        .prepare("UPDATE jobs SET status=?,error=? WHERE id=?")
        .run(
          failed ? "failed" : "pending",
          failed ? "Генерация не завершилась после трёх попыток." : null,
          job.id,
        );
    }

    const next = await tx
      .prepare(
        "SELECT * FROM jobs WHERE kind='creative_generation' AND status='pending' AND available_at<=? ORDER BY available_at,id LIMIT 1 FOR UPDATE SKIP LOCKED",
      )
      .get(now);
    if (!next) return null;
    const attempts = Number(next.attempts) + 1;
    await tx
      .prepare(
        "UPDATE jobs SET status='running',attempts=?,available_at=?,error=NULL WHERE id=?",
      )
      .run(attempts, now + 20 * 60_000, next.id);
    return { ...next, attempts };
  });
}

export async function runPostgresCreativeCycle(
  db,
  { key, config, now = Date.now(), fetcher = fetch, waiter },
) {
  const job = await claimCreativeJob(db, now);
  if (!job) return { status: "idle" };
  const asset = await db
    .prepare("SELECT * FROM creative_assets WHERE id=?")
    .get(job.id);
  if (!asset) {
    await db
      .prepare("UPDATE jobs SET status='failed',error=? WHERE id=?")
      .run("Данные изображения не найдены.", job.id);
    return { id: job.id, status: "failed" };
  }

  try {
    const connection = await db
      .prepare(
        "SELECT encrypted FROM connections WHERE business_id=? AND provider='kie-image'",
      )
      .get(asset.business_id);
    if (!connection)
      throw new CreativeProviderError(
        "Генератор для этого изображения больше не подключён.",
        false,
      );
    let apiKey;
    try {
      apiKey = decrypt(
        connection.encrypted,
        key,
        `${asset.business_id}:kie-image`,
      ).apiKey;
    } catch {
      throw new CreativeProviderError(
        "Не удалось прочитать ключ генератора. Подключите его заново.",
        false,
      );
    }
    const client = new KieImageClient({
      apiKey,
      model: config.kieImageModel,
      fetcher,
      ...(waiter ? { waiter } : {}),
    });
    const format =
      advertisingFormats[asset.format] || advertisingFormats.standard;
    const raw = await client.generate({
      prompt: asset.prompt,
      width: format.generationWidth,
      height: format.generationHeight,
      seed: asset.seed,
      safetyIdentifier: createHash("sha256")
        .update(`ritm:${asset.business_id}`)
        .digest("hex"),
    });
    const generated = await prepareAdvertisingAsset(raw, asset.format, {
      companyName: asset.company_name,
      brandPlacement: asset.brand_placement,
    });
    const digest = createHash("sha256").update(generated.buffer).digest("hex");
    const updatedAt = new Date(now).toISOString();
    const result = await db.transaction(async (tx) => {
      const current = await tx
        .prepare("SELECT status,attempts FROM jobs WHERE id=? FOR UPDATE")
        .get(job.id);
      if (
        current?.status !== "running" ||
        Number(current.attempts) !== job.attempts
      )
        return { id: job.id, status: "lease_lost" };
      await tx
        .prepare(
          "UPDATE jobs SET status='succeeded',available_at=?,error=NULL WHERE id=?",
        )
        .run(now, job.id);
      await tx
        .prepare(
          "UPDATE creative_assets SET mime_type=?,storage_name=?,byte_size=?,sha256=?,metadata_json=?,updated_at=? WHERE id=?",
        )
        .run(
          generated.mimeType,
          databaseAsset(generated.buffer),
          generated.buffer.length,
          digest,
          JSON.stringify({
            provider: generated.provider,
            model: generated.model,
            license: "Kie.ai API terms",
            generatedAt: updatedAt,
            width: generated.width,
            height: generated.height,
            ratio: generated.ratio,
            advertisingFormat: generated.format,
            hook: asset.hook || "outcome",
            companyName: generated.companyName,
            brandPlacement: generated.brandPlacement,
            deterministicTextOverlay: generated.brandPlacement !== "none",
            yandexDirectReady: true,
          }),
          updatedAt,
          job.id,
        );
      await addEvent(tx, asset.business_id, {
        kind: "creative_ready",
        title: "Изображение готово к проверке",
        reason:
          "Вариант сохранён. До ручного подтверждения он не используется в рекламе.",
        rule: "creative/kie-gpt-image-2.5@1",
        jobId: job.id,
      });
      return { id: job.id, status: "succeeded", sha256: digest };
    });
    return result;
  } catch (error) {
    const retryable = error?.retryable !== false;
    const failed = !retryable || job.attempts >= MAX_ATTEMPTS;
    const status = failed ? "failed" : "pending";
    const delay = Math.min(300_000, 10_000 * 2 ** (job.attempts - 1));
    const message = failed
      ? error instanceof CreativeProviderError
        ? error.message
        : "Изображение не создано. Проверьте ключ и доступную квоту."
      : "Генерация временно не выполнена; назначен повтор.";
    await db
      .prepare(
        "UPDATE jobs SET status=?,available_at=?,error=? WHERE id=? AND status='running' AND attempts=?",
      )
      .run(status, now + delay, message, job.id, job.attempts);
    await db
      .prepare("UPDATE creative_assets SET updated_at=? WHERE id=?")
      .run(new Date(now).toISOString(), job.id);
    return { id: job.id, status, error: message };
  }
}

export async function approvePostgresCreativeImage(
  db,
  userId,
  businessId,
  assetId,
) {
  return db.transaction(async (tx) => {
    const business = await businessForUser(tx, userId, businessId);
    const asset = await tx
      .prepare(
        `SELECT ${CREATIVE_VIEW_COLUMNS}
         FROM creative_assets a JOIN jobs j ON j.id=a.id
         WHERE a.id=? AND a.business_id=?`,
      )
      .get(assetId, business.id);
    if (!asset) throw new AppError(404, "Изображение не найдено.");
    if (asset.status !== "succeeded")
      throw new AppError(409, "Сначала дождитесь готового изображения.");
    if (asset.approved_at) return { ok: true, approvedAt: asset.approved_at };
    const approvedAt = new Date().toISOString();
    await tx
      .prepare(
        "UPDATE creative_assets SET approved_at=?,updated_at=? WHERE id=?",
      )
      .run(approvedAt, approvedAt, asset.id);
    await addEvent(tx, business.id, {
      kind: "creative_approved",
      title: "Изображение согласовано",
      reason:
        "Вариант можно добавить в будущий план. Автоматическая публикация по-прежнему выключена.",
      rule: "user",
      jobId: asset.id,
    });
    return { ok: true, approvedAt };
  });
}

export async function postgresCreativeImageFile(
  db,
  userId,
  businessId,
  assetId,
) {
  const business = await businessForUser(db, userId, businessId);
  const asset = await db
    .prepare(
      `SELECT a.*,j.status FROM creative_assets a JOIN jobs j ON j.id=a.id
       WHERE a.id=? AND a.business_id=?`,
    )
    .get(assetId, business.id);
  if (!asset || asset.status !== "succeeded" || !asset.storage_name)
    throw new AppError(404, "Файл изображения не найден.");
  const buffer = readDatabaseAsset(asset.storage_name);
  const digest = createHash("sha256").update(buffer).digest("hex");
  if (asset.sha256 && digest !== asset.sha256)
    throw new AppError(500, "Сохранённое изображение повреждено.");
  return { buffer, mimeType: asset.mime_type || "image/jpeg" };
}

export async function removePostgresCreativeImage(
  db,
  userId,
  businessId,
  assetId,
) {
  return db.transaction(async (tx) => {
    const business = await businessForUser(tx, userId, businessId);
    const asset = await tx
      .prepare(
        `SELECT ${CREATIVE_VIEW_COLUMNS}
         FROM creative_assets a JOIN jobs j ON j.id=a.id
         WHERE a.id=? AND a.business_id=?`,
      )
      .get(assetId, business.id);
    if (!asset) throw new AppError(404, "Изображение не найдено.");
    if (["pending", "running"].includes(asset.status))
      throw new AppError(
        409,
        "Дождитесь завершения генерации перед удалением.",
        "creative_busy",
      );
    if (asset.approved_at)
      throw new AppError(
        409,
        "Согласованный вариант нельзя удалить из этого экрана.",
        "creative_approved",
      );
    await tx.prepare("DELETE FROM creative_assets WHERE id=?").run(asset.id);
    await tx.prepare("DELETE FROM jobs WHERE id=?").run(asset.id);
    await addEvent(tx, business.id, {
      kind: "creative_removed",
      title: "Вариант удалён",
      reason: "Владелец удалил изображение до добавления в рекламный план.",
      rule: "user",
      assetId: asset.id,
    });
    return { ok: true, id: asset.id };
  });
}

export function startPostgresCreativeWorker(db, { key, config }) {
  let pending = null;
  let stopped = false;
  const tick = () => {
    if (stopped || pending) return;
    pending = runPostgresCreativeCycle(db, { key, config })
      .catch(() =>
        console.error(
          JSON.stringify({ event: "postgres_creative_worker_error" }),
        ),
      )
      .finally(() => (pending = null));
  };
  const timer = setInterval(tick, 2_000);
  timer.unref();
  tick();
  return async () => {
    stopped = true;
    clearInterval(timer);
    if (pending) await pending;
  };
}
