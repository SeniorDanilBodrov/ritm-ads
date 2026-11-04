import { openDatabaseAsync } from "./db.js";
import { decrypt, encryptionKey, isPilotOrigin } from "./security.js";
import { createApp } from "./app.js";
import { createPostgresApp } from "./app-postgres.js";
import { startPostgresReportWorker } from "./postgres-reports.js";
import { startPostgresCreativeWorker } from "./postgres-creatives.js";
import { startShadowWorker } from "./worker.js";
import { startReportWorker } from "./reports.js";
import { startDirectWorker } from "./direct.js";
import { markInterruptedDirectExecutions } from "./direct-execution.js";
import { markInterruptedLifecycleActions } from "./direct-lifecycle.js";
import { markInterruptedArchiveActions } from "./direct-archive.js";
import { markInterruptedModerationActions } from "./direct-moderation.js";
import { markInterruptedResumeActions } from "./direct-resume.js";
import { markInterruptedBudgetActions } from "./direct-budget-action.js";
import { markInterruptedAbActions } from "./direct-ab-action.js";
import { markInterruptedAbDecisionActions } from "./direct-ab-decision.js";
import { markInterruptedPostgresModerationActions } from "./postgres-direct-moderation.js";
import {
  startCreativeRetentionWorker,
  startCreativeWorker,
} from "./creative-images.js";
import { startLiveDataWorker } from "./live-data-worker.js";
import { startOperationsMonitor } from "./operations-monitor.js";
import { recoverOptimizerDispatches } from "./optimizer-executor.js";
import { canRunAutopilot, canWritePaidAdvertising } from "./live-ads.js";
import { startAcceptanceWorker } from "./acceptance-jobs.js";
const production = process.env.NODE_ENV === "production";
if (process.env.YANDEX_SANDBOX === "true")
  throw new Error(
    "Яндекс Директ отключил песочницу 15 июля 2026 года. Удалите YANDEX_SANDBOX=true и используйте production API только в read-only/dry-run режиме.",
  );
const config = {
  production,
  port: Number(process.env.PORT || 4310),
  origin:
    process.env.APP_ORIGIN ||
    process.env.RENDER_EXTERNAL_URL ||
    "http://localhost:4310",
  demo: process.env.DEMO_MODE !== "false",
  liveAdsEnabled: process.env.LIVE_ADS_ENABLED === "true",
  autopilotEnabled: process.env.AUTOPILOT_ENABLED === "true",
  sandbox: false,
  googleId: process.env.GOOGLE_CLIENT_ID,
  googleSecret: process.env.GOOGLE_CLIENT_SECRET,
  yandexId: process.env.YANDEX_CLIENT_ID,
  yandexSecret: process.env.YANDEX_CLIENT_SECRET,
  encryptionConfigured: !!process.env.TOKEN_ENCRYPTION_KEY,
  aiProvider: process.env.AI_PROVIDER || "ollama",
  aiOllamaUrl: process.env.OLLAMA_URL || "http://127.0.0.1:11434",
  aiModel: process.env.OLLAMA_MODEL || "qwen3.5:4b",
  remoteAiWorkerToken: process.env.REMOTE_AI_WORKER_TOKEN,
  // Local advertising-photo generation is opt-in so a configured but stopped
  // worker cannot make the interface promise a capability that is unavailable.
  creativeImagesEnabled: process.env.CREATIVE_IMAGES_ENABLED === "true",
  localImageApiUrl: process.env.LOCAL_IMAGE_API_URL,
  localImageApiToken: process.env.LOCAL_IMAGE_API_TOKEN,
  localImageModel:
    process.env.LOCAL_IMAGE_MODEL || "OpenVINO/stable-diffusion-v1-5-int8-ov",
  kieImageModel:
    process.env.KIE_IMAGE_MODEL || "gpt-image-2-5-flare-text-to-image",
  creativeDailyLimit: Math.max(
    1,
    Math.min(10, Number(process.env.CREATIVE_DAILY_LIMIT) || 3),
  ),
  assetStoragePath: process.env.ASSET_STORAGE_PATH || "./data/creative-assets",
  creativeRetentionDays: Math.max(
    0,
    Math.min(365, Number(process.env.CREATIVE_RETENTION_DAYS) || 0),
  ),
  directWritePilot: process.env.DIRECT_WRITE_PILOT_ENABLED === "true",
  directModerationPilot: process.env.DIRECT_MODERATION_PILOT_ENABLED === "true",
  directArchivePilot: process.env.DIRECT_ARCHIVE_PILOT_ENABLED === "true",
  directAbVariantPilot: process.env.DIRECT_AB_VARIANT_PILOT_ENABLED === "true",
  directAbDecisionPilot:
    process.env.DIRECT_AB_DECISION_PILOT_ENABLED === "true",
  operationsAlertWebhookUrl: process.env.OPS_ALERT_WEBHOOK_URL,
  operationsAlertBearer: process.env.OPS_ALERT_WEBHOOK_BEARER,
  operationsAlertIntervalMs:
    Math.max(30, Number(process.env.OPS_ALERT_INTERVAL_SECONDS) || 60) * 1_000,
  optimizerPolicy: {
    minClicks: Math.max(
      20,
      Math.min(10_000, Number(process.env.OPTIMIZER_MIN_CLICKS) || 100),
    ),
    minSpendTargetMultiple: Math.max(
      1,
      Math.min(
        20,
        Number(process.env.OPTIMIZER_MIN_SPEND_TARGET_MULTIPLE) || 3,
      ),
    ),
    pauseCpaTargetMultiple: Math.max(
      1.05,
      Math.min(
        10,
        Number(process.env.OPTIMIZER_PAUSE_CPA_TARGET_MULTIPLE) || 1.5,
      ),
    ),
    efficientCpaTargetMultiple: Math.max(
      0.1,
      Math.min(
        0.95,
        Number(process.env.OPTIMIZER_EFFICIENT_CPA_TARGET_MULTIPLE) || 0.8,
      ),
    ),
    minGoalsForReallocation: Math.max(
      3,
      Math.min(
        10_000,
        Number(process.env.OPTIMIZER_MIN_GOALS_FOR_REALLOCATION) || 10,
      ),
    ),
  },
  liveDataScheduleMs:
    Math.max(60, Number(process.env.LIVE_DATA_SCHEDULE_SECONDS) || 300) * 1_000,
  liveDataTickMs:
    Math.max(5, Number(process.env.LIVE_DATA_TICK_SECONDS) || 15) * 1_000,
};
if (production && !isPilotOrigin(config.origin))
  throw new Error("APP_ORIGIN must use HTTPS or HTTP localhost in production");
if (config.autopilotEnabled && !config.liveAdsEnabled)
  throw new Error("AUTOPILOT_ENABLED requires LIVE_ADS_ENABLED=true.");
const databaseTarget =
  process.env.DATABASE_URL || process.env.DATABASE_PATH || "./data/ritm.sqlite";
if (
  production &&
  process.env.REQUIRE_POSTGRES === "true" &&
  !process.env.DATABASE_URL
)
  throw new Error(
    "REQUIRE_POSTGRES=true требует DATABASE_URL. Временная SQLite недопустима для этого окружения.",
  );
const key = encryptionKey(process.env.TOKEN_ENCRYPTION_KEY, production),
  db = await openDatabaseAsync(databaseTarget),
  postgresPilot = db.isAsync === true;
config.kieImageCredential = (businessId) => {
  if (postgresPilot) return null;
  const row = db
    .prepare(
      "SELECT encrypted FROM connections WHERE business_id=? AND provider='kie-image'",
    )
    .get(businessId);
  if (!row) return null;
  try {
    return (
      decrypt(row.encrypted, key, businessId + ":kie-image").apiKey || null
    );
  } catch {
    return null;
  }
};
if (!postgresPilot) {
  markInterruptedDirectExecutions(db);
  markInterruptedLifecycleActions(db);
  markInterruptedArchiveActions(db);
  markInterruptedModerationActions(db);
  markInterruptedResumeActions(db);
  markInterruptedBudgetActions(db);
  markInterruptedAbActions(db);
  markInterruptedAbDecisionActions(db);
  recoverOptimizerDispatches(db);
} else {
  await markInterruptedPostgresModerationActions(db);
}
const app = postgresPilot
  ? createPostgresApp({ db, config, key })
  : createApp({ db, config, key });
const stopWorker = postgresPilot ? async () => {} : startShadowWorker(db);
const stopReports = postgresPilot
  ? startPostgresReportWorker(db, { key })
  : startReportWorker(db, key, config);
const stopDirect = postgresPilot ? async () => {} : startDirectWorker(db);
const stopCreatives = postgresPilot
  ? startPostgresCreativeWorker(db, { key, config })
  : startCreativeWorker(db, config);
const stopCreativeRetention = postgresPilot
  ? async () => {}
  : startCreativeRetentionWorker(db, config);
const stopLiveData = postgresPilot
  ? async () => {}
  : startLiveDataWorker(db, key, config);
const stopOperationsMonitor = postgresPilot
  ? async () => {}
  : startOperationsMonitor(db, {
      webhookUrl: config.operationsAlertWebhookUrl,
      bearerToken: config.operationsAlertBearer,
      intervalMs: config.operationsAlertIntervalMs,
    });
const stopAcceptance = startAcceptanceWorker(db);
const server = app.listen(config.port, process.env.HOST || "127.0.0.1", () =>
  console.log(
    `Ритм: ${config.origin} | демонстрация ${config.demo ? "включена" : "выключена"} | платные действия ${canWritePaidAdvertising(config) ? "разрешены" : "заблокированы"} | автопилот ${canRunAutopilot(config) ? "включён" : "выключен"}`,
  ),
);
// Shadow analysis never advances simulated time or changes advertising objects.
const cleanup = postgresPilot
  ? null
  : setInterval(() => {
      const now = Date.now();
      db.prepare("DELETE FROM sessions WHERE expires_at<?").run(now);
      db.prepare("DELETE FROM oauth_states WHERE expires_at<?").run(now);
    }, 3600000);
cleanup?.unref();
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () =>
    server.close(async () => {
      if (cleanup) clearInterval(cleanup);
      await stopLiveData();
      await stopWorker();
      await stopReports();
      await stopDirect();
      await stopCreatives();
      await stopCreativeRetention();
      await stopOperationsMonitor();
      await stopAcceptance();
      await db.close();
      process.exit(0);
    }),
  );
