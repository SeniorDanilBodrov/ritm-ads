import { randomUUID } from "node:crypto";
import { z } from "zod";

export const REMOTE_ONBOARDING_JOB_KIND = "remote_ai_onboarding";

const resultSchema = z
  .object({
    reply: z.string().trim().min(10).max(600),
    profile: z
      .object({
        name: z.string().trim().min(2).max(240).optional(),
        category: z.string().trim().min(2).max(240).optional(),
        city: z.string().trim().min(2).max(240).optional(),
        website: z.string().url().max(2048).optional(),
        service: z.string().trim().min(2).max(240).optional(),
        benefit: z.string().trim().min(2).max(240).optional(),
        price: z.number().int().min(0).max(10_000_000).optional(),
        budget: z.number().int().min(1_000).max(1_000_000).optional(),
      })
      .strict(),
    complete: z.boolean(),
    provider: z.literal("ollama"),
  })
  .strict();

// Onboarding happens before a business exists, so it cannot use the durable
// business job table. This short-lived broker only bridges the active HTTP
// request to the authenticated local worker. A timeout always falls back to
// the deterministic dialogue and never blocks creation of a business.
const jobs = new Map();
const MAX_JOB_AGE_MS = 90_000;

function discardExpired(now = Date.now()) {
  for (const [id, job] of jobs) {
    if (now - job.createdAt <= MAX_JOB_AGE_MS) continue;
    job.resolve(null);
    jobs.delete(id);
  }
}

export function queueRemoteOnboarding(
  userId,
  message,
  profile,
  history = [],
  now = Date.now(),
) {
  discardExpired(now);
  const id = `chat_${randomUUID()}`;
  let resolve;
  const completion = new Promise((done) => {
    resolve = done;
  });
  jobs.set(id, {
    id,
    userId,
    message,
    profile,
    history,
    status: "pending",
    attempt: 0,
    createdAt: now,
    resolve,
    completion,
  });
  return id;
}

export function claimRemoteOnboarding(now = Date.now()) {
  discardExpired(now);
  const job = [...jobs.values()].find((candidate) => candidate.status === "pending");
  if (!job) return null;
  job.status = "running";
  job.attempt += 1;
  return {
    kind: REMOTE_ONBOARDING_JOB_KIND,
    id: job.id,
    attempt: job.attempt,
    message: job.message,
    profile: job.profile,
    history: job.history,
  };
}

export async function waitForRemoteOnboarding(id, timeoutMs = 80_000) {
  const job = jobs.get(id);
  if (!job) return null;
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(null), timeoutMs);
    timer.unref?.();
  });
  const result = await Promise.race([job.completion, timeout]);
  clearTimeout(timer);
  jobs.delete(id);
  return result;
}

export function completeRemoteOnboarding(id, attempt, rawResult) {
  const job = jobs.get(id);
  if (!job) return { ok: true, applied: false, reason: "request_expired" };
  if (job.status !== "running" || job.attempt !== attempt)
    return { ok: true, applied: false, reason: "stale_attempt" };
  const result = resultSchema.parse(rawResult);
  job.resolve(result);
  return { ok: true, applied: true };
}

export function failRemoteOnboarding(id, attempt) {
  const job = jobs.get(id);
  if (!job) return { ok: true, retrying: false, reason: "request_expired" };
  if (job.status !== "running" || job.attempt !== attempt)
    return { ok: true, retrying: false, reason: "stale_attempt" };
  job.resolve(null);
  jobs.delete(id);
  return { ok: true, retrying: false };
}

export function isRemoteOnboardingJob(id) {
  return String(id).startsWith("chat_");
}
