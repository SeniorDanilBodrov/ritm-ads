import { createHash } from "node:crypto";
import { AppError, transaction } from "./db.js";
import { enqueueReport } from "./reports.js";
import { runLiveShadowReview } from "./live-shadow.js";
import { withYandexConnection } from "./oauth.js";
import { DirectClient, MetricaClient } from "./providers.js";
import { queueOptimizerAction } from "./optimizer-outbox.js";
import { executeOptimizerAction } from "./optimizer-executor.js";
import { canRunAutopilot } from "./live-ads.js";

const digest = (value) => createHash("sha256").update(value).digest("hex");
const stableUuid = (value) => {
  const hex = digest(value);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
};
const localDate = (now, timezone) =>
  new Intl.DateTimeFormat("sv-SE", {
    timeZone: timezone || "Europe/Moscow",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(now));
const plusDays = (date, days) =>
  new Date(Date.parse(`${date}T00:00:00Z`) + days * 86400000)
    .toISOString()
    .slice(0, 10);
const eligibleExecutions = (db, now) =>
  db
    .prepare(
      `
  SELECT de.business_id,de.change_id,de.connection_id,dc.plan_json,
         b.user_id,b.state,c.metadata
  FROM direct_executions de
  JOIN direct_changes dc ON dc.id=de.change_id
  JOIN businesses b ON b.id=de.business_id
  JOIN connections c ON c.business_id=b.id AND c.provider='yandex'
  WHERE de.status='succeeded'
`,
    )
    .all()
    .flatMap((row) => {
      const state = JSON.parse(row.state);
      const plan = JSON.parse(row.plan_json);
      const metadata = JSON.parse(row.metadata);
      const date = localDate(now, state.timezone);
      const graceEnd = [
        plusDays(plan.periodEnd, 2),
        plusDays(state.periodEnd, 2),
      ].sort()[0];
      if (
        state.mode !== "live" ||
        metadata.sandbox ||
        metadata.connectionId !== row.connection_id ||
        state.counterId !== plan.counterId ||
        state.goalId !== plan.goalId ||
        !metadata.clients?.some(
          (client) => client.Login === plan.login && client.Currency === "RUB",
        ) ||
        date < plan.periodStart ||
        date < state.periodStart ||
        date > graceEnd
      )
        return [];
      return [{ ...row, state, plan, metadata, date }];
    });

// Enqueue at most one Direct report per business, login and local calendar day.
export function scheduleLiveReports(db, now = Date.now()) {
  let queued = 0;
  const seen = new Set();
  for (const item of eligibleExecutions(db, now)) {
    const scope = `${item.business_id}:${item.plan.login}:${item.date}`;
    if (seen.has(scope)) continue;
    seen.add(scope);
    const key = stableUuid(`live-report:${scope}`);
    if (
      db
        .prepare("SELECT 1 FROM commands WHERE business_id=? AND key=?")
        .get(item.business_id, key)
    )
      continue;
    const latest = db
      .prepare(
        `SELECT rs.received_at,rs.date_to FROM report_snapshots rs
      JOIN jobs j ON j.id=rs.job_id
      WHERE rs.business_id=? AND rs.source='yandex' AND rs.login=?
        AND json_extract(j.payload,'$.signature')=?
        AND COALESCE(json_extract(j.payload,'$.reportType'),'campaign')='campaign'
      ORDER BY rs.rowid DESC LIMIT 1`,
      )
      .get(item.business_id, item.plan.login, digest(item.connection_id));
    if (
      latest?.date_to >= [item.date, item.state.periodEnd].sort()[0] &&
      localDate(Date.parse(latest.received_at), item.state.timezone) ===
        item.date
    )
      continue;
    try {
      enqueueReport(
        db,
        item.user_id,
        item.business_id,
        key,
        { login: item.plan.login },
        now,
      );
      queued++;
    } catch (error) {
      if (!(error instanceof AppError) || error.status !== 409) throw error;
    }
  }
  return queued;
}

// A new provenanced snapshot creates one read-only shadow job per campaign.
export function scheduleLiveShadowReviews(db, now = Date.now()) {
  let queued = 0;
  for (const item of eligibleExecutions(db, now)) {
    const snapshot = db
      .prepare(
        `SELECT rs.id,rs.received_at FROM report_snapshots rs
      JOIN jobs j ON j.id=rs.job_id
      WHERE rs.business_id=? AND rs.source='yandex' AND rs.login=?
        AND json_extract(j.payload,'$.signature')=?
        AND COALESCE(json_extract(j.payload,'$.reportType'),'campaign')='campaign'
        AND rs.date_from<=? AND rs.date_to>=?
      ORDER BY rs.date_to DESC,rs.rowid DESC LIMIT 1`,
      )
      .get(
        item.business_id,
        item.plan.login,
        digest(item.connection_id),
        item.plan.periodStart,
        item.plan.periodStart,
      );
    const receivedAt = Date.parse(snapshot?.received_at);
    if (
      !snapshot ||
      !Number.isFinite(receivedAt) ||
      receivedAt > now ||
      now - receivedAt > 48 * 3600000
    )
      continue;
    const id = stableUuid(`live-shadow:${item.change_id}:${snapshot.id}`);
    const inserted = db
      .prepare(
        `INSERT OR IGNORE INTO jobs
      (id,business_id,kind,status,available_at,payload)
      VALUES(?,?,'live_shadow_review','pending',?,?)`,
      )
      .run(
        id,
        item.business_id,
        now,
        JSON.stringify({
          changeId: item.change_id,
          connectionId: item.connection_id,
          snapshotId: snapshot.id,
          requestKey: id,
        }),
      );
    queued += inserted.changes;
  }
  return queued;
}

export async function runLiveShadowCycle(
  db,
  {
    now = Date.now(),
    key,
    config,
    refreshToken,
    connectionRunner = withYandexConnection,
    directFactory = (options) => new DirectClient(options),
    metricaFactory = (accessToken) => new MetricaClient(accessToken),
  } = {},
) {
  const job = transaction(db, () => {
    db.prepare(
      `UPDATE jobs SET status=CASE WHEN attempts>=3 THEN 'failed' ELSE 'pending' END,
      error='Обработка прервана; срок аренды истёк.'
      WHERE kind='live_shadow_review' AND status='running' AND available_at<=?`,
    ).run(now);
    const row = db
      .prepare(
        `SELECT * FROM jobs WHERE kind='live_shadow_review'
      AND status='pending' AND available_at<=? ORDER BY available_at,rowid LIMIT 1`,
      )
      .get(now);
    if (!row) return null;
    db.prepare(
      `UPDATE jobs SET status='running',attempts=attempts+1,available_at=? WHERE id=?`,
    ).run(now + 60000, row.id);
    return { ...row, attempts: row.attempts + 1 };
  });
  if (!job) return { status: "idle" };
  const payload = JSON.parse(job.payload);
  const owns = () =>
    db
      .prepare(
        `SELECT 1 FROM jobs WHERE id=? AND status='running' AND attempts=?`,
      )
      .get(job.id, job.attempts);
  try {
    const business = db
      .prepare("SELECT user_id FROM businesses WHERE id=?")
      .get(job.business_id);
    const plan = JSON.parse(
      db
        .prepare("SELECT plan_json FROM direct_changes WHERE id=?")
        .get(payload.changeId).plan_json,
    );
    const result = await connectionRunner(
      { db, config, key, businessId: job.business_id, refreshToken, now },
      ({ credentials, metadata }) =>
        runLiveShadowReview(
          db,
          business.user_id,
          job.business_id,
          payload.changeId,
          payload.requestKey,
          {
            connectionId: metadata.connectionId,
            snapshotId: payload.snapshotId,
            metrica: metricaFactory(credentials.access_token),
            direct: directFactory({
              accessToken: credentials.access_token,
              login: plan.login,
              sandbox: false,
            }),
          },
          now,
        ),
    );
    return transaction(db, () => {
      if (!owns()) return { status: "lease_lost" };
      const state = JSON.parse(
        db.prepare("SELECT state FROM businesses WHERE id=?").get(job.business_id).state,
      );
      queueOptimizerAction(
        db,
        job.business_id,
        payload.changeId,
        result,
        state.targetCpa,
        config?.optimizerPolicy,
      );
      db.prepare(
        "UPDATE jobs SET status='succeeded',error=NULL,available_at=? WHERE id=?",
      ).run(now, job.id);
      return { status: "succeeded", reviewId: result.id };
    });
  } catch (error) {
    return transaction(db, () => {
      if (!owns()) return { status: "lease_lost" };
      const retry =
        job.attempts < 3 &&
        !(error instanceof AppError && error.status === 409);
      const status = retry ? "pending" : "failed";
      db.prepare(
        "UPDATE jobs SET status=?,available_at=?,error=? WHERE id=?",
      ).run(
        status,
        now + 300000 * 3 ** (job.attempts - 1),
        retry
          ? "Чтение источников не удалось. Назначена повторная попытка."
          : "Сводка не получена. Проверьте подключение и повторите вручную.",
        job.id,
      );
      return { status };
    });
  }
}

export async function runOptimizerCycle(
  db,
  {
    now = Date.now(),
    key,
    config,
    refreshToken,
    connectionRunner = withYandexConnection,
    directFactory = (options) => new DirectClient(options),
  } = {},
) {
  if (!canRunAutopilot(config)) return { status: "disabled" };
  const action = db
    .prepare(
      `SELECT oa.*,b.user_id,dc.plan_json
       FROM optimizer_actions oa
       JOIN businesses b ON b.id=oa.business_id
       JOIN direct_changes dc ON dc.id=oa.change_id
       JOIN campaign_ad_lifecycle al ON al.business_id=oa.business_id AND al.change_id=oa.change_id
       WHERE oa.status='proposed' AND oa.action IN ('pause_campaign','consider_reallocation')
         AND al.status='active' AND al.change_id=oa.change_id
       ORDER BY oa.created_at,oa.rowid LIMIT 1`,
    )
    .get();
  if (!action) return { status: "idle" };
  const plan = JSON.parse(action.plan_json);
  try {
    return await connectionRunner(
      {
        db,
        config,
        key,
        businessId: action.business_id,
        refreshToken,
        now,
      },
      ({ credentials, metadata }) => {
        if (metadata.sandbox)
          throw new AppError(409, "Sandbox Директа недоступен.");
        return executeOptimizerAction(
          db,
          action.user_id,
          action.business_id,
          action.id,
          directFactory({
            accessToken: credentials.access_token,
            login: plan.login,
            sandbox: false,
          }),
          { enabled: true, connectionId: metadata.connectionId },
        );
      },
    );
  } catch {
    // Connection failures happen before a Direct write. Keep the proposal for a
    // later cycle; executeOptimizerAction itself fences every possible write.
    return { status: "deferred" };
  }
}

export function startLiveDataWorker(db, key, config) {
  let pending = null,
    stopped = false,
    lastScheduled = 0;
  const scheduleInterval = config?.liveDataScheduleMs || 300000,
    tickInterval = config?.liveDataTickMs || 15000;
  const tick = () => {
    if (stopped || pending) return;
    pending = (async () => {
      if (Date.now() - lastScheduled >= scheduleInterval) {
        scheduleLiveReports(db);
        scheduleLiveShadowReviews(db);
        lastScheduled = Date.now();
      }
      await runLiveShadowCycle(db, { key, config });
      await runOptimizerCycle(db, { key, config });
    })()
      .catch(() =>
        console.error(JSON.stringify({ event: "live_data_worker_error" })),
      )
      .finally(() => {
        pending = null;
      });
  };
  const timer = setInterval(tick, tickInterval);
  timer.unref();
  tick();
  return async () => {
    stopped = true;
    clearInterval(timer);
    if (pending) await pending;
  };
}
