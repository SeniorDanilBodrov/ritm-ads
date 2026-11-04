import { mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";

const outputDirectory = resolve("output/playwright");
const databasePath = resolve(outputDirectory, "e2e.sqlite");

mkdirSync(outputDirectory, { recursive: true });
for (const suffix of ["", "-shm", "-wal"]) {
  rmSync(databasePath + suffix, { force: true });
}

Object.assign(process.env, {
  NODE_ENV: "test",
  HOST: "127.0.0.1",
  PORT: "4325",
  APP_ORIGIN: "http://127.0.0.1:4325",
  DATABASE_PATH: databasePath,
  DEMO_MODE: "true",
  LIVE_ADS_ENABLED: "false",
  AUTOPILOT_ENABLED: "false",
  CREATIVE_IMAGES_ENABLED: "false",
  AI_PROVIDER: "rules",
});

delete process.env.DATABASE_URL;
delete process.env.REQUIRE_POSTGRES;

await import("../server/index.js");
