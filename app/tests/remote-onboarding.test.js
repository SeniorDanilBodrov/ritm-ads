import { test } from "node:test";
import assert from "node:assert/strict";
import {
  claimRemoteOnboarding,
  completeRemoteOnboarding,
  failRemoteOnboarding,
  queueRemoteOnboarding,
  waitForRemoteOnboarding,
} from "../server/remote-onboarding.js";

test("remote onboarding bridges an active Rita request to Qwen", async () => {
  const history = [
    { role: "assistant", text: "Как называется ваш бизнес?" },
  ];
  const id = queueRemoteOnboarding("user-1", "Прокомп", {}, history);
  const job = claimRemoteOnboarding();
  assert.equal(job.id, id);
  assert.equal(job.kind, "remote_ai_onboarding");
  assert.equal(job.message, "Прокомп");
  assert.deepEqual(job.history, history);

  const completed = completeRemoteOnboarding(id, job.attempt, {
    reply: "Поняла. К какой сфере относится ваш бизнес?",
    profile: { name: "Прокомп" },
    complete: false,
    provider: "ollama",
  });
  assert.equal(completed.applied, true);
  const result = await waitForRemoteOnboarding(id, 100);
  assert.equal(result.provider, "ollama");
  assert.equal(result.profile.name, "Прокомп");
});

test("failed remote onboarding unblocks the deterministic fallback", async () => {
  const id = queueRemoteOnboarding("user-2", "Тест", {});
  const job = claimRemoteOnboarding();
  failRemoteOnboarding(id, job.attempt);
  assert.equal(await waitForRemoteOnboarding(id, 100), null);
});
