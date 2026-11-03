import { randomBytes } from "node:crypto";
import { access, mkdir, unlink, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isPilotOrigin } from "../server/security.js";

const PILOT_FLAGS = [
  "DIRECT_WRITE_PILOT_ENABLED",
  "DIRECT_ARCHIVE_PILOT_ENABLED",
  "DIRECT_MODERATION_PILOT_ENABLED",
  "DIRECT_RESUME_PILOT_ENABLED",
  "DIRECT_BUDGET_PILOT_ENABLED",
  "DIRECT_AB_VARIANT_PILOT_ENABLED",
  "DIRECT_AB_DECISION_PILOT_ENABLED",
];

const result = (id, level, message) => ({ id, level, message });
const enabled = (value) => String(value || "").toLowerCase() === "true";
const paired = (env, first, second) =>
  Boolean(env[first]) === Boolean(env[second]);

export function inspectProductionConfig(env, { strict = false, live = false } = {}) {
  const checks = [];
  const origin = env.APP_ORIGIN || env.RENDER_EXTERNAL_URL || "";
  const port = Number(env.PORT || 4310);
  const databasePath = env.DATABASE_PATH || "";
  const databaseUrl = env.DATABASE_URL || "";
  const postgresUrl = /^postgres(?:ql)?:\/\//i.test(databaseUrl);
  let encryptionBytes = 0;
  try {
    encryptionBytes = Buffer.from(
      env.TOKEN_ENCRYPTION_KEY || "",
      "base64",
    ).length;
  } catch {
    encryptionBytes = 0;
  }

  const liveRequested = enabled(env.LIVE_ADS_ENABLED);
  checks.push(
    env.NODE_ENV === "production"
      ? result("node_env", "pass", "NODE_ENV установлен в production.")
      : result(
          "node_env",
          "error",
          "Для запуска требуется NODE_ENV=production.",
        ),
    isPilotOrigin(origin)
      ? result(
          "app_origin",
          "pass",
          "APP_ORIGIN использует допустимый production origin.",
        )
      : result(
          "app_origin",
          "error",
          "APP_ORIGIN должен использовать HTTPS либо HTTP localhost/127.0.0.1.",
        ),
    Number.isInteger(port) && port > 0 && port <= 65535
      ? result("port", "pass", "PORT находится в допустимом диапазоне.")
      : result("port", "error", "PORT должен быть целым числом от 1 до 65535."),
    encryptionBytes === 32
      ? result("token_key", "pass", "Ключ шифрования имеет требуемую длину.")
      : result(
          "token_key",
          "error",
          "TOKEN_ENCRYPTION_KEY должен содержать 32 случайных байта в base64.",
        ),
    postgresUrl
      ? result("database_path", "pass", "Настроена PostgreSQL база данных.")
      : databasePath && databasePath !== ":memory:"
        ? result("database_path", "pass", "Настроена постоянная база данных.")
      : result(
          "database_path",
          "error",
          "Нужен DATABASE_URL PostgreSQL либо DATABASE_PATH на постоянный файл, не :memory:.",
        ),
    !liveRequested
      ? result("live_ads", "pass", "Широкий запуск рекламы заблокирован.")
      : !live
        ? result(
            "live_ads",
            "error",
            "Для включенной рекламы запустите preflight с --live.",
          )
        : env.APP_ORIGIN?.startsWith("https://") && enabled(env.AUTOPILOT_ENABLED)
          ? result(
              "live_ads",
              "pass",
              "Платные действия и Budget Guard включены для HTTPS-окружения.",
            )
          : result(
              "live_ads",
              "error",
              "Live-режим требует HTTPS APP_ORIGIN и AUTOPILOT_ENABLED=true.",
            ),
    !enabled(env.YANDEX_SANDBOX)
      ? result(
          "yandex_sandbox",
          "pass",
          "Отключённая песочница Яндекса не используется.",
        )
      : result(
          "yandex_sandbox",
          "error",
          "YANDEX_SANDBOX=true недопустим: песочница больше не существует.",
        ),
  );

  const activePilots = PILOT_FLAGS.filter((name) => enabled(env[name]));
  checks.push(
    activePilots.length === 0
      ? result(
          "pilot_flags",
          "pass",
          "Все одноразовые рекламные write-допуски выключены.",
        )
      : result(
          "pilot_flags",
          "error",
          `Перед передачей выключите рекламные write-допуски (${activePilots.length}).`,
        ),
  );

  for (const [id, first, second, label] of [
    [
      "google_oauth_pair",
      "GOOGLE_CLIENT_ID",
      "GOOGLE_CLIENT_SECRET",
      "Google OAuth",
    ],
    [
      "yandex_oauth_pair",
      "YANDEX_CLIENT_ID",
      "YANDEX_CLIENT_SECRET",
      "Yandex OAuth",
    ],
  ]) {
    const complete = paired(env, first, second);
    const configured = Boolean(env[first] && env[second]);
    checks.push(
      !complete
        ? result(
            id,
            "error",
            `${label}: идентификатор и секрет должны задаваться вместе.`,
          )
        : configured
          ? result(id, "pass", `${label}: пара параметров задана.`)
          : result(
              id,
              strict ? "error" : "info",
              `${label}: интеграция не настроена${strict ? " для независимой приёмки" : ""}.`,
            ),
    );
  }

  if (env.LOCAL_IMAGE_API_URL) {
    let valid = false;
    try {
      const imageUrl = new URL(env.LOCAL_IMAGE_API_URL);
      const loopback = [
        "localhost",
        "127.0.0.1",
        "::1",
        "host.docker.internal",
      ].includes(imageUrl.hostname);
      valid =
        imageUrl.protocol === "https:" ||
        (imageUrl.protocol === "http:" && loopback);
    } catch {
      valid = false;
    }
    checks.push(
      valid
        ? result(
            "local_image_api",
            "pass",
            "Локальный или защищённый OpenVINO API настроен.",
          )
        : result(
            "local_image_api",
            "error",
            "LOCAL_IMAGE_API_URL допускает HTTP только для loopback/host.docker.internal; удалённый API должен использовать HTTPS.",
          ),
    );
  } else {
    checks.push(
      result(
        "local_image_api",
        "info",
        "Локальная генерация изображений не подключена.",
      ),
    );
  }

  if (env.OPS_ALERT_WEBHOOK_URL) {
    let secureWebhook = false;
    try {
      secureWebhook = new URL(env.OPS_ALERT_WEBHOOK_URL).protocol === "https:";
    } catch {
      secureWebhook = false;
    }
    checks.push(
      secureWebhook
        ? result("ops_webhook", "pass", "Webhook оповещений использует HTTPS.")
        : result(
            "ops_webhook",
            "error",
            "OPS_ALERT_WEBHOOK_URL должен быть корректным HTTPS URL.",
          ),
    );
  } else {
    checks.push(
      result(
        "ops_webhook",
        strict ? "warning" : "info",
        "Внешний webhook оповещений не подключён; это не блокирует локальную приёмку.",
      ),
    );
  }

  checks.push(
    result(
      "secret_rotation",
      "manual",
      "Перед публичной передачей подтвердите ротацию ранее раскрытого Yandex Client Secret.",
    ),
  );
  return checks;
}

async function writableDirectory(target, label) {
  const directory = path.resolve(target);
  const probe = path.join(
    directory,
    `.ritm-write-probe-${process.pid}-${randomBytes(4).toString("hex")}`,
  );
  try {
    await mkdir(directory, { recursive: true });
    await access(directory, constants.R_OK | constants.W_OK);
    await writeFile(probe, "ok", { flag: "wx" });
    await unlink(probe);
    return result(label, "pass", "Каталог существует и доступен для записи.");
  } catch {
    await unlink(probe).catch(() => {});
    return result(label, "error", "Каталог недоступен для безопасной записи.");
  }
}

export async function runProductionPreflight({
  env = process.env,
  strict = false,
  live = false,
  cwd = process.cwd(),
} = {}) {
  const checks = inspectProductionConfig(env, { strict, live });
  const databasePath = env.DATABASE_PATH || "./data/ritm.sqlite";
  const postgresUrl = /^postgres(?:ql)?:\/\//i.test(env.DATABASE_URL || "");
  if (!postgresUrl && databasePath !== ":memory:") {
    const databaseDirectory = path.dirname(path.resolve(cwd, databasePath));
    checks.push(
      await writableDirectory(databaseDirectory, "database_directory"),
    );
  }
  checks.push(
    await writableDirectory(
      path.resolve(cwd, env.BACKUP_PATH || "./data/backups"),
      "backup_directory",
    ),
    await writableDirectory(
      path.resolve(cwd, env.ASSET_STORAGE_PATH || "./data/creative-assets"),
      "asset_directory",
    ),
  );

  const summary = {
    passed: !checks.some((check) => check.level === "error"),
    strict,
    counts: Object.fromEntries(
      ["pass", "error", "warning", "info", "manual"].map((level) => [
        level,
        checks.filter((check) => check.level === level).length,
      ]),
    ),
    checks,
  };
  return summary;
}

function printReport(report) {
  const icon = {
    pass: "OK",
    error: "ERROR",
    warning: "WARN",
    info: "INFO",
    manual: "MANUAL",
  };
  console.log(`Production preflight (${report.strict ? "strict" : "local"})`);
  for (const check of report.checks)
    console.log(`[${icon[check.level]}] ${check.id}: ${check.message}`);
  console.log(
    `Result: ${report.passed ? "PASSED" : "BLOCKED"}; errors=${report.counts.error}; manual=${report.counts.manual}`,
  );
}

const invokedDirectly =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const report = await runProductionPreflight({
    strict: process.argv.includes("--strict"),
    live: process.argv.includes("--live"),
  });
  printReport(report);
  process.exitCode = report.passed ? 0 : 1;
}
