import { test } from "node:test";
import assert from "node:assert/strict";
import { remoteAiEnabled, remotePlanJob } from "../server/remote-ai.js";

const state = {
  name: "Студия «Форма»",
  category: "Студия маникюра",
  city: "Екатеринбург",
  website: "https://example.test",
  service: "Маникюр с покрытием",
  benefit: "Бережный уход и онлайн-запись",
  price: 1900,
  budget: 3_000_000,
  periodStart: "2026-11-05",
  periodEnd: "2026-11-30",
};

test("remote Ollama mode requires an explicit long worker token", () => {
  assert.equal(remoteAiEnabled({ aiProvider: "remote-ollama" }), false);
  assert.equal(
    remoteAiEnabled({
      aiProvider: "remote-ollama",
      remoteAiWorkerToken: "short",
    }),
    false,
  );
  assert.equal(
    remoteAiEnabled({
      aiProvider: "remote-ollama",
      remoteAiWorkerToken: "x".repeat(32),
    }),
    true,
  );
});

test("remote plan job stores only a fingerprint and marks the visible state pending", () => {
  const value = structuredClone(state);
  const job = remotePlanJob("business-1", value, 1_800_000_000_000);
  assert.equal(job.businessId, "business-1");
  assert.match(JSON.parse(job.payload).inputHash, /^[a-f0-9]{64}$/);
  assert.equal(job.payload.includes(state.name), false);
  assert.equal(value.remoteAiPlan.status, "pending");
  assert.equal(value.remoteAiPlan.jobId, job.id);
});
