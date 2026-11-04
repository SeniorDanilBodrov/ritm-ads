import { createHash, randomUUID } from "node:crypto";
import { AppError } from "./db.js";

const MAX_DIRECT_IMAGE_BYTES = 10 * 1024 * 1024;
const DIRECT_IMAGE_TYPES = new Set(["REGULAR", "WIDE"]);

const json = (value, fallback = {}) => {
  try {
    return value ? JSON.parse(value) : fallback;
  } catch {
    return fallback;
  }
};

async function ownedBusiness(db, userId, businessId) {
  const row = await db
    .prepare("SELECT id FROM businesses WHERE id=? AND user_id=?")
    .get(businessId, userId);
  if (!row) throw new AppError(404, "Бизнес не найден.", "business_missing");
  return row;
}

async function event(db, businessId, payload) {
  const value = { id: randomUUID(), at: new Date().toISOString(), ...payload };
  await db
    .prepare("INSERT INTO events VALUES(?,?,?,?)")
    .run(value.id, businessId, value.at, JSON.stringify(value));
}

function uploadKey(connectionId, login) {
  return createHash("sha256").update(`${connectionId}:${login}`).digest("hex");
}

function directImageName(asset) {
  const extension = asset.mime_type === "image/png" ? "png" : "jpg";
  return `ritm-${asset.sha256.slice(0, 32)}.${extension}`;
}

function jobView(row) {
  if (!row) return null;
  const payload = json(row.payload);
  return {
    id: row.id,
    status: row.status,
    assetId: payload.assetId,
    login: payload.login,
    name: payload.name,
    adImageHash: payload.adImageHash || null,
    imageType: payload.imageType || null,
    error: row.error || null,
  };
}

async function approvedAsset(tx, businessId, assetId, lock = false) {
  const row = await tx
    .prepare(
      `SELECT a.*,j.status AS generation_status
       FROM creative_assets a JOIN jobs j ON j.id=a.id
       WHERE a.id=? AND a.business_id=?${lock ? " FOR UPDATE" : ""}`,
    )
    .get(assetId, businessId);
  if (!row) throw new AppError(404, "Изображение не найдено.");
  if (
    row.generation_status !== "succeeded" ||
    !row.approved_at ||
    !row.storage_name ||
    !row.sha256
  )
    throw new AppError(
      409,
      "Сначала дождитесь изображения и согласуйте его.",
      "creative_not_approved",
    );
  if (!["image/jpeg", "image/png"].includes(row.mime_type))
    throw new AppError(409, "Директ принимает здесь только JPEG или PNG.");
  if (
    !Number.isSafeInteger(Number(row.byte_size)) ||
    Number(row.byte_size) <= 0
  )
    throw new AppError(409, "Не удалось определить размер изображения.");
  if (Number(row.byte_size) > MAX_DIRECT_IMAGE_BYTES)
    throw new AppError(409, "Изображение больше 10 МБ.");
  const metadata = json(row.metadata_json);
  if (metadata.yandexDirectReady !== true)
    throw new AppError(409, "Изображение ещё не подготовлено для Директа.");
  return { ...row, metadata };
}

function databaseBuffer(asset) {
  const prefix = "db64:";
  if (!String(asset.storage_name).startsWith(prefix))
    throw new AppError(409, "Файл изображения недоступен серверу.");
  const buffer = Buffer.from(asset.storage_name.slice(prefix.length), "base64");
  const digest = createHash("sha256").update(buffer).digest("hex");
  if (!buffer.length || digest !== asset.sha256)
    throw new AppError(500, "Сохранённое изображение повреждено.");
  return buffer;
}

async function saveVerifiedUpload(
  db,
  { businessId, assetId, jobId, connectionId, login, name, image },
) {
  return db.transaction(async (tx) => {
    const asset = await approvedAsset(tx, businessId, assetId, true);
    const key = uploadKey(connectionId, login);
    const metadata = {
      ...asset.metadata,
      directUploads: {
        ...(asset.metadata.directUploads || {}),
        [key]: {
          connectionId,
          login,
          name,
          adImageHash: image.AdImageHash,
          imageType: image.Type,
          verifiedAt: new Date().toISOString(),
        },
      },
    };
    const payload = {
      assetId,
      connectionId,
      login,
      name,
      adImageHash: image.AdImageHash,
      imageType: image.Type,
      phase: "verified",
    };
    await tx
      .prepare(
        "UPDATE creative_assets SET metadata_json=?,updated_at=? WHERE id=?",
      )
      .run(JSON.stringify(metadata), new Date().toISOString(), asset.id);
    await tx
      .prepare(
        "UPDATE jobs SET status='succeeded',payload=?,error=NULL WHERE id=?",
      )
      .run(JSON.stringify(payload), jobId);
    await event(tx, businessId, {
      kind: "creative_added_to_direct",
      title: "Изображение добавлено в Директ",
      reason:
        "Согласованный вариант появился в библиотеке кабинета. Показы не запускались.",
      rule: "creative/direct-image@1",
      assetId,
      adImageHash: image.AdImageHash,
    });
    return jobView({
      id: jobId,
      status: "succeeded",
      payload: JSON.stringify(payload),
    });
  });
}

function verifiedImage(result, expectedName) {
  const images = (result?.AdImages || []).filter(
    (item) => item.Name === expectedName && DIRECT_IMAGE_TYPES.has(item.Type),
  );
  if (images.length !== 1 || !images[0].AdImageHash)
    throw new AppError(
      409,
      "Директ не подтвердил единственное загруженное изображение.",
      "direct_image_reconciliation",
    );
  return images[0];
}

export async function uploadApprovedPostgresCreativeToDirect(
  db,
  userId,
  businessId,
  assetId,
  requestKey,
  client,
  connectionId,
  { enabled = false, uploadConfirmed = false, login },
) {
  if (!enabled)
    throw new AppError(
      409,
      "Загрузка изображений в Директ отключена.",
      "live_gate",
    );
  if (uploadConfirmed !== true)
    throw new AppError(400, "Подтвердите добавление изображения в Директ.");
  if (!/^[0-9a-f-]{36}$/i.test(String(requestKey)))
    throw new AppError(400, "Некорректный ключ запроса.");
  if (!connectionId || !String(login || "").trim())
    throw new AppError(409, "Подключение кабинета не подтверждено.");

  const prepared = await db.transaction(async (tx) => {
    const business = await ownedBusiness(tx, userId, businessId);
    const asset = await approvedAsset(tx, business.id, assetId, true);
    const key = uploadKey(connectionId, login);
    const prior = asset.metadata.directUploads?.[key];
    if (prior?.adImageHash)
      return { alreadyUploaded: true, asset, prior, business };
    const existing = await tx
      .prepare("SELECT * FROM jobs WHERE id=?")
      .get(requestKey);
    if (existing) {
      const payload = json(existing.payload);
      if (
        existing.kind !== "direct_image_upload" ||
        existing.business_id !== business.id ||
        payload.assetId !== asset.id ||
        payload.connectionId !== connectionId ||
        payload.login !== login
      )
        throw new AppError(409, "Ключ уже использован для другой операции.");
      if (existing.status === "succeeded")
        return { completed: jobView(existing) };
      throw new AppError(
        409,
        "Предыдущую загрузку нужно сначала сверить с Директом.",
        "direct_image_reconciliation",
      );
    }
    const name = directImageName(asset);
    const payload = {
      assetId: asset.id,
      connectionId,
      login,
      name,
      phase: "sending",
    };
    await tx
      .prepare(
        "INSERT INTO jobs(id,business_id,kind,status,available_at,attempts,payload,error) VALUES(?,?,'direct_image_upload','running',?,1,?,NULL)",
      )
      .run(requestKey, business.id, Date.now(), JSON.stringify(payload));
    return { business, asset, name };
  });

  if (prepared.completed) return prepared.completed;
  if (prepared.alreadyUploaded) {
    const result = await client.adImagesByHashes([prepared.prior.adImageHash]);
    const image = verifiedImage(result, prepared.prior.name);
    return {
      id: null,
      status: "succeeded",
      assetId,
      login,
      name: image.Name,
      adImageHash: image.AdImageHash,
      imageType: image.Type,
      error: null,
    };
  }

  try {
    const buffer = databaseBuffer(prepared.asset);
    const response = await client.createAdImages([
      {
        ImageData: buffer.toString("base64"),
        Name: prepared.name,
        Type: "AUTO",
      },
    ]);
    const added = response?.AddResults?.[0];
    if (response?.AddResults?.length !== 1 || !added?.AdImageHash)
      throw new AppError(
        409,
        "Директ не вернул идентификатор изображения.",
        "direct_image_reconciliation",
      );
    const readback = await client.adImagesByHashes([added.AdImageHash]);
    const image = verifiedImage(readback, prepared.name);
    return await saveVerifiedUpload(db, {
      businessId: prepared.business.id,
      assetId,
      jobId: requestKey,
      connectionId,
      login,
      name: prepared.name,
      image,
    });
  } catch (error) {
    await db
      .prepare(
        "UPDATE jobs SET status='needs_reconciliation',error=? WHERE id=? AND status='running'",
      )
      .run(
        "Ответ Директа не подтверждён. Повторная отправка заблокирована до сверки.",
        requestKey,
      );
    throw error;
  }
}

export async function inspectPostgresDirectImageUpload(
  db,
  userId,
  businessId,
  assetId,
  jobId,
  client,
) {
  await ownedBusiness(db, userId, businessId);
  const row = await db
    .prepare(
      "SELECT * FROM jobs WHERE id=? AND business_id=? AND kind='direct_image_upload'",
    )
    .get(jobId, businessId);
  if (!row) throw new AppError(404, "Операция загрузки не найдена.");
  const payload = json(row.payload);
  if (payload.assetId !== assetId)
    throw new AppError(409, "Операция относится к другому изображению.");
  if (row.status === "succeeded") return jobView(row);
  const result = await client.adImages();
  const candidates = (result?.AdImages || []).filter(
    (item) => item.Name === payload.name && DIRECT_IMAGE_TYPES.has(item.Type),
  );
  if (candidates.length !== 1 || !candidates[0].AdImageHash)
    return {
      ...jobView(row),
      status: "needs_reconciliation",
      found: candidates.length,
    };
  return saveVerifiedUpload(db, {
    businessId,
    assetId,
    jobId,
    connectionId: payload.connectionId,
    login: payload.login,
    name: payload.name,
    image: candidates[0],
  });
}

export async function approvedDirectImageHash(
  db,
  userId,
  businessId,
  assetId,
  connectionId,
  login,
) {
  await ownedBusiness(db, userId, businessId);
  const asset = await approvedAsset(db, businessId, assetId);
  const upload = asset.metadata.directUploads?.[uploadKey(connectionId, login)];
  if (!upload?.adImageHash)
    throw new AppError(
      409,
      "Сначала добавьте согласованное изображение в этот кабинет Директа.",
      "direct_image_missing",
    );
  return upload.adImageHash;
}

export async function markInterruptedPostgresDirectImageUploads(db) {
  return db
    .prepare(
      `UPDATE jobs SET status='needs_reconciliation',error=?
       WHERE kind='direct_image_upload' AND status='running'`,
    )
    .run("Сервер перезапустился во время загрузки. Нужна сверка с Директом.")
    .then((result) => Number(result.changes || 0));
}
