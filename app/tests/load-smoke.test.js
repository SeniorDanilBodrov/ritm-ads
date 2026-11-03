import assert from "node:assert/strict";
import test from "node:test";
import { percentile, runLoadSmoke } from "../scripts/load-smoke.js";

test("load smoke measures bounded health/readiness requests", async () => {
  let calls = 0,
    time = 0;
  const result = await runLoadSmoke({
    baseUrl: "http://127.0.0.1:4310",
    requests: 20,
    concurrency: 4,
    maxP95Ms: 20,
    clock: () => (time += 2),
    fetcher: async (url) => {
      calls += 1;
      const ready = url.pathname === "/api/ready";
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true, ...(ready ? { ready: true } : {}) }),
      };
    },
  });
  assert.equal(calls, 20);
  assert.equal(result.requests, 20);
  assert.equal(result.failures, 0);
  assert.equal(result.passed, true);
});

test("load smoke fails on an unhealthy response or breached p95", async () => {
  let calls = 0,
    time = 0;
  const result = await runLoadSmoke({
    requests: 4,
    concurrency: 1,
    maxP95Ms: 1,
    clock: () => (time += 5),
    fetcher: async () => ({
      ok: ++calls !== 2,
      status: calls === 2 ? 503 : 200,
      json: async () => ({ ok: calls !== 2, ready: true }),
    }),
  });
  assert.equal(result.failures, 1);
  assert.equal(result.passed, false);
  assert.equal(percentile([30, 10, 20], 0.95), 30);
});
