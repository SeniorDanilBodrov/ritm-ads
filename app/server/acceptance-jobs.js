import { randomUUID } from "node:crypto";
import { event, transaction } from "./db.js";
import { runAcceptanceSimulation } from "./acceptance-simulation.js";

const KIND = "acceptance_run";
const LEASE_MS = 60_000;
const MAX_ATTEMPTS = 3;

function parsePayload(value) {
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}

function publicRun(row) {
  const payload = parsePayload(row.payload);
  return {
    id: row.id,
    status: row.status,
    stage: payload.stage || (row.status === "pending" ? "queued" : row.status),
    attempts: Number(row.attempts) || 0,
    availableAt:
      Number(row.availableAt ?? row.availableat ?? row.available_at) || 0,
    queuedAt: payload.queuedAt || null,
    startedAt: payload.startedAt || null,
    completedAt: payload.completedAt || null,
    error: row.error || null,
    report: payload.report || null,
  };
}

function payloadFor(business, plan, now) {
  return {
    version: "acceptance-run/2",
    stage: "queued",
    queuedAt: new Date(now).toISOString(),
    startedAt: null,
    completedAt: null,
    source: {
      business: structuredClone(business),
      plan: structuredClone(plan),
    },
    report: null,
  };
}

export function enqueueAcceptanceRunSync(db, business, plan, now = Date.now()) {
  const active = db
    .prepare(
      "SELECT * FROM jobs WHERE business_id=? AND kind=? AND status IN ('pending','running') ORDER BY rowid DESC LIMIT 1",
    )
    .get(business.id, KIND);
  if (active) return publicRun(active);
  const id = randomUUID();
  db.prepare(
    "INSERT INTO jobs(id,business_id,kind,status,available_at,attempts,payload,error) VALUES(?,?,?,'pending',?,0,?,NULL)",
  ).run(
    id,
    business.id,
    KIND,
    now,
    JSON.stringify(payloadFor(business.state, plan, now)),
  );
  return publicRun({
    id,
    status: "pending",
    attempts: 0,
    available_at: now,
    payload: JSON.stringify(payloadFor(business.state, plan, now)),
    error: null,
  });
}

export async function enqueueAcceptanceRunPostgres(
  tx,
  business,
  plan,
  now = Date.now(),
) {
  const active = await tx
    .prepare(
      "SELECT * FROM jobs WHERE business_id=? AND kind=? AND status IN ('pending','running') ORDER BY ctid DESC LIMIT 1",
    )
    .get(business.id, KIND);
  if (active) return publicRun(active);
  const id = randomUUID();
  const payload = payloadFor(business.state, plan, now);
  await tx
    .prepare(
      "INSERT INTO jobs(id,business_id,kind,status,available_at,attempts,payload,error) VALUES(?,?,?,'pending',?,0,?,NULL)",
    )
    .run(id, business.id, KIND, now, JSON.stringify(payload));
  return publicRun({
    id,
    status: "pending",
    attempts: 0,
    available_at: now,
    payload: JSON.stringify(payload),
    error: null,
  });
}

export function acceptanceRunsSync(db, businessId) {
  return db
    .prepare(
      "SELECT id,status,attempts,available_at AS availableAt,error,payload FROM jobs WHERE business_id=? AND kind=? ORDER BY rowid DESC LIMIT 5",
    )
    .all(businessId, KIND)
    .map(publicRun);
}

export async function acceptanceRunsPostgres(db, businessId) {
  const rows = await db
    .prepare(
      "SELECT id,status,attempts,available_at AS availableAt,error,payload FROM jobs WHERE business_id=? AND kind=? ORDER BY ctid DESC LIMIT 5",
    )
    .all(businessId, KIND);
  return rows.map(publicRun);
}

async function writeEvent(db, businessId, payload) {
  const value = {
    id: randomUUID(),
    at: new Date().toISOString(),
    ...payload,
  };
  await db
    .prepare("INSERT INTO events VALUES(?,?,?,?)")
    .run(value.id, businessId, value.at, JSON.stringify(value));
}

function claimSync(db, now) {
  return transaction(db, () => {
    db.prepare(
      `UPDATE jobs SET
         status=CASE WHEN attempts>=? THEN 'failed' ELSE 'pending' END,
         error=CASE WHEN attempts>=? THEN 'Тестовый прогон прервался три раза. Запустите новый прогон.' ELSE NULL END,
         available_at=?
       WHERE kind=? AND status='running' AND available_at<=?`,
    ).run(MAX_ATTEMPTS, MAX_ATTEMPTS, now, KIND, now);
    const row = db
      .prepare(
        "SELECT * FROM jobs WHERE kind=? AND status='pending' AND available_at<=? ORDER BY available_at,rowid LIMIT 1",
      )
      .get(KIND, now);
    if (!row) return null;
    const payload = {
      ...parsePayload(row.payload),
      stage: "running",
      startedAt:
        parsePayload(row.payload).startedAt || new Date(now).toISOString(),
    };
    db.prepare(
      "UPDATE jobs SET status='running',attempts=attempts+1,available_at=?,payload=?,error=NULL WHERE id=?",
    ).run(now + LEASE_MS, JSON.stringify(payload), row.id);
    return {
      ...row,
      payload: JSON.stringify(payload),
      attempts: row.attempts + 1,
    };
  });
}

async function claimPostgres(db, now) {
  return db.transaction(async (tx) => {
    await tx
      .prepare(
        `UPDATE jobs SET
           status=CASE WHEN attempts>=? THEN 'failed' ELSE 'pending' END,
           error=CASE WHEN attempts>=? THEN 'Тестовый прогон прервался три раза. Запустите новый прогон.' ELSE NULL END,
           available_at=?
         WHERE kind=? AND status='running' AND available_at<=?`,
      )
      .run(MAX_ATTEMPTS, MAX_ATTEMPTS, now, KIND, now);
    const row = await tx
      .prepare(
        "SELECT * FROM jobs WHERE kind=? AND status='pending' AND available_at<=? ORDER BY available_at,ctid LIMIT 1 FOR UPDATE SKIP LOCKED",
      )
      .get(KIND, now);
    if (!row) return null;
    const current = parsePayload(row.payload);
    const payload = {
      ...current,
      stage: "running",
      startedAt: current.startedAt || new Date(now).toISOString(),
    };
    await tx
      .prepare(
        "UPDATE jobs SET status='running',attempts=attempts+1,available_at=?,payload=?,error=NULL WHERE id=?",
      )
      .run(now + LEASE_MS, JSON.stringify(payload), row.id);
    return {
      ...row,
      payload: JSON.stringify(payload),
      attempts: Number(row.attempts) + 1,
    };
  });
}

function ownsSync(db, job) {
  return db
    .prepare(
      "SELECT id FROM jobs WHERE id=? AND status='running' AND attempts=?",
    )
    .get(job.id, job.attempts);
}

async function completeSync(db, job, payload, report, now) {
  return transaction(db, () => {
    if (!ownsSync(db, job)) return { status: "lease_lost", id: job.id };
    const completed = {
      ...payload,
      stage: "complete",
      completedAt: new Date(now).toISOString(),
      report,
    };
    db.prepare(
      "UPDATE jobs SET status='succeeded',available_at=?,payload=?,error=NULL WHERE id=?",
    ).run(now, JSON.stringify(completed), job.id);
    event(db, job.business_id, {
      kind: "acceptance_run",
      title: "Тестовый прогон завершён",
      reason: `${report.checks.length} проверок пройдено на изолированной копии. Рабочая реклама не менялась.`,
      rule: "acceptance-run/2",
      jobId: job.id,
      acceptanceRun: report,
    });
    return { status: "succeeded", id: job.id, report };
  });
}

async function completePostgres(db, job, payload, report, now) {
  return db.transaction(async (tx) => {
    const owner = await tx
      .prepare(
        "SELECT id FROM jobs WHERE id=? AND status='running' AND attempts=? FOR UPDATE",
      )
      .get(job.id, job.attempts);
    if (!owner) return { status: "lease_lost", id: job.id };
    const completed = {
      ...payload,
      stage: "complete",
      completedAt: new Date(now).toISOString(),
      report,
    };
    await tx
      .prepare(
        "UPDATE jobs SET status='succeeded',available_at=?,payload=?,error=NULL WHERE id=?",
      )
      .run(now, JSON.stringify(completed), job.id);
    await writeEvent(tx, job.business_id, {
      kind: "acceptance_run",
      title: "Тестовый прогон завершён",
      reason: `${report.checks.length} проверок пройдено на изолированной копии. Рабочая реклама не менялась.`,
      rule: "acceptance-run/2",
      jobId: job.id,
      acceptanceRun: report,
    });
    return { status: "succeeded", id: job.id, report };
  });
}

async function failSync(db, job, payload, now) {
  return transaction(db, () => {
    if (!ownsSync(db, job)) return { status: "lease_lost", id: job.id };
    const failed = job.attempts >= MAX_ATTEMPTS;
    const status = failed ? "failed" : "pending";
    const error = failed
      ? "Тестовый прогон не завершился после трёх попыток. Рабочая реклама не менялась."
      : "Прогон прервался. Ритм повторит его автоматически.";
    db.prepare(
      "UPDATE jobs SET status=?,available_at=?,payload=?,error=? WHERE id=?",
    ).run(
      status,
      failed ? now : now + 2_000,
      JSON.stringify({ ...payload, stage: failed ? "failed" : "queued" }),
      error,
      job.id,
    );
    return { status, id: job.id };
  });
}

async function failPostgres(db, job, payload, now) {
  return db.transaction(async (tx) => {
    const owner = await tx
      .prepare(
        "SELECT id FROM jobs WHERE id=? AND status='running' AND attempts=? FOR UPDATE",
      )
      .get(job.id, job.attempts);
    if (!owner) return { status: "lease_lost", id: job.id };
    const failed = job.attempts >= MAX_ATTEMPTS;
    const status = failed ? "failed" : "pending";
    const error = failed
      ? "Тестовый прогон не завершился после трёх попыток. Рабочая реклама не менялась."
      : "Прогон прервался. Ритм повторит его автоматически.";
    await tx
      .prepare(
        "UPDATE jobs SET status=?,available_at=?,payload=?,error=? WHERE id=?",
      )
      .run(
        status,
        failed ? now : now + 2_000,
        JSON.stringify({ ...payload, stage: failed ? "failed" : "queued" }),
        error,
        job.id,
      );
    return { status, id: job.id };
  });
}

export async function runAcceptanceCycle(db, { now = Date.now() } = {}) {
  const job = db.isAsync ? await claimPostgres(db, now) : claimSync(db, now);
  if (!job) return { status: "idle" };
  const payload = parsePayload(job.payload);
  try {
    if (!payload.source?.business || !payload.source?.plan)
      throw new Error("Acceptance snapshot is missing");
    const report = runAcceptanceSimulation(
      payload.source.business,
      payload.source.plan,
      now,
    );
    return db.isAsync
      ? completePostgres(db, job, payload, report, now)
      : completeSync(db, job, payload, report, now);
  } catch {
    return db.isAsync
      ? failPostgres(db, job, payload, now)
      : failSync(db, job, payload, now);
  }
}

export function startAcceptanceWorker(db) {
  let pending = null;
  let stopped = false;
  const tick = () => {
    if (stopped || pending) return;
    pending = runAcceptanceCycle(db)
      .catch(() => undefined)
      .finally(() => {
        pending = null;
      });
  };
  const timer = setInterval(tick, 2_000);
  timer.unref();
  tick();
  return async () => {
    stopped = true;
    clearInterval(timer);
    if (pending) await pending;
  };
}

export function acceptanceProtocol(run, businessName = "Бизнес") {
  if (!run?.report) return null;
  const report = run.report;
  const lines = [
    "ПРОТОКОЛ ТЕСТОВОГО ПРОГОНА «РИТМ»",
    "",
    `Бизнес: ${businessName}`,
    `План: ${report.source.planName}`,
    `Создан: ${report.createdAt}`,
    `Задание: ${run.id}`,
    "Режим: изолированная копия без внешних изменений",
    `Обращений к рекламным площадкам: ${report.providerCalls}`,
    `Записей во внешние системы: ${report.externalWrites}`,
    "",
    "ПРОВЕРКИ",
    ...report.checks.flatMap((check, index) => [
      `${index + 1}. ${check.title} — ПРОЙДЕНО`,
      `   ${check.detail}`,
    ]),
    "",
    `Итог: ${report.checks.length} из ${report.checks.length} проверок пройдено.`,
    "Этот протокол подтверждает работу изолированного сценария. Он не подтверждает модерацию или запуск рекламы в Яндекс Директе.",
  ];
  return lines.join("\r\n");
}
