import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import ExcelJS from "exceljs";
import { openDatabase } from "../server/db.js";
import { createApp } from "../server/app.js";
import { tickDemo, assertBudget, seedDemo } from "../server/engine.js";
import { runReportCycle } from "../server/reports.js";
import { enqueueDirectDryRun, runDirectCycle } from "../server/direct.js";
import { runAcceptanceCycle } from "../server/acceptance-jobs.js";
import { encrypt, hash } from "../server/security.js";
let db, server, base;
const config = {
  production: false,
  origin: "http://localhost:4310",
  demo: true,
  sandbox: false,
  encryptionConfigured: false,
  aiProvider: "fallback",
};
before(async () => {
  db = openDatabase(":memory:");
  server = createApp({ db, config, key: randomBytes(32) }).listen(
    0,
    "127.0.0.1",
  );
  await new Promise((r) => server.once("listening", r));
  base = "http://127.0.0.1:" + server.address().port;
});
after(async () => {
  await new Promise((r) => server.close(r));
  db.close();
});
async function send(
  path,
  {
    cookie = "",
    body,
    key = randomUUID(),
    origin = config.origin,
    method,
  } = {},
) {
  const r = await fetch(base + path, {
    method: method || (body === undefined ? "GET" : "POST"),
    headers: {
      Cookie: cookie,
      Origin: origin,
      "X-Ritm-Request": "1",
      "Content-Type": "application/json",
      "Idempotency-Key": key,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return {
    status: r.status,
    body: await r.json(),
    cookie: r.headers.get("set-cookie")?.split(";")[0],
  };
}
async function demo() {
  const a = await send("/api/demo", { body: {} });
  const w = await send("/api/workspace", { cookie: a.cookie });
  return { cookie: a.cookie, ws: w.body };
}
test("anonymous API access is rejected", async () => {
  assert.equal((await send("/api/workspace")).status, 401);
});

test("business owner can request an isolated AI advertising plan without Direct writes", async () => {
  const { cookie, ws } = await demo(),
    key = randomUUID(),
    path = `/api/businesses/${ws.id}/ai-plan`;
  const first = await send(path, { cookie, key, body: {} }),
    repeated = await send(path, { cookie, key, body: {} });
  assert.equal(first.status, 201);
  assert.deepEqual(first.body, repeated.body);
  assert.equal(first.body.plan.provider, "fallback");
  assert.deepEqual(first.body.plan.plan.budgetAllocation, [
    { channel: "search", percent: 65 },
    { channel: "network", percent: 35 },
  ]);
  const current = await send(`/api/workspace?businessId=${ws.id}`, { cookie });
  assert.equal(current.body.state.aiPlan.provider, "fallback");
  assert.equal(current.body.directChanges.length, 0);
  assert.ok(current.body.events.some((item) => item.kind === "ai_plan"));
});

test("owner can edit a prepared text and must approve the changed version again", async () => {
  const { cookie, ws } = await demo();
  const path = `/api/businesses/${ws.id}/command`;
  const creative = ws.state.creatives[0];
  assert.equal(
    (
      await send(path, {
        cookie,
        body: { action: "approve", payload: { id: creative.id } },
      })
    ).status,
    200,
  );
  const title = "Маникюр рядом с домом";
  const text = "Бережное покрытие и запись на удобное время.";
  const edited = await send(path, {
    cookie,
    body: {
      action: "editCreative",
      payload: { id: creative.id, title, text },
    },
  });
  assert.equal(edited.status, 200);
  let current = await send(`/api/workspace?businessId=${ws.id}`, { cookie });
  const changed = current.body.state.creatives.find(
    (item) => item.id === creative.id,
  );
  assert.equal(changed.title, title);
  assert.equal(changed.text, text);
  assert.equal(changed.status, "draft");
  assert.equal(changed.version, "user/1");
  assert.ok(current.body.events.some((item) => item.kind === "creative_edit"));
  assert.equal(
    (
      await send(path, {
        cookie,
        body: { action: "approve", payload: { id: creative.id } },
      })
    ).status,
    200,
  );
  current = await send(`/api/workspace?businessId=${ws.id}`, { cookie });
  assert.equal(
    current.body.state.creatives.find((item) => item.id === creative.id).status,
    "approved",
  );
});

test("onboarding needs a business description and a budget, not a target CPA", async () => {
  const { cookie } = await demo();
  const created = await send("/api/businesses", {
    cookie,
    body: {
      name: "Йога у дома",
      category: "Йога-студия",
      city: "Екатеринбург",
      website: "",
      service: "Занятия йогой для начинающих",
      benefit: "Небольшие группы и удобная запись",
      price: 0,
      budget: 3_000_000,
      timezone: "Asia/Yekaterinburg",
      periodStart: "2026-10-31",
      periodEnd: "2026-11-29",
    },
  });
  assert.equal(created.status, 201);
  const workspace = await send(`/api/workspace?businessId=${created.body.id}`, {
    cookie,
  });
  assert.equal(workspace.body.state.targetCpa, 150_000);
});

test("assistant onboarding creates the business and validated plan atomically", async () => {
  const { cookie } = await demo();
  const created = await send("/api/businesses/with-plan", {
    cookie,
    body: {
      name: "Студия Тихо",
      category: "Йога-студия",
      city: "Екатеринбург",
      website: "https://example.test",
      service: "Йога для начинающих",
      benefit: "Бережное знакомство и небольшие группы",
      price: 0,
      budget: 2_500_000,
      timezone: "Asia/Yekaterinburg",
      periodStart: "2026-11-01",
      periodEnd: "2026-11-30",
    },
  });
  assert.equal(created.status, 201);
  assert.equal(created.body.plan.provider, "fallback");
  const workspace = await send(`/api/workspace?businessId=${created.body.id}`, {
    cookie,
  });
  assert.equal(
    workspace.body.state.aiPlan.inputHash,
    created.body.plan.inputHash,
  );
  assert.equal(
    workspace.body.state.creatives.length,
    created.body.plan.plan.ads.length,
  );
  assert.deepEqual(
    workspace.body.events.slice(0, 2).map((item) => item.kind),
    ["ai_plan", "created"],
  );
});

test("health and readiness expose no business data", async () => {
  const health = await send("/api/health"),
    readiness = await send("/api/ready");
  assert.equal(health.status, 200);
  assert.equal(health.body.ok, true);
  assert.equal(readiness.status, 200);
  assert.equal(readiness.body.ready, true);
  assert.equal(typeof readiness.body.queues.pending, "number");
  assert.equal(JSON.stringify(readiness.body).includes("payload"), false);
  assert.equal(JSON.stringify(readiness.body).includes("businessId"), false);
});

test("Direct write pilot endpoint is closed on the local server", async () => {
  const a = await demo();
  const shadowPath = `/api/businesses/${a.ws.id}/direct/${randomUUID()}/shadow-review`;
  assert.deepEqual(a.ws.shadowReviews, []);
  assert.equal((await send(shadowPath)).status, 401);
  assert.equal((await send(shadowPath, { body: {} })).status, 401);
  assert.equal((await send(shadowPath, { cookie: a.cookie })).body, null);
  const response = await send(
    `/api/businesses/${a.ws.id}/direct/${randomUUID()}/execute`,
    { cookie: a.cookie, body: { planFingerprint: "a".repeat(64) } },
  );
  assert.equal(response.status, 409);
  assert.equal(response.body.code, "live_gate");
  assert.equal(a.ws.capabilities.directWritePilot, false);
  const suspend = await send(
    `/api/businesses/${a.ws.id}/direct/${randomUUID()}/suspend`,
    { cookie: a.cookie, body: {}, key: randomUUID() },
  );
  assert.equal(suspend.status, 409);
  assert.equal(suspend.body.code, "live_gate");
  const archive = await send(
    `/api/businesses/${a.ws.id}/direct/${randomUUID()}/archive`,
    {
      cookie: a.cookie,
      body: { confirmCampaignId: 101, confirmedNoFunds: true },
      key: randomUUID(),
    },
  );
  assert.equal(archive.status, 409);
  assert.equal(archive.body.code, "archive_gate");
  assert.equal(a.ws.capabilities.directArchivePilot, false);
  const moderation = await send(
    `/api/businesses/${a.ws.id}/direct/${randomUUID()}/moderate`,
    {
      cookie: a.cookie,
      body: { advertiserConfirmed: true, siteConfirmed: true },
    },
  );
  assert.equal(moderation.status, 409);
  assert.equal(moderation.body.code, "live_gate");
  assert.equal(a.ws.capabilities.directModerationPilot, false);
  const resume = await send(
    `/api/businesses/${a.ws.id}/direct/${randomUUID()}/resume`,
    {
      cookie: a.cookie,
      body: {
        advertiserConfirmed: true,
        siteConfirmed: true,
        markingConfirmed: true,
        spendConfirmed: true,
        confirmCampaignId: 101,
        confirmLimitKopecks: 300000,
      },
    },
  );
  assert.equal(resume.status, 409);
  assert.equal(resume.body.code, "live_gate");
  assert.equal(a.ws.capabilities.directResumePilot, false);
  assert.equal(
    db.prepare("SELECT COUNT(*) AS count FROM direct_archive_actions").get()
      .count,
    0,
  );
});

test("report endpoints isolate jobs, snapshots and raw source between users", async () => {
  const a = await demo(),
    b = await demo(),
    path = `/api/businesses/${a.ws.id}/reports`,
    key = randomUUID();
  assert.equal((await send(path, { cookie: b.cookie, body: {} })).status, 404);
  const queued = await send(path, { cookie: a.cookie, body: {}, key });
  assert.equal(queued.status, 202);
  assert.deepEqual(
    (await send(path, { cookie: a.cookie, body: {}, key })).body,
    queued.body,
  );
  await runReportCycle(db);
  const view = (await send("/api/workspace", { cookie: a.cookie })).body;
  assert.equal(view.reports.length, 1);
  assert.equal(
    (await send("/api/workspace", { cookie: b.cookie })).body.reports.length,
    0,
  );
  const rawPath = `/api/businesses/${a.ws.id}/reports/${view.reports[0].id}/raw`;
  assert.equal((await send(rawPath, { cookie: b.cookie })).status, 404);
  const r = await fetch(base + rawPath, { headers: { Cookie: a.cookie } });
  assert.equal(r.status, 200);
  assert.match(r.headers.get("content-type"), /application\/json/);
  assert.match(r.headers.get("content-disposition"), /attachment/);
  const exported = await r.json();
  assert.ok(exported.rawTsv.startsWith("Date\t"));
  assert.equal(exported.source, "demo");
  assert.equal(exported.currency, "RUB");
  assert.equal(exported.includeVat, 1);
  assert.match(exported.sha256, /^[a-f0-9]{64}$/);
  assert.match(exported.dateFrom, /^\d{4}-\d{2}-\d{2}$/);
  assert.match(exported.dateTo, /^\d{4}-\d{2}-\d{2}$/);

  const xlsxPath = `/api/businesses/${a.ws.id}/reports/${view.reports[0].id}/xlsx`;
  assert.equal((await send(xlsxPath, { cookie: b.cookie })).status, 404);
  const xlsx = await fetch(base + xlsxPath, { headers: { Cookie: a.cookie } });
  assert.equal(xlsx.status, 200);
  assert.match(
    xlsx.headers.get("content-type"),
    /application\/vnd\.openxmlformats-officedocument\.spreadsheetml\.sheet/,
  );
  assert.match(xlsx.headers.get("content-disposition"), /\.xlsx/);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(await xlsx.arrayBuffer());
  const sheet = workbook.getWorksheet("Отчёт");
  assert.equal(sheet.getCell("A1").value, "Отчёт по рекламе");
  assert.equal(sheet.getCell("A8").value, "Дата");
  assert.equal(sheet.getCell("E10").numFmt, '#,##0.00 "₽"');
});
test("CSRF rejects requests from other origins", async () => {
  assert.equal(
    (await send("/api/demo", { body: {}, origin: "https://evil.example" }))
      .status,
    403,
  );
});
test("businesses are isolated between sessions", async () => {
  const a = await demo(),
    b = await demo();
  assert.notEqual(a.ws.id, b.ws.id);
  assert.equal(
    (await send("/api/workspace?businessId=" + a.ws.id, { cookie: b.cookie }))
      .status,
    404,
  );
  const r = await send(`/api/businesses/${a.ws.id}/command`, {
    cookie: b.cookie,
    body: { action: "tick" },
  });
  assert.equal(r.status, 404);
});
test("concurrent retry is idempotent, modified payload conflicts", async () => {
  const { cookie, ws } = await demo(),
    key = randomUUID();
  const path = `/api/businesses/${ws.id}/command`;
  const [a, b] = await Promise.all([
    send(path, { cookie, key, body: { action: "tick" } }),
    send(path, { cookie, key, body: { action: "tick" } }),
  ]);
  assert.equal(a.status, 200);
  assert.deepEqual(a.body, b.body);
  const current = await send("/api/workspace", { cookie });
  assert.equal(current.body.state.sequence, 1);
  assert.equal(
    (await send(path, { cookie, key, body: { action: "toggle" } })).status,
    409,
  );
});
test("failed budget mutation rolls back state and journal", async () => {
  const { cookie, ws } = await demo();
  const r = await send(`/api/businesses/${ws.id}/command`, {
    cookie,
    body: { action: "budget", payload: { budget: 100, targetCpa: 45000 } },
  });
  assert.equal(r.status, 409);
  const current = await send("/api/workspace", { cookie });
  assert.equal(current.body.version, ws.version);
  assert.equal(current.body.state.budget, ws.state.budget);
  assert.equal(current.body.events.length, ws.events.length);
});
test("logout revokes session", async () => {
  const { cookie } = await demo();
  await send("/api/logout", { cookie, body: {} });
  assert.equal((await send("/api/workspace", { cookie })).status, 401);
});
test("demo never calls provider APIs", async () => {
  const { cookie, ws } = await demo();
  const r = await send(`/api/businesses/${ws.id}/provider/campaigns`, {
    cookie,
  });
  assert.equal(r.status, 409);
  assert.match(r.body.error, /Демо/);
});
test("live actions stay gated even when attempted directly", async () => {
  const { cookie, ws } = await demo();
  const state = { ...ws.state, mode: "live" };
  db.prepare("UPDATE businesses SET state=? WHERE id=?").run(
    JSON.stringify(state),
    ws.id,
  );
  const r = await send(`/api/businesses/${ws.id}/command`, {
    cookie,
    body: { action: "launch" },
  });
  assert.equal(r.status, 409);
  assert.equal(r.body.code, "live_gate");
});
test("live workspace can update its local profile without enabling ad writes", async () => {
  const { cookie, ws } = await demo(),
    state = { ...ws.state, mode: "live" },
    website = "https://ritm.example.test";
  db.prepare("UPDATE businesses SET state=? WHERE id=?").run(
    JSON.stringify(state),
    ws.id,
  );
  const saved = await send(`/api/businesses/${ws.id}/command`, {
    cookie,
    body: {
      action: "settings",
      payload: {
        name: state.name,
        category: state.category,
        city: state.city,
        website,
        landingMode: "yandex_landing",
        service: state.service,
        benefit: state.benefit,
        price: state.price,
        budget: state.budget,
        targetCpa: state.targetCpa,
        timezone: state.timezone,
        periodStart: state.periodStart,
        periodEnd: state.periodEnd,
      },
    },
  });
  assert.equal(saved.status, 200);
  const current = await send(`/api/workspace?businessId=${ws.id}`, { cookie });
  assert.equal(current.body.state.website, website);
  assert.equal(current.body.state.landingMode, "yandex_landing");
  assert.equal(
    (
      await send(`/api/businesses/${ws.id}/command`, {
        cookie,
        body: { action: "launch" },
      })
    ).body.code,
    "live_gate",
  );
});
test("profile update recalculates the hidden target when the form omits it", async () => {
  const { cookie, ws } = await demo();
  const legacy = { ...ws.state, targetCpa: 450 };
  db.prepare("UPDATE businesses SET state=? WHERE id=?").run(
    JSON.stringify(legacy),
    ws.id,
  );
  const { targetCpa: _hidden, ...profile } = legacy;
  const saved = await send(`/api/businesses/${ws.id}/command`, {
    cookie,
    body: {
      action: "settings",
      payload: { ...profile, budget: 4_000_000 },
    },
  });
  assert.equal(saved.status, 200);
  const current = await send(`/api/workspace?businessId=${ws.id}`, { cookie });
  assert.equal(current.body.state.budget, 4_000_000);
  assert.equal(current.body.state.targetCpa, 200_000);
});
test("live workspace can prepare a plan and test the autopilot without provider writes", async () => {
  const { cookie, ws } = await demo(),
    key = randomUUID(),
    state = { ...ws.state, mode: "live" },
    plan = {
      login: "client-login",
      campaignName: "Проверка API",
      website: "https://example.test",
      audience: "Жители Екатеринбурга",
      regionIds: [54],
      budget: 1000000,
      targetCpa: 100000,
      periodStart: "2026-10-25",
      periodEnd: "2026-11-25",
      ads: [
        {
          title: "Тестовый заголовок",
          text: "Команда будет только подготовлена.",
          href: "https://example.test",
        },
      ],
      keywords: ["тестовая фраза"],
    };
  db.prepare("UPDATE businesses SET state=? WHERE id=?").run(
    JSON.stringify(state),
    ws.id,
  );
  const path = `/api/businesses/${ws.id}/direct/dry-run`,
    first = await send(path, { cookie, body: plan, key }),
    repeated = await send(path, { cookie, body: plan, key });
  assert.equal(first.status, 202);
  assert.equal(first.body.id, repeated.body.id);
  assert.equal(first.body.summary.externalCalls, 0);
  await runDirectCycle(db, { now: first.body.availableAt });
  const current = await send("/api/workspace", { cookie });
  assert.equal(current.body.directChanges[0].status, "succeeded");
  assert.equal(current.body.directChanges[0].reconciliation.externalCalls, 0);
  const stateBeforeRun = structuredClone(current.body.state),
    acceptance = await send(`/api/businesses/${ws.id}/acceptance-run`, {
      cookie,
      body: {},
    });
  assert.equal(acceptance.status, 202);
  assert.equal(acceptance.body.acceptanceRun.status, "pending");
  assert.equal(acceptance.body.acceptanceRun.stage, "queued");
  assert.equal(acceptance.body.acceptanceRun.report, null);
  const inQueue = await send(`/api/workspace?businessId=${ws.id}`, {
    cookie,
  });
  assert.equal(inQueue.body.acceptanceRuns[0].status, "pending");
  const result = await runAcceptanceCycle(db, {
    now: acceptance.body.acceptanceRun.availableAt,
  });
  assert.equal(result.status, "succeeded");
  const afterRun = await send(`/api/workspace?businessId=${ws.id}`, {
    cookie,
  });
  assert.deepEqual(afterRun.body.state, stateBeforeRun);
  assert.equal(afterRun.body.acceptanceRuns[0].status, "succeeded");
  assert.equal(afterRun.body.acceptanceRuns[0].report.providerCalls, 0);
  assert.equal(afterRun.body.acceptanceRuns[0].report.externalWrites, 0);
  assert.equal(afterRun.body.acceptanceRuns[0].report.checks.length, 9);
  assert.equal(afterRun.body.events[0].kind, "acceptance_run");
  assert.equal(afterRun.body.events[0].acceptanceRun.status, "passed");
  const protocol = await fetch(
    `${base}/api/businesses/${ws.id}/acceptance-run/${acceptance.body.acceptanceRun.id}/protocol`,
    { headers: { Cookie: cookie, Origin: config.origin } },
  );
  assert.equal(protocol.status, 200);
  assert.match(protocol.headers.get("content-disposition"), /attachment/);
  assert.match(await protocol.text(), /9 из 9 проверок пройдено/);
});
test("misconfigured OAuth does not redirect with empty credentials", async () => {
  const r = await fetch(base + "/auth/google/start");
  assert.equal(r.status, 503);
});

test("Google OAuth start binds HTTPS callback, state, nonce and S256 PKCE", async () => {
  const oauthDb = openDatabase(":memory:"),
    oauthConfig = {
      production: true,
      origin: "https://ritm.example",
      demo: false,
      sandbox: false,
      encryptionConfigured: true,
      googleId: "google-client-id",
      googleSecret: "google-client-secret",
    },
    oauthServer = createApp({
      db: oauthDb,
      config: oauthConfig,
      key: randomBytes(32),
    }).listen(0, "127.0.0.1");
  await new Promise((resolve) => oauthServer.once("listening", resolve));
  try {
    const response = await fetch(
        `http://127.0.0.1:${oauthServer.address().port}/auth/google/start`,
        { redirect: "manual" },
      ),
      location = new URL(response.headers.get("location")),
      state = location.searchParams.get("state"),
      saved = oauthDb
        .prepare("SELECT * FROM oauth_states WHERE hash=?")
        .get(hash(state));
    assert.equal(response.status, 302);
    assert.equal(location.origin, "https://accounts.google.com");
    assert.equal(location.pathname, "/o/oauth2/v2/auth");
    assert.equal(location.searchParams.get("client_id"), "google-client-id");
    assert.equal(location.searchParams.get("response_type"), "code");
    assert.equal(
      location.searchParams.get("redirect_uri"),
      "https://ritm.example/auth/google/callback",
    );
    assert.equal(location.searchParams.get("scope"), "openid email profile");
    assert.equal(location.searchParams.get("prompt"), "select_account");
    assert.equal(location.searchParams.get("nonce"), state);
    assert.equal(location.searchParams.get("code_challenge_method"), "S256");
    assert.equal(
      location.searchParams.get("code_challenge"),
      createHash("sha256").update(saved.verifier).digest("base64url"),
    );
    assert.match(response.headers.get("set-cookie"), /ritm_oauth=/);
    assert.match(response.headers.get("set-cookie"), /HttpOnly/i);
    assert.match(response.headers.get("set-cookie"), /Secure/i);
    assert.match(response.headers.get("set-cookie"), /SameSite=Lax/i);
    assert.match(response.headers.get("set-cookie"), /Path=\/auth/i);
  } finally {
    await new Promise((resolve) => oauthServer.close(resolve));
    oauthDb.close();
  }
});

test("Google callback is one-time, browser-bound and isolates two subjects", async () => {
  const oauthDb = openDatabase(":memory:"),
    oauthConfig = {
      production: false,
      origin: "http://localhost:4310",
      demo: false,
      sandbox: false,
      encryptionConfigured: true,
      googleId: "google-client-id",
      googleSecret: "google-client-secret",
    };
  let expectedState = "",
    subject = "subject-a",
    emailVerified = true,
    nonceOverride = null,
    jwtExpired = false,
    exchangeCalls = 0;
  const oauthServer = createApp({
    db: oauthDb,
    config: oauthConfig,
    key: randomBytes(32),
    oauthExchange: async (provider, code, saved, receivedConfig) => {
      exchangeCalls++;
      assert.equal(provider, "google");
      assert.equal(code, "authorization-code");
      assert.ok(saved.verifier);
      assert.equal(receivedConfig, oauthConfig);
      return {
        id_token: "verified-by-test-double",
        access_token: "google-access-token-must-not-be-stored",
        refresh_token: "google-refresh-token-must-not-be-stored",
      };
    },
    googleVerifier: async (idToken, audience) => {
      assert.equal(idToken, "verified-by-test-double");
      assert.equal(audience, "google-client-id");
      if (jwtExpired) {
        const error = new Error("expired");
        error.name = "JWTExpired";
        error.code = "ERR_JWT_EXPIRED";
        throw error;
      }
      return {
        payload: {
          nonce: nonceOverride || expectedState,
          sub: subject,
          email_verified: emailVerified,
          name: subject === "subject-a" ? "Алиса" : "Борис",
        },
      };
    },
  }).listen(0, "127.0.0.1");
  await new Promise((resolve) => oauthServer.once("listening", resolve));
  const oauthBase = `http://127.0.0.1:${oauthServer.address().port}`;
  async function begin() {
    const response = await fetch(oauthBase + "/auth/google/start", {
        redirect: "manual",
      }),
      location = new URL(response.headers.get("location"));
    return {
      state: location.searchParams.get("state"),
      cookie: response.headers.get("set-cookie").match(/ritm_oauth=[^;]+/)[0],
    };
  }
  async function finish(flow, cookie = flow.cookie) {
    expectedState = flow.state;
    return fetch(
      `${oauthBase}/auth/google/callback?state=${encodeURIComponent(flow.state)}&code=authorization-code`,
      { headers: { Cookie: cookie }, redirect: "manual" },
    );
  }
  try {
    const firstFlow = await begin(),
      wrongBrowser = await finish(firstFlow, "ritm_oauth=wrong");
    assert.equal(wrongBrowser.status, 400);
    assert.equal(exchangeCalls, 0);
    assert.ok(
      oauthDb
        .prepare("SELECT 1 FROM oauth_states WHERE hash=?")
        .get(hash(firstFlow.state)),
    );

    const firstCallback = await finish(firstFlow),
      firstCookie = firstCallback.headers
        .get("set-cookie")
        .match(/ritm_session=[^;]+/)[0];
    assert.equal(firstCallback.status, 302);
    assert.equal(exchangeCalls, 1);
    assert.equal(
      oauthDb
        .prepare(
          "SELECT count(*) AS n FROM connections WHERE provider='google'",
        )
        .get().n,
      0,
    );
    const sessionResponse = await fetch(oauthBase + "/api/session", {
        headers: { Cookie: firstCookie },
      }),
      sessionBody = await sessionResponse.json();
    assert.equal(sessionResponse.status, 200);
    assert.deepEqual(Object.keys(sessionBody.user).sort(), [
      "demo",
      "id",
      "name",
    ]);
    assert.doesNotMatch(
      JSON.stringify(sessionBody),
      /google-(?:access|refresh)-token/,
    );
    assert.equal(
      oauthDb
        .prepare("SELECT count(*) AS n FROM oauth_states WHERE hash=?")
        .get(hash(firstFlow.state)).n,
      0,
    );
    assert.equal((await finish(firstFlow)).status, 400);
    assert.equal(exchangeCalls, 1);

    subject = "subject-b";
    const secondFlow = await begin(),
      secondCallback = await finish(secondFlow),
      secondCookie = secondCallback.headers
        .get("set-cookie")
        .match(/ritm_session=[^;]+/)[0],
      users = oauthDb
        .prepare("SELECT id,subject FROM users ORDER BY subject")
        .all();
    assert.equal(secondCallback.status, 302);
    assert.deepEqual(
      users.map((user) => user.subject),
      ["google:subject-a", "google:subject-b"],
    );
    oauthDb
      .prepare("INSERT INTO businesses VALUES(?,?,?,1)")
      .run("business-a", users[0].id, JSON.stringify({ name: "Бизнес А" }));
    oauthDb
      .prepare("INSERT INTO businesses VALUES(?,?,?,1)")
      .run("business-b", users[1].id, JSON.stringify({ name: "Бизнес Б" }));
    const firstBusinesses = await fetch(oauthBase + "/api/businesses", {
        headers: { Cookie: firstCookie },
      }),
      secondBusinesses = await fetch(oauthBase + "/api/businesses", {
        headers: { Cookie: secondCookie },
      });
    assert.deepEqual(await firstBusinesses.json(), [
      { id: "business-a", name: "Бизнес А" },
    ]);
    assert.deepEqual(await secondBusinesses.json(), [
      { id: "business-b", name: "Бизнес Б" },
    ]);

    subject = "subject-unverified";
    emailVerified = false;
    const unverifiedFlow = await begin();
    assert.equal((await finish(unverifiedFlow)).status, 401);
    assert.equal(
      oauthDb
        .prepare("SELECT count(*) AS n FROM users WHERE subject=?")
        .get("google:subject-unverified").n,
      0,
    );

    subject = "subject-wrong-nonce";
    emailVerified = true;
    nonceOverride = "another-login-attempt";
    const wrongNonceFlow = await begin();
    assert.equal((await finish(wrongNonceFlow)).status, 401);
    assert.equal(
      oauthDb
        .prepare("SELECT count(*) AS n FROM users WHERE subject=?")
        .get("google:subject-wrong-nonce").n,
      0,
    );
    nonceOverride = null;

    const expiredFlow = await begin();
    oauthDb
      .prepare("UPDATE oauth_states SET expires_at=0 WHERE hash=?")
      .run(hash(expiredFlow.state));
    assert.equal((await finish(expiredFlow)).status, 400);
    assert.equal(exchangeCalls, 4);

    jwtExpired = true;
    const expiredTokenFlow = await begin(),
      expiredTokenResponse = await finish(expiredTokenFlow);
    assert.equal(expiredTokenResponse.status, 302);
    assert.equal(
      expiredTokenResponse.headers.get("location"),
      "/?authError=google-token-expired",
    );
    assert.match(
      expiredTokenResponse.headers.get("set-cookie"),
      /ritm_oauth=;/,
    );
  } finally {
    await new Promise((resolve) => oauthServer.close(resolve));
    oauthDb.close();
  }
});

test("Yandex OAuth uses the fixed verification-code redirect", async () => {
  const oauthDb = openDatabase(":memory:"),
    oauthConfig = {
      production: false,
      origin: "http://localhost:4310",
      demo: true,
      sandbox: false,
      encryptionConfigured: true,
      yandexId: "client-id",
      yandexSecret: "client-secret",
    },
    oauthServer = createApp({
      db: oauthDb,
      config: oauthConfig,
      key: randomBytes(32),
    }).listen(0, "127.0.0.1");
  await new Promise((resolve) => oauthServer.once("listening", resolve));
  const oauthBase = "http://127.0.0.1:" + oauthServer.address().port,
    userId = randomUUID(),
    businessId = randomUUID(),
    session = randomBytes(32).toString("base64url");
  oauthDb
    .prepare("INSERT INTO users VALUES(?,?,?,?)")
    .run(userId, "google:test", "Tester", new Date().toISOString());
  oauthDb
    .prepare("INSERT INTO sessions VALUES(?,?,?)")
    .run(hash(session), userId, Date.now() + 60000);
  oauthDb
    .prepare("INSERT INTO businesses VALUES(?,?,?,1)")
    .run(businessId, userId, JSON.stringify({ mode: "live" }));
  try {
    const start = await fetch(
      `${oauthBase}/auth/yandex/start?businessId=${businessId}`,
      { headers: { Cookie: `ritm_session=${session}` }, redirect: "manual" },
    );
    assert.equal(start.status, 302);
    const location = new URL(start.headers.get("location"));
    assert.equal(location.origin, "https://oauth.yandex.ru");
    assert.equal(location.searchParams.get("response_type"), "code");
    assert.equal(location.searchParams.get("force_confirm"), "yes");
    assert.equal(
      location.searchParams.get("redirect_uri"),
      "https://oauth.yandex.ru/verification_code",
    );
    assert.ok(location.searchParams.get("state"));
    assert.ok(location.searchParams.get("device_id"));
    assert.equal(
      location.searchParams.get("device_name"),
      "Ритм · рекламный кабинет",
    );
    assert.match(start.headers.get("set-cookie"), /Path=\/(?:;|$)/);
    const complete = await fetch(
      `${oauthBase}/api/businesses/${businessId}/yandex/oauth/complete`,
      {
        method: "POST",
        headers: {
          Cookie: `ritm_session=${session}`,
          Origin: oauthConfig.origin,
          "Content-Type": "application/json",
          "X-Ritm-Request": "1",
        },
        body: JSON.stringify({ code: "abcd" }),
      },
    );
    assert.equal(complete.status, 400);
    assert.match((await complete.json()).error, /снова откройте Яндекс/);
  } finally {
    await new Promise((resolve) => oauthServer.close(resolve));
    oauthDb.close();
  }
});
test("disconnect revokes token, deletes connection and cancels pending reports", async () => {
  const localDb = openDatabase(":memory:"),
    localKey = randomBytes(32),
    localConfig = {
      ...config,
      yandexId: "client-id",
      yandexSecret: "client-secret",
      encryptionConfigured: true,
    },
    userId = randomUUID(),
    businessId = randomUUID(),
    session = randomBytes(32).toString("base64url"),
    reportId = randomUUID(),
    calls = [];
  localDb
    .prepare("INSERT INTO users VALUES(?,?,?,?)")
    .run(userId, "google:disconnect", "Tester", new Date().toISOString());
  localDb
    .prepare("INSERT INTO sessions VALUES(?,?,?)")
    .run(hash(session), userId, Date.now() + 60000);
  const state = seedDemo();
  state.mode = "live";
  localDb
    .prepare("INSERT INTO businesses VALUES(?,?,?,1)")
    .run(businessId, userId, JSON.stringify(state));
  localDb
    .prepare("INSERT INTO connections VALUES(?,?,?,?)")
    .run(
      businessId,
      "yandex",
      encrypt(
        { access_token: "token-to-revoke" },
        localKey,
        businessId + ":yandex",
      ),
      JSON.stringify({ clients: [], sandbox: false }),
    );
  localDb
    .prepare(
      "INSERT INTO jobs(id,business_id,kind,status,available_at,attempts,payload) VALUES(?,?,'report_sync','pending',?,0,'{}')",
    )
    .run(reportId, businessId, Date.now());
  const localServer = createApp({
    db: localDb,
    config: localConfig,
    key: localKey,
    revokeToken: async (...args) => {
      calls.push(args);
      return { status: "ok" };
    },
  }).listen(0, "127.0.0.1");
  await new Promise((resolve) => localServer.once("listening", resolve));
  try {
    const response = await fetch(
      `http://127.0.0.1:${localServer.address().port}/api/businesses/${businessId}/connections/yandex/disconnect`,
      {
        method: "POST",
        headers: {
          Cookie: `ritm_session=${session}`,
          Origin: localConfig.origin,
          "X-Ritm-Request": "1",
          "Content-Type": "application/json",
        },
        body: "{}",
      },
    );
    assert.equal(response.status, 200);
    assert.equal((await response.json()).revoked, true);
    assert.deepEqual(calls[0], [
      "token-to-revoke",
      "client-id",
      "client-secret",
    ]);
    assert.equal(
      localDb
        .prepare("SELECT count(*) AS n FROM connections WHERE business_id=?")
        .get(businessId).n,
      0,
    );
    assert.equal(
      localDb.prepare("SELECT status FROM jobs WHERE id=?").get(reportId)
        .status,
      "cancelled",
    );
  } finally {
    await new Promise((resolve) => localServer.close(resolve));
    localDb.close();
  }
});

test("pending Yandex connection can refresh Direct clients without new OAuth", async () => {
  const localDb = openDatabase(":memory:"),
    localKey = randomBytes(32),
    localConfig = {
      ...config,
      encryptionConfigured: true,
    },
    userId = randomUUID(),
    businessId = randomUUID(),
    session = randomBytes(32).toString("base64url"),
    calls = [],
    reads = [];
  localDb
    .prepare("INSERT INTO users VALUES(?,?,?,?)")
    .run(userId, "google:refresh", "Tester", new Date().toISOString());
  localDb
    .prepare("INSERT INTO sessions VALUES(?,?,?)")
    .run(hash(session), userId, Date.now() + 60000);
  const state = seedDemo();
  state.mode = "live";
  state.website = "https://example.test";
  state.counterId = "123";
  state.goalId = "456";
  localDb
    .prepare("INSERT INTO businesses VALUES(?,?,?,1)")
    .run(businessId, userId, JSON.stringify(state));
  localDb.prepare("INSERT INTO connections VALUES(?,?,?,?)").run(
    businessId,
    "yandex",
    encrypt({ access_token: "saved-token" }, localKey, businessId + ":yandex"),
    JSON.stringify({
      clients: [],
      sandbox: false,
      validation: "pending",
      connectionId: "connection-test",
    }),
  );
  const localServer = createApp({
    db: localDb,
    config: localConfig,
    key: localKey,
    directFactory: (options) => {
      calls.push(options);
      return {
        clients: async () => {
          reads.push("clients");
          return {
            Clients: [{ Login: "client-login", ClientId: 42, Currency: "RUB" }],
          };
        },
        campaigns: async () => {
          reads.push("campaigns");
          return { Campaigns: [] };
        },
      };
    },
  }).listen(0, "127.0.0.1");
  await new Promise((resolve) => localServer.once("listening", resolve));
  try {
    const response = await fetch(
      `http://127.0.0.1:${localServer.address().port}/api/businesses/${businessId}/provider/clients`,
      {
        headers: {
          Cookie: `ritm_session=${session}`,
          Origin: localConfig.origin,
        },
      },
    );
    assert.equal(response.status, 200);
    assert.equal((await response.json()).Clients[0].Login, "client-login");
    assert.equal(calls[0].accessToken, "saved-token");
    assert.equal(calls[0].sandbox, false);
    const metadata = JSON.parse(
      localDb
        .prepare("SELECT metadata FROM connections WHERE business_id=?")
        .get(businessId).metadata,
    );
    assert.equal(metadata.validation, "verified");
    assert.equal(metadata.clients[0].Currency, "RUB");
    const moscowDate = (days) =>
      new Intl.DateTimeFormat("sv-SE", {
        timeZone: "Europe/Moscow",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).format(new Date(Date.now() + days * 86_400_000));
    const queued = enqueueDirectDryRun(
      localDb,
      userId,
      businessId,
      randomUUID(),
      {
        login: "client-login",
        campaignName: "Read-only preflight test",
        website: "https://example.test",
        audience: "Тестовая аудитория",
        regionIds: [54],
        budget: 1000000,
        targetCpa: 100000,
        periodStart: moscowDate(2),
        periodEnd: moscowDate(16),
        counterId: "123",
        goalId: "456",
        ads: [
          {
            title: "Тестовое объявление",
            text: "Только подготовка команды",
            href: "https://example.test",
          },
        ],
        keywords: ["тестовая фраза"],
      },
    );
    const preflightUrl = `http://127.0.0.1:${localServer.address().port}/api/businesses/${businessId}/direct/${queued.id}/preflight`;
    const requestKey = randomUUID();
    const preflightRequest = () =>
      fetch(preflightUrl, {
        method: "POST",
        headers: {
          Cookie: `ritm_session=${session}`,
          Origin: localConfig.origin,
          "X-Ritm-Request": "1",
          "Content-Type": "application/json",
          "Idempotency-Key": requestKey,
        },
        body: "{}",
      });
    assert.equal((await preflightRequest()).status, 409);
    assert.deepEqual(reads, ["clients"]);
    await runDirectCycle(localDb, { now: queued.availableAt });
    const preflightResponse = await preflightRequest();
    assert.equal(preflightResponse.status, 200);
    const report = await preflightResponse.json();
    assert.equal(report.ready, true);
    assert.equal(report.remote.writeCalls, 0);
    assert.deepEqual(reads, ["clients", "clients", "campaigns"]);
    assert.deepEqual(await (await preflightRequest()).json(), report);
    assert.deepEqual(reads, ["clients", "clients", "campaigns"]);
    const confirmationResponse = await fetch(
      preflightUrl.replace("/preflight", "/confirm"),
      {
        method: "POST",
        headers: {
          Cookie: `ritm_session=${session}`,
          Origin: localConfig.origin,
          "X-Ritm-Request": "1",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ planFingerprint: report.planFingerprint }),
      },
    );
    assert.equal(confirmationResponse.status, 200);
    const approval = await confirmationResponse.json();
    assert.equal(approval.externalWrites, 0);
    assert.equal(approval.planFingerprint, report.planFingerprint);
    assert.equal(
      localDb.prepare("SELECT count(*) AS n FROM direct_approvals").get().n,
      1,
    );
    assert.deepEqual(reads, ["clients", "clients", "campaigns"]);
  } finally {
    await new Promise((resolve) => localServer.close(resolve));
    localDb.close();
  }
});

test("expired Yandex token refreshes before a provider read", async () => {
  const localDb = openDatabase(":memory:"),
    localKey = randomBytes(32),
    localConfig = {
      ...config,
      encryptionConfigured: true,
      yandexId: "client-id",
      yandexSecret: "client-secret",
    },
    userId = randomUUID(),
    businessId = randomUUID(),
    session = randomBytes(32).toString("base64url"),
    directTokens = [];
  localDb
    .prepare("INSERT INTO users VALUES(?,?,?,?)")
    .run(userId, "google:token-refresh", "Tester", new Date().toISOString());
  localDb
    .prepare("INSERT INTO sessions VALUES(?,?,?)")
    .run(hash(session), userId, Date.now() + 60000);
  const state = seedDemo();
  state.mode = "live";
  localDb
    .prepare("INSERT INTO businesses VALUES(?,?,?,1)")
    .run(businessId, userId, JSON.stringify(state));
  localDb.prepare("INSERT INTO connections VALUES(?,?,?,?)").run(
    businessId,
    "yandex",
    encrypt(
      {
        access_token: "expired-access",
        refresh_token: "saved-refresh",
        expires_at: Date.now() - 1000,
      },
      localKey,
      businessId + ":yandex",
    ),
    JSON.stringify({
      connectionId: "stable-connection",
      clients: [],
      sandbox: false,
      validation: "verified",
    }),
  );
  let refreshCalls = 0;
  const localServer = createApp({
    db: localDb,
    config: localConfig,
    key: localKey,
    refreshToken: async () => {
      refreshCalls++;
      return {
        access_token: "fresh-access",
        refresh_token: "fresh-refresh",
        expires_in: 3600,
      };
    },
    directFactory: (options) => {
      directTokens.push(options.accessToken);
      return {
        clients: async () => ({
          Clients: [{ Login: "client-login", ClientId: 42, Currency: "RUB" }],
        }),
      };
    },
  }).listen(0, "127.0.0.1");
  await new Promise((resolve) => localServer.once("listening", resolve));
  try {
    const response = await fetch(
      `http://127.0.0.1:${localServer.address().port}/api/businesses/${businessId}/provider/clients`,
      { headers: { Cookie: `ritm_session=${session}` } },
    );
    assert.equal(response.status, 200);
    assert.equal((await response.json()).Clients[0].Login, "client-login");
    assert.equal(refreshCalls, 1);
    assert.deepEqual(directTokens, ["fresh-access"]);
    const metadata = JSON.parse(
      localDb
        .prepare("SELECT metadata FROM connections WHERE business_id=?")
        .get(businessId).metadata,
    );
    assert.equal(metadata.connectionId, "stable-connection");
    assert.ok(metadata.tokenRefreshedAt);
    const workspace = await fetch(
      `http://127.0.0.1:${localServer.address().port}/api/workspace?businessId=${businessId}`,
      { headers: { Cookie: `ritm_session=${session}` } },
    );
    assert.equal(workspace.status, 200);
    assert.equal(
      JSON.stringify(await workspace.json()).includes("stable-connection"),
      false,
    );
  } finally {
    await new Promise((resolve) => localServer.close(resolve));
    localDb.close();
  }
});

test("exhausted campaigns resume using newly added unallocated budget", async () => {
  const { cookie, ws } = await demo();
  for (let i = 0; i < 500 && ws.state.running; i++) tickDemo(ws.state);
  assert.ok(ws.state.campaigns.every((c) => c.status === "paused"));
  db.prepare("UPDATE businesses SET state=? WHERE id=?").run(
    JSON.stringify(ws.state),
    ws.id,
  );
  const path = `/api/businesses/${ws.id}/command`;
  assert.equal(
    (
      await send(path, {
        cookie,
        body: {
          action: "budget",
          payload: { budget: 5000000, targetCpa: 45000 },
        },
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await send(path, {
        cookie,
        body: { action: "campaign", payload: { id: ws.state.campaigns[0].id } },
      })
    ).status,
    200,
  );
  const current = (await send("/api/workspace", { cookie })).body;
  assert.equal(current.state.campaigns[0].status, "active");
  assert.ok(
    current.state.campaigns[0].allocation > current.state.campaigns[0].spent,
  );
  assertBudget(current.state);
  assert.equal(
    (await send(path, { cookie, body: { action: "toggle" } })).status,
    200,
  );
  assert.equal(
    (await send(path, { cookie, body: { action: "tick" } })).status,
    200,
  );
});

test("invalid calendar dates are rejected, leap day is accepted", async () => {
  const { cookie, ws } = await demo();
  const body = {
    ...ws.state,
    periodStart: "2026-02-30",
    periodEnd: "2026-03-15",
  };
  assert.equal((await send("/api/businesses", { cookie, body })).status, 400);
  body.periodStart = "2028-02-29";
  body.periodEnd = "2028-03-15";
  assert.equal((await send("/api/businesses", { cookie, body })).status, 201);
});

test("business website is optional", async () => {
  const { cookie, ws } = await demo();
  const created = await send("/api/businesses", {
    cookie,
    body: { ...ws.state, name: "Без сайта", website: "" },
  });
  assert.equal(created.status, 201);
  const current = await send(`/api/workspace?businessId=${created.body.id}`, {
    cookie,
  });
  assert.equal(current.status, 200);
  assert.equal(current.body.state.website, "");
});

test("Kie.ai image key is encrypted, never returned and enables prompt-free variants", async () => {
  const { cookie, ws } = await demo();
  const previousEncryption = config.encryptionConfigured,
    previousModel = config.kieImageModel;
  config.encryptionConfigured = true;
  config.kieImageModel = "gpt-image-2-5-flare-text-to-image";
  try {
    const saved = await send(`/api/businesses/${ws.id}/image-provider/kie`, {
      cookie,
      method: "PUT",
      body: { apiKey: "test-kie-key-not-a-real-secret-1234567890" },
    });
    assert.equal(saved.status, 200);
    const stored = db
      .prepare(
        "SELECT encrypted,metadata FROM connections WHERE business_id=? AND provider='kie-image'",
      )
      .get(ws.id);
    assert.doesNotMatch(stored.encrypted, /test-kie-key/);
    assert.doesNotMatch(stored.metadata, /test-kie-key/);
    const current = await send(`/api/workspace?businessId=${ws.id}`, {
      cookie,
    });
    assert.equal(current.body.capabilities.creativeImages, true);
    assert.equal(current.body.capabilities.creativeImageProvider, "kie");
    const connection = current.body.connections.find(
      (item) => item.provider === "kie-image",
    );
    assert.equal(connection.model, "gpt-image-2-5-flare-text-to-image");
    assert.deepEqual(connection.clients, []);
    assert.equal(connection.apiKey, undefined);
    const queued = await send(`/api/businesses/${ws.id}/creative-images`, {
      cookie,
      key: randomUUID(),
      body: {
        style: "editorial",
        goal: "leads",
        hook: "outcome",
        format: "standard",
        audience: "",
        brandPlacement: "none",
      },
    });
    assert.equal(queued.status, 202);
    assert.equal(queued.body.provider, "kie");
    assert.equal(queued.body.prompt, "Вариант по профилю бизнеса");
  } finally {
    config.encryptionConfigured = previousEncryption;
    config.kieImageModel = previousModel;
  }
});

test("CSV neutralizes formula prefixes and preserves quotes", async () => {
  const { cookie, ws } = await demo();
  ws.state.campaigns[0].name = "=1+1";
  ws.state.campaigns[1].name = "\t=2+2";
  ws.state.campaigns[2].name = "  +3";
  ws.state.campaigns[3].name = 'Имя; "кавычки"';
  db.prepare("UPDATE businesses SET state=? WHERE id=?").run(
    JSON.stringify(ws.state),
    ws.id,
  );
  const r = await fetch(base + `/api/businesses/${ws.id}/export`, {
    headers: { Cookie: cookie },
  });
  const csv = await r.text();
  assert.ok(csv.includes('"\'=1+1"'));
  assert.ok(csv.includes('"\'\t=2+2"'));
  assert.ok(csv.includes('"\'  +3"'));
  assert.ok(csv.includes('"Имя; ""кавычки"""'));
});

test("schedule settings are isolated and disabling cancels pending work", async () => {
  const { cookie, ws } = await demo(),
    other = await demo(),
    path = `/api/businesses/${ws.id}/command`;
  assert.equal(
    (
      await send(path, {
        cookie: other.cookie,
        body: { action: "schedule", payload: { enabled: true } },
      })
    ).status,
    404,
  );
  assert.equal(
    (
      await send(path, {
        cookie,
        body: { action: "schedule", payload: { enabled: true } },
      })
    ).status,
    200,
  );
  db.prepare(
    "INSERT INTO jobs VALUES(?,?,'shadow_analysis','pending',0,0,'{}',NULL)",
  ).run("test-schedule-job", ws.id);
  assert.equal(
    (
      await send(path, {
        cookie,
        body: { action: "schedule", payload: { enabled: false } },
      })
    ).status,
    200,
  );
  const current = (await send("/api/workspace", { cookie })).body;
  assert.equal(current.state.shadowAnalysis, false);
  assert.equal(current.jobs[0].status, "cancelled");
  assert.deepEqual(current.state.campaigns, ws.state.campaigns);
  assert.equal(
    (await send("/api/workspace", { cookie: other.cookie })).body.jobs.length,
    0,
  );
});

test("changing profile timezone does not redistribute campaign limits", async () => {
  const { cookie, ws } = await demo();
  const r = await send(`/api/businesses/${ws.id}/command`, {
    cookie,
    body: {
      action: "settings",
      payload: { ...ws.state, timezone: "Europe/Moscow" },
    },
  });
  assert.equal(r.status, 200);
  const current = (await send("/api/workspace", { cookie })).body;
  assert.equal(current.state.timezone, "Europe/Moscow");
  assert.deepEqual(current.state.campaigns, ws.state.campaigns);
});

test("full demo onboarding: analytics, approval, launch, simulation, CSV", async () => {
  const { cookie, ws } = await demo();
  const created = await send("/api/businesses", {
    cookie,
    body: { ...ws.state, name: "Новый бизнес" },
  });
  assert.equal(created.status, 201);
  const id = created.body.id,
    path = `/api/businesses/${id}/command`;
  assert.equal(
    (await send(path, { cookie, body: { action: "launch" } })).status,
    409,
  );
  assert.equal(
    (await send(path, { cookie, body: { action: "analytics" } })).status,
    200,
  );
  assert.equal(
    (await send(path, { cookie, body: { action: "launch" } })).status,
    409,
  );
  let current = (await send(`/api/workspace?businessId=${id}`, { cookie }))
    .body;
  assert.equal(
    (
      await send(path, {
        cookie,
        body: {
          action: "approve",
          payload: { id: current.state.creatives[0].id },
        },
      })
    ).status,
    200,
  );
  assert.equal(
    (await send(path, { cookie, body: { action: "launch" } })).status,
    200,
  );
  assert.equal(
    (await send(path, { cookie, body: { action: "tick" } })).status,
    200,
  );
  current = (await send(`/api/workspace?businessId=${id}`, { cookie })).body;
  assert.equal(current.state.campaigns.length, 2);
  assert.ok(current.totals.spent > 0);
  assertBudget(current.state);
  const exported = await fetch(base + `/api/businesses/${id}/export`, {
    headers: { Cookie: cookie },
  });
  assert.equal(exported.status, 200);
  assert.match(exported.headers.get("content-type"), /text\/csv/);
  assert.ok((await exported.text()).length > 100);
});
