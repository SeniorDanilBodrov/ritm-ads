import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { openDatabase } from "../server/db.js";
import { createApp } from "../server/app.js";
import { analyzeSnapshot } from "../server/advisor.js";
import { seedDemo } from "../server/engine.js";
let db,
  server,
  base,
  hook,
  calls = 0;
const config = {
  origin: "http://localhost:4310",
  demo: true,
  production: false,
};
before(async () => {
  db = openDatabase(":memory:");
  server = createApp({
    db,
    config,
    key: randomBytes(32),
    analyst: async (state) => {
      calls++;
      if (hook) await hook();
      return {
        provider: "rules",
        version: "test",
        executed: false,
        proposals: [
          {
            campaignId: state.campaigns[0].id,
            action: "observe",
            summary: "Наблюдать",
            requiresReview: true,
          },
        ],
      };
    },
  }).listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  base = "http://127.0.0.1:" + server.address().port;
});
after(async () => {
  await new Promise((r) => server.close(r));
  db.close();
});
async function send(path, cookie = "", body, key = randomUUID()) {
  const r = await fetch(base + path, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      Cookie: cookie,
      Origin: config.origin,
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
  const { cookie } = await send("/api/demo", "", {});
  return { cookie, ws: (await send("/api/workspace", cookie)).body };
}
test("analysis is read-only for money and campaigns, logged once on retry", async () => {
  const { cookie, ws } = await demo(),
    key = randomUUID(),
    start = calls,
    path = `/api/businesses/${ws.id}/analyze`;
  const first = await send(path, cookie, {}, key),
    second = await send(path, cookie, {}, key);
  assert.equal(first.status, 200);
  assert.deepEqual(first.body, second.body);
  assert.equal(calls, start + 1);
  const current = (await send("/api/workspace", cookie)).body;
  assert.deepEqual(current.state.campaigns, ws.state.campaigns);
  assert.equal(current.state.budget, ws.state.budget);
  assert.equal(current.state.analysis.executed, false);
  assert.equal(current.state.analysis.stateVersion, current.version);
  assert.equal(current.events.filter((e) => e.kind === "analysis").length, 1);
});
test("analysis ownership checked before invoking analyst", async () => {
  const a = await demo(),
    b = await demo(),
    start = calls;
  assert.equal(
    (await send(`/api/businesses/${a.ws.id}/analyze`, b.cookie, {})).status,
    404,
  );
  assert.equal(calls, start);
});
test("concurrent changes reject stale analysis without saving it", async () => {
  const { cookie, ws } = await demo();
  hook = async () => {
    await send(`/api/businesses/${ws.id}/command`, cookie, { action: "tick" });
  };
  try {
    const r = await send(`/api/businesses/${ws.id}/analyze`, cookie, {});
    assert.equal(r.status, 409);
    assert.equal(r.body.code, "stale_analysis");
  } finally {
    hook = null;
  }
  const current = (await send("/api/workspace", cookie)).body;
  assert.equal(current.state.analysis, undefined);
  assert.equal(current.events.filter((e) => e.kind === "analysis").length, 0);
});
test("only one active analysis per user; completion releases the slot", async () => {
  const { cookie, ws } = await demo();
  let release, started;
  const ready = new Promise((r) => (started = r));
  hook = () => {
    started();
    return new Promise((r) => (release = r));
  };
  const first = send(`/api/businesses/${ws.id}/analyze`, cookie, {});
  await ready;
  try {
    assert.equal(
      (await send(`/api/businesses/${ws.id}/analyze`, cookie, {})).status,
      429,
    );
  } finally {
    hook = null;
    release();
  }
  assert.equal((await first).status, 200);
  assert.equal(
    (await send(`/api/businesses/${ws.id}/analyze`, cookie, {})).status,
    200,
  );
});
test("analyst failure leaves state intact and releases the slot", async () => {
  const { cookie, ws } = await demo();
  hook = () => {
    throw new Error("fake provider failure");
  };
  try {
    assert.equal(
      (await send(`/api/businesses/${ws.id}/analyze`, cookie, {})).status,
      500,
    );
  } finally {
    hook = null;
  }
  const current = (await send("/api/workspace", cookie)).body;
  assert.equal(current.version, ws.version);
  assert.deepEqual(current.state, ws.state);
  assert.equal(
    (await send(`/api/businesses/${ws.id}/analyze`, cookie, {})).status,
    200,
  );
});
test(
  "real Node to Python protocol returns validated Russian recommendations",
  { skip: !process.env.PYTHON_EXECUTABLE },
  async () => {
    const state = seedDemo(),
      copy = structuredClone(state),
      report = await analyzeSnapshot(state);
    assert.equal(report.provider, "rules");
    assert.equal(report.executed, false);
    assert.equal(report.proposals.length, 4);
    assert.match(report.proposals[0].summary, /[а-я]/i);
    assert.deepEqual(state, copy);
    assert.equal(report.proposals[0].evidence.spent, state.campaigns[0].spent);
  },
);
