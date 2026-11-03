import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  inspectProductionConfig,
  runProductionPreflight,
} from "../scripts/production-preflight.js";

const key = Buffer.alloc(32, 7).toString("base64");
const safeEnv = (root) => ({
  NODE_ENV: "production",
  APP_ORIGIN: "http://localhost:4310",
  PORT: "4310",
  TOKEN_ENCRYPTION_KEY: key,
  DATABASE_PATH: path.join(root, "db", "ritm.sqlite"),
  BACKUP_PATH: path.join(root, "backups"),
  ASSET_STORAGE_PATH: path.join(root, "assets"),
  LIVE_ADS_ENABLED: "false",
  YANDEX_SANDBOX: "false",
  GOOGLE_CLIENT_ID: "configured",
  GOOGLE_CLIENT_SECRET: "configured",
  YANDEX_CLIENT_ID: "configured",
  YANDEX_CLIENT_SECRET: "configured",
});

test("production preflight accepts safe localhost handoff and writable storage", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ritm-preflight-"));
  try {
    const report = await runProductionPreflight({
      env: safeEnv(root),
      strict: true,
      cwd: root,
    });
    assert.equal(report.passed, true);
    assert.equal(report.counts.error, 0);
    assert.equal(report.counts.manual, 1);
    assert.equal(
      report.checks.find((check) => check.id === "ops_webhook").level,
      "warning",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("production preflight accepts a hosted PostgreSQL URL without local database storage", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ritm-preflight-postgres-"));
  try {
    const env = safeEnv(root);
    delete env.DATABASE_PATH;
    env.DATABASE_URL = "postgresql://user:secret@db.example.test:5432/ritm?sslmode=require";
    const report = await runProductionPreflight({ env, strict: true, cwd: root });
    assert.equal(report.passed, true);
    assert.equal(
      report.checks.find((check) => check.id === "database_path").message,
      "Настроена PostgreSQL база данных.",
    );
    assert.equal(report.checks.some((check) => check.id === "database_directory"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("production preflight blocks unsafe secrets, memory database and write flags", () => {
  const checks = inspectProductionConfig(
    {
      NODE_ENV: "development",
      APP_ORIGIN: "http://example.test",
      TOKEN_ENCRYPTION_KEY: "short",
      DATABASE_PATH: ":memory:",
      LIVE_ADS_ENABLED: "true",
      YANDEX_SANDBOX: "true",
      DIRECT_RESUME_PILOT_ENABLED: "true",
      GOOGLE_CLIENT_ID: "orphaned",
      LOCAL_IMAGE_API_URL: "http://public-model.example",
    },
    { strict: true },
  );
  const errors = checks
    .filter((check) => check.level === "error")
    .map((check) => check.id);
  assert.deepEqual(
    [
      "node_env",
      "app_origin",
      "token_key",
      "database_path",
      "live_ads",
      "yandex_sandbox",
      "pilot_flags",
      "google_oauth_pair",
      "yandex_oauth_pair",
      "local_image_api",
    ].filter((id) => errors.includes(id)),
    [
      "node_env",
      "app_origin",
      "token_key",
      "database_path",
      "live_ads",
      "yandex_sandbox",
      "pilot_flags",
      "google_oauth_pair",
      "yandex_oauth_pair",
      "local_image_api",
    ],
  );
});

test("live preflight requires an explicit HTTPS autopilot opt-in", () => {
  const env = {
    ...safeEnv("data"),
    APP_ORIGIN: "https://ritm.example",
    LIVE_ADS_ENABLED: "true",
    AUTOPILOT_ENABLED: "true",
  };
  assert.equal(
    inspectProductionConfig(env, { strict: true, live: true }).some(
      (check) => check.level === "error",
    ),
    false,
  );
  assert.equal(
    inspectProductionConfig(env, { strict: true }).find(
      (check) => check.id === "live_ads",
    ).level,
    "error",
  );
  env.AUTOPILOT_ENABLED = "false";
  assert.equal(
    inspectProductionConfig(env, { strict: true, live: true }).find(
      (check) => check.id === "live_ads",
    ).level,
    "error",
  );
});

test("optional integrations may remain absent in local mode", () => {
  const env = safeEnv("data");
  delete env.GOOGLE_CLIENT_ID;
  delete env.GOOGLE_CLIENT_SECRET;
  delete env.YANDEX_CLIENT_ID;
  delete env.YANDEX_CLIENT_SECRET;
  const checks = inspectProductionConfig(env);
  assert.equal(
    checks.find((check) => check.id === "google_oauth_pair").level,
    "info",
  );
  assert.equal(
    checks.find((check) => check.id === "yandex_oauth_pair").level,
    "info",
  );
  assert.equal(
    checks.some((check) => check.level === "error"),
    false,
  );
});
