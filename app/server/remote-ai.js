import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  advertisingPlanInputHash,
  validateAdvertisingPlan,
} from "./ai-plan.js";
import { attachAdvertisingPlan } from "./app.js";
import { AppError } from "./db.js";

export const REMOTE_AI_JOB_KIND = "remote_ai_plan";
const MAX_ATTEMPTS = 3;
const LEASE_MS = 12 * 60_000;

const resultSchema = z
  .object({
    provider: z.literal("ollama"),
    model: z.string().trim().regex(/^[\w.:-]{1,160}$/u),
    corrections: z.array(z.string().trim().max(240)).max(4).default([]),
    plan: z.unknown(),
  })
  .strict();

function planState(state) {
  return {
    name: state.name,
    category: state.category,
    city: state.city,
    website: state.website || "",
    service: state.service,
    benefit: state.benefit,
    price: state.price || 0,
    budget: state.budget,
    periodStart: state.periodStart,
    periodEnd: state.periodEnd,
  };
}

export function remoteAiEnabled(config) {
  return (
    config.aiProvider === "remote-ollama" &&
    typeof config.remoteAiWorkerToken === "string" &&
    config.remoteAiWorkerToken.length >= 32
  );
}

export function remotePlanJob(businessId, state, now = Date.now()) {
  const id = randomUUID();
  const inputHash = advertisingPlanInputHash(state);
  state.remoteAiPlan = {
    status: "pending",
    jobId: id,
    queuedAt: new Date(now).toISOString(),
  };
  return {
    id,
    businessId,
    availableAt: now,
    payload: JSON.stringify({ inputHash, queuedAt: now }),
  };
}

async function expireLeases(tx, now) {
  const expired = await tx
    .prepare(
      "SELECT id,business_id,attempts FROM jobs WHERE kind=? AND status='running' AND available_at<=? FOR UPDATE SKIP LOCKED",
    )
    .all(REMOTE_AI_JOB_KIND, now);
  for (const job of expired) {
    const terminal = Number(job.attempts) >= MAX_ATTEMPTS;
    await tx
      .prepare(
        "UPDATE jobs SET status=?,available_at=?,error=? WHERE id=? AND status='running'",
      )
      .run(
        terminal ? "failed" : "pending",
        terminal ? now : now + 15_000,
        terminal
          ? "Локальный помощник не завершил задачу после трёх попыток."
          : "Срок обработки истёк; задача возвращена в очередь.",
        job.id,
      );
    if (terminal) {
      const row = await tx
        .prepare("SELECT state,version FROM businesses WHERE id=? FOR UPDATE")
        .get(job.business_id);
      if (!row) continue;
      const state = JSON.parse(row.state);
      if (state.remoteAiPlan?.jobId !== job.id) continue;
      state.remoteAiPlan = {
        ...state.remoteAiPlan,
        status: "failed",
        finishedAt: new Date(now).toISOString(),
      };
      await tx
        .prepare("UPDATE businesses SET state=?,version=? WHERE id=?")
        .run(JSON.stringify(state), Number(row.version) + 1, job.business_id);
    }
  }
}

export async function claimRemotePlan(db, now = Date.now()) {
  return db.transaction(async (tx) => {
    await expireLeases(tx, now);
    const job = await tx
      .prepare(
        "SELECT * FROM jobs WHERE kind=? AND status='pending' AND available_at<=? ORDER BY available_at,id LIMIT 1 FOR UPDATE SKIP LOCKED",
      )
      .get(REMOTE_AI_JOB_KIND, now);
    if (!job) return null;
    const row = await tx
      .prepare("SELECT state FROM businesses WHERE id=?")
      .get(job.business_id);
    if (!row) {
      await tx
        .prepare("UPDATE jobs SET status='failed',error=? WHERE id=?")
        .run("Бизнес для задачи больше не существует.", job.id);
      return null;
    }
    const attempt = Number(job.attempts) + 1;
    await tx
      .prepare(
        "UPDATE jobs SET status='running',attempts=?,available_at=?,error=NULL WHERE id=?",
      )
      .run(attempt, now + LEASE_MS, job.id);
    const state = JSON.parse(row.state);
    const payload = JSON.parse(job.payload);
    return {
      kind: REMOTE_AI_JOB_KIND,
      id: job.id,
      attempt,
      inputHash: payload.inputHash,
      state: planState(state),
    };
  });
}

export async function completeRemotePlan(db, id, attempt, rawResult, now = Date.now()) {
  return db.transaction(async (tx) => {
    const job = await tx
      .prepare("SELECT * FROM jobs WHERE id=? AND kind=? FOR UPDATE")
      .get(id, REMOTE_AI_JOB_KIND);
    if (!job) throw new AppError(404, "Задача помощника не найдена.", "ai_job_missing");
    if (job.status !== "running" || Number(job.attempts) !== attempt)
      throw new AppError(409, "Эту задачу уже обрабатывает другой запуск помощника.", "ai_job_stale");
    const row = await tx
      .prepare("SELECT state,version FROM businesses WHERE id=? FOR UPDATE")
      .get(job.business_id);
    if (!row) throw new AppError(404, "Бизнес для задачи не найден.", "business_missing");
    const state = JSON.parse(row.state);
    const payload = JSON.parse(job.payload);
    if (advertisingPlanInputHash(state) !== payload.inputHash) {
      await tx
        .prepare("UPDATE jobs SET status='cancelled',available_at=?,error=? WHERE id=?")
        .run(now, "Данные бизнеса изменились; устаревший план не применён.", id);
      return { ok: true, applied: false, reason: "stale_input" };
    }
    const result = resultSchema.parse(rawResult);
    const plan = validateAdvertisingPlan(result.plan, state);
    attachAdvertisingPlan(state, {
      provider: "ollama",
      model: result.model,
      promptVersion: "remote-small-business-planner/1",
      inputHash: payload.inputHash,
      validation: { status: "passed", schema: "advertising-plan/2" },
      corrections: result.corrections,
      plan,
    });
    state.remoteAiPlan = {
      status: "ready",
      jobId: id,
      queuedAt: state.remoteAiPlan?.queuedAt || new Date(now).toISOString(),
      finishedAt: new Date(now).toISOString(),
    };
    await tx
      .prepare("UPDATE businesses SET state=?,version=? WHERE id=?")
      .run(JSON.stringify(state), Number(row.version) + 1, job.business_id);
    const eventId = randomUUID();
    const eventAt = new Date(now).toISOString();
    await tx
      .prepare("INSERT INTO events VALUES(?,?,?,?)")
      .run(
        eventId,
        job.business_id,
        eventAt,
        JSON.stringify({
          id: eventId,
          at: eventAt,
          kind: "ai_plan",
          title: "Рита уточнила рекламный план",
          reason: "Локальная модель подготовила варианты, а сервер проверил структуру и рекламные утверждения.",
          rule: "remote-ollama/validated",
        }),
      );
    await tx
      .prepare("UPDATE jobs SET status='succeeded',available_at=?,error=NULL WHERE id=?")
      .run(now, id);
    return { ok: true, applied: true };
  });
}

export async function failRemotePlan(db, id, attempt, now = Date.now()) {
  return db.transaction(async (tx) => {
    const job = await tx
      .prepare("SELECT * FROM jobs WHERE id=? AND kind=? FOR UPDATE")
      .get(id, REMOTE_AI_JOB_KIND);
    if (!job) throw new AppError(404, "Задача помощника не найдена.", "ai_job_missing");
    if (job.status !== "running" || Number(job.attempts) !== attempt)
      throw new AppError(409, "Задача уже была возвращена в очередь.", "ai_job_stale");
    const terminal = attempt >= MAX_ATTEMPTS;
    const delay = Math.min(5 * 60_000, 15_000 * 2 ** Math.max(0, attempt - 1));
    await tx
      .prepare("UPDATE jobs SET status=?,available_at=?,error=? WHERE id=?")
      .run(
        terminal ? "failed" : "pending",
        terminal ? now : now + delay,
        terminal
          ? "Локальная модель не подготовила проверяемый план."
          : "Локальная модель временно недоступна; повторим попытку.",
        id,
      );
    if (terminal) {
      const row = await tx
        .prepare("SELECT state,version FROM businesses WHERE id=? FOR UPDATE")
        .get(job.business_id);
      if (row) {
        const state = JSON.parse(row.state);
        if (state.remoteAiPlan?.jobId === id) {
          state.remoteAiPlan = {
            ...state.remoteAiPlan,
            status: "failed",
            finishedAt: new Date(now).toISOString(),
          };
          await tx
            .prepare("UPDATE businesses SET state=?,version=? WHERE id=?")
            .run(JSON.stringify(state), Number(row.version) + 1, job.business_id);
        }
      }
    }
    return { ok: true, retrying: !terminal };
  });
}
