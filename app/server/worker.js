import { createHash } from "node:crypto";
import { transaction, event } from "./db.js";
import { analyzeSnapshot } from "./advisor.js";

const INTERVAL = 3600000,
  LEASE = 60000,
  MAX_ATTEMPTS = 3;
const jobId = (id, version) =>
  "shadow:" +
  createHash("sha256")
    .update(id + ":" + version)
    .digest("hex");

// A durable, single-process shadow queue. It has no provider write capability.
export async function runShadowCycle(
  db,
  { now = Date.now(), analyst = analyzeSnapshot } = {},
) {
  const job = transaction(db, () => {
    for (const abandoned of db
      .prepare(
        "SELECT * FROM jobs WHERE kind='shadow_analysis' AND status='running' AND available_at<=?",
      )
      .all(now)) {
      const failed = abandoned.attempts >= MAX_ATTEMPTS;
      db.prepare("UPDATE jobs SET status=?,error=? WHERE id=?").run(
        failed ? "failed" : "pending",
        failed ? "Попытки исчерпаны после прерывания процесса." : null,
        abandoned.id,
      );
      if (failed)
        event(db, abandoned.business_id, {
          kind: "analysis_error",
          title: "Фоновый анализ не завершен",
          reason: "Три попытки прерваны. Реклама и лимиты не изменены.",
          rule: "shadow/1",
          jobId: abandoned.id,
        });
    }
    for (const b of db.prepare("SELECT * FROM businesses").all()) {
      const s = JSON.parse(b.state);
      if (
        !s.shadowAnalysis ||
        !s.campaigns.length ||
        s.analysis?.stateVersion === b.version
      )
        continue;
      const active = db
        .prepare(
          "SELECT id FROM jobs WHERE business_id=? AND kind='shadow_analysis' AND status IN ('pending','running')",
        )
        .get(b.id);
      if (active) continue;
      const last = db
        .prepare(
          "SELECT available_at FROM jobs WHERE business_id=? AND kind='shadow_analysis' AND status='succeeded' ORDER BY rowid DESC LIMIT 1",
        )
        .get(b.id);
      if (last && last.available_at + INTERVAL > now) continue;
      db.prepare(
        "INSERT OR IGNORE INTO jobs(id,business_id,kind,status,available_at,attempts,payload) VALUES(?,?,'shadow_analysis','pending',?,0,?)",
      ).run(
        jobId(b.id, b.version),
        b.id,
        now,
        JSON.stringify({ version: b.version }),
      );
    }
    const next = db
      .prepare(
        "SELECT * FROM jobs WHERE kind='shadow_analysis' AND status='pending' AND available_at<=? ORDER BY available_at,rowid LIMIT 1",
      )
      .get(now);
    if (!next) return null;
    db.prepare(
      "UPDATE jobs SET status='running',attempts=attempts+1,available_at=? WHERE id=?",
    ).run(now + LEASE, next.id);
    return { ...next, attempts: next.attempts + 1 };
  });
  if (!job) return { status: "idle" };
  const row = db
    .prepare("SELECT * FROM businesses WHERE id=?")
    .get(job.business_id);
  const snapshot = JSON.parse(row.state),
    version = JSON.parse(job.payload).version;
  const ownsLease = () =>
    db
      .prepare(
        "SELECT id FROM jobs WHERE id=? AND status='running' AND attempts=?",
      )
      .get(job.id, job.attempts);
  if (!snapshot.shadowAnalysis || row.version !== version) {
    db.prepare(
      "UPDATE jobs SET status='cancelled',error='Снимок устарел или расписание отключено.' WHERE id=? AND status='running' AND attempts=?",
    ).run(job.id, job.attempts);
    return { status: "cancelled", id: job.id };
  }
  try {
    const report = await analyst(snapshot);
    if (report.executed !== false || !Array.isArray(report.proposals))
      throw new Error("Invalid analyst result");
    return transaction(db, () => {
      if (!ownsLease()) return { status: "lease_lost", id: job.id };
      const current = db
          .prepare("SELECT * FROM businesses WHERE id=?")
          .get(job.business_id),
        state = JSON.parse(current.state);
      if (current.version !== version || !state.shadowAnalysis) {
        db.prepare(
          "UPDATE jobs SET status='cancelled',error='Данные изменились во время анализа.' WHERE id=?",
        ).run(job.id);
        return { status: "cancelled", id: job.id };
      }
      state.analysis = {
        ...report,
        createdAt: new Date(now).toISOString(),
        stateVersion: version + 1,
        source: "scheduled",
        jobId: job.id,
      };
      db.prepare(
        "UPDATE businesses SET state=?,version=version+1 WHERE id=?",
      ).run(JSON.stringify(state), job.business_id);
      event(db, job.business_id, {
        kind: "analysis",
        title: "Фоновый анализ готов",
        reason:
          "Проверен сохраненный снимок. Реклама, статистика и лимиты не изменены.",
        rule: report.version,
        jobId: job.id,
      });
      db.prepare(
        "UPDATE jobs SET status='succeeded',available_at=?,error=NULL WHERE id=?",
      ).run(now, job.id);
      return { status: "succeeded", id: job.id };
    });
  } catch {
    return transaction(db, () => {
      if (!ownsLease()) return { status: "lease_lost", id: job.id };
      const failed = job.attempts >= MAX_ATTEMPTS,
        status = failed ? "failed" : "pending";
      const reason = failed
        ? "Анализ не прошел после трех попыток. Проверьте Python или модель."
        : "Анализ недоступен. Назначена повторная попытка.";
      db.prepare(
        "UPDATE jobs SET status=?,available_at=?,error=? WHERE id=?",
      ).run(
        status,
        now + Math.min(300000, 15000 * 2 ** (job.attempts - 1)),
        reason,
        job.id,
      );
      if (failed)
        event(db, job.business_id, {
          kind: "analysis_error",
          title: "Фоновый анализ недоступен",
          reason,
          rule: "shadow/1",
          jobId: job.id,
        });
      return { status, id: job.id };
    });
  }
}

export function startShadowWorker(db) {
  let pending = null,
    stopped = false;
  const tick = () => {
    if (stopped || pending || !process.env.PYTHON_EXECUTABLE) return;
    pending = runShadowCycle(db)
      .catch(() =>
        console.error(JSON.stringify({ event: "shadow_worker_error" })),
      )
      .finally(() => (pending = null));
  };
  const timer = setInterval(tick, 5000);
  timer.unref();
  tick();
  return async () => {
    stopped = true;
    clearInterval(timer);
    if (pending) await pending;
  };
}
