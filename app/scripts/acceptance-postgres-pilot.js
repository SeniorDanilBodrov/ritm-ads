import assert from "node:assert/strict";
import { createPostgresApp } from "../server/app-postgres.js";
import { PostgresDatabase } from "../server/postgres-async.js";
import { runPostgresReportCycle } from "../server/postgres-reports.js";

if (process.env.DATABASE_SMOKE_TEST !== "true")
  throw new Error(
    "Acceptance-проверка создаёт и удаляет демо-данные. Укажите DATABASE_SMOKE_TEST=true.",
  );
if (!/^postgres(?:ql)?:\/\//i.test(process.env.DATABASE_URL || ""))
  throw new Error("Для проверки PostgreSQL задайте DATABASE_URL.");

const db = await PostgresDatabase.connect(process.env.DATABASE_URL, {
  ssl: process.env.POSTGRES_SSL !== "false",
});
const config = {
  origin: "http://127.0.0.1:0",
  production: false,
  demo: true,
  googleId: null,
  googleSecret: null,
  yandexId: null,
  yandexSecret: null,
  encryptionConfigured: false,
};
const app = createPostgresApp({ db, config, key: Buffer.alloc(32) });
const server = await new Promise((resolve) => {
  const value = app.listen(0, "127.0.0.1", () => resolve(value));
});
const port = server.address().port;
config.origin = `http://127.0.0.1:${port}`;
const base = config.origin;
let cookie = "";
let userId = null;
let businessId = null;
const trace = (step) => {
  if (process.env.DATABASE_SMOKE_VERBOSE === "true")
    console.log(`[postgres-pilot] ${step}`);
};
const request = async (path, options = {}) => {
  const headers = new Headers(options.headers || {});
  if (cookie) headers.set("Cookie", cookie);
  if (options.method && options.method !== "GET") {
    headers.set("Origin", base);
    headers.set("X-Ritm-Request", "1");
  }
  const response = await fetch(base + path, { ...options, headers });
  const setCookie = response.headers.get("set-cookie");
  if (setCookie) cookie = setCookie.split(";", 1)[0];
  return response;
};
try {
  trace("health");
  assert.equal((await request("/api/health")).status, 200);
  trace("create demo");
  assert.equal((await request("/api/demo", { method: "POST" })).status, 201);
  trace("read session");
  const session = await (await request("/api/session")).json();
  assert.equal(session.user?.demo, true);
  userId = session.user.id;
  trace("read business");
  const businesses = await (await request("/api/businesses")).json();
  assert.equal(businesses.length, 1);
  businessId = businesses[0].id;
  trace("refresh advertising plan");
  const planResponse = await request(`/api/businesses/${businessId}/ai-plan`, {
    method: "POST",
    headers: {
      "Idempotency-Key": crypto.randomUUID(),
      "Content-Type": "application/json",
    },
    body: "{}",
  });
  assert.equal(planResponse.status, 201);
  assert.equal(
    Boolean((await planResponse.json()).plan?.plan?.ads?.length),
    true,
  );
  trace("check launch readiness");
  const readiness = await (
    await request(`/api/businesses/${businessId}/launch-readiness`)
  ).json();
  assert.equal(typeof readiness.ready, "boolean");
  assert.equal(Array.isArray(readiness.blockers), true);
  trace("queue demo report");
  const reportResponse = await request(
    `/api/businesses/${businessId}/reports`,
    {
      method: "POST",
      headers: {
        "Idempotency-Key": crypto.randomUUID(),
        "Content-Type": "application/json",
      },
      body: "{}",
    },
  );
  assert.equal(reportResponse.status, 202);
  trace("process report");
  assert.equal(
    (await runPostgresReportCycle(db, { key: Buffer.alloc(32) })).status,
    "succeeded",
  );
  trace("read workspace");
  const workspace = await (
    await request(`/api/workspace?businessId=${businessId}`)
  ).json();
  assert.equal(workspace.reports.length, 1);
  assert.equal(
    workspace.events.some((entry) => entry.kind === "observation"),
    true,
  );
  trace("download xlsx");
  const xlsx = await request(
    `/api/businesses/${businessId}/reports/${workspace.reports[0].id}/xlsx`,
  );
  assert.equal(xlsx.status, 200);
  assert.equal(
    Buffer.from(await xlsx.arrayBuffer())
      .subarray(0, 2)
      .toString(),
    "PK",
  );
  console.log(
    JSON.stringify({ ok: true, scenario: "demo-report-xlsx-history" }),
  );
} finally {
  trace("cleanup");
  if (businessId) {
    await db
      .prepare("DELETE FROM report_snapshots WHERE business_id=?")
      .run(businessId);
    await db
      .prepare("DELETE FROM commands WHERE business_id=?")
      .run(businessId);
    await db.prepare("DELETE FROM events WHERE business_id=?").run(businessId);
    await db.prepare("DELETE FROM jobs WHERE business_id=?").run(businessId);
    await db.prepare("DELETE FROM businesses WHERE id=?").run(businessId);
  }
  if (userId) {
    await db.prepare("DELETE FROM sessions WHERE user_id=?").run(userId);
    await db.prepare("DELETE FROM users WHERE id=?").run(userId);
  }
  await new Promise((resolve) => server.close(resolve));
  await db.close();
}
