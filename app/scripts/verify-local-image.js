import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { openDatabase } from "../server/db.js";
import {
  LocalCreativePromptEnhancer,
  LocalImageClient,
  creativeImages,
  enqueueCreativeImage,
  runCreativeCycle,
} from "../server/creative-images.js";

const baseUrl = process.env.LOCAL_IMAGE_API_URL;
const model = process.env.LOCAL_IMAGE_MODEL;
if (process.env.CREATIVE_IMAGES_ENABLED !== "true")
  throw new Error("Установите CREATIVE_IMAGES_ENABLED=true в .env");
if (!baseUrl || !model)
  throw new Error("Заполните LOCAL_IMAGE_API_URL и LOCAL_IMAGE_MODEL в .env");

const db = openDatabase(":memory:");
const userId = randomUUID();
const businessId = randomUUID();
const storageRoot = resolve("./data/creative-assets/integration-check");

try {
  db.prepare("INSERT INTO users VALUES(?,?,?,?)").run(
    userId,
    `local-image-check:${userId}`,
    "Local image check",
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
      benefit: "Аккуратная запись рядом с домом",
    }),
  );

  const queued = enqueueCreativeImage(db, userId, businessId, randomUUID(), {
    prompt:
      "Мастер аккуратно завершает маникюр клиенту в чистой современной студии",
    style: "editorial",
    goal: "leads",
    hook: "outcome",
    format: "standard",
    audience: "Женщины Екатеринбурга, которым важны качество и удобная запись",
    brandPlacement: "bottom-left",
    seed: 42,
  });
  const client = new LocalImageClient({
    baseUrl,
    apiToken: process.env.LOCAL_IMAGE_API_TOKEN || "",
    model,
  });
  const enhancer = new LocalCreativePromptEnhancer({
    baseUrl: process.env.OLLAMA_URL || "http://127.0.0.1:11434",
    model: process.env.OLLAMA_MODEL || "qwen3.5:4b",
  });

  console.log("Проверка: задача создана внутри очереди Ритма.");
  const result = await runCreativeCycle(db, { client, enhancer, storageRoot });
  const asset = creativeImages(db, businessId).find(
    (item) => item.id === queued.id,
  );
  if (result.status !== "succeeded" || !asset?.imageUrl)
    throw new Error(asset?.error || "Рекламный визуал не был создан.");
  const row = db
    .prepare("SELECT storage_name FROM creative_assets WHERE id=?")
    .get(queued.id);
  const file = resolve(storageRoot, row.storage_name);
  console.log(
    JSON.stringify(
      {
        status: result.status,
        file,
        format: asset.ratio,
        size: `${asset.width}x${asset.height}`,
        approved: Boolean(asset.approvedAt),
        note: "Файл создан, но не согласован и не опубликован автоматически.",
      },
      null,
      2,
    ),
  );
} finally {
  db.close();
}
