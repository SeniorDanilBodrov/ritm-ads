import { createHash, randomUUID } from "node:crypto";
import { AppError } from "./db.js";
import {
  analyticsAttribution,
  usesDirectConversions,
} from "./analytics-attribution.js";
import { canRunAutopilot, canRunAutopilotForBusiness } from "./live-ads.js";
import { DirectClient, MetricaClient } from "./providers.js";
import { enqueuePostgresReport } from "./postgres-reports.js";
import { decrypt } from "./security.js";
import { resumePostgresVerifiedCampaign } from "./postgres-direct-resume.js";
import { inspectPostgresDirectControl } from "./postgres-direct-moderation.js";

const digest = (value) => createHash("sha256").update(value).digest("hex");
const stableUuid = (value) => {
  const hex = digest(value);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
};
const json = (value, fallback = null) => {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
};
const localDate = (now, timezone = "Europe/Moscow") =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(now));

const defaultPolicy = Object.freeze({
  minClicks: 100,
  minSpendTargetMultiple: 3,
  pauseCpaTargetMultiple: 1.5,
  efficientCpaTargetMultiple: 0.8,
  minGoalsForReallocation: 10,
});

async function monitoredTick(config, action, now = Date.now()) {
  const runtime = config?.autopilotRuntime;
  if (runtime) {
    runtime.running = true;
    runtime.attempts = Number(runtime.attempts || 0) + 1;
    runtime.lastStartedAt = new Date(now).toISOString();
  }
  try {
    const result = await action();
    if (runtime) {
      runtime.running = false;
      runtime.consecutiveFailures = 0;
      runtime.lastSucceededAt = new Date(now).toISOString();
      runtime.lastResult = result;
      runtime.lastError = null;
    }
    return result;
  } catch (error) {
    if (runtime) {
      runtime.running = false;
      runtime.consecutiveFailures =
        Number(runtime.consecutiveFailures || 0) + 1;
      runtime.lastFailedAt = new Date(now).toISOString();
      runtime.lastError =
        error instanceof Error ? error.message : "unknown_error";
    }
    throw error;
  }
}

export function postgresAutopilotRuntimeView(config = {}, now = Date.now()) {
  const runtime = config.autopilotRuntime || {};
  const lastSuccess = Date.parse(runtime.lastSucceededAt || "");
  const startedAt = Date.parse(runtime.startedAt || "");
  const maximumSilenceMs = Math.max(
    15 * 60_000,
    (Number(config.liveDataScheduleMs) || 300_000) * 2,
  );
  const heartbeatFresh =
    Number.isFinite(lastSuccess) &&
    lastSuccess <= now &&
    now - lastSuccess <= maximumSilenceMs;
  const starting =
    !Number.isFinite(lastSuccess) &&
    Number.isFinite(startedAt) &&
    startedAt <= now &&
    now - startedAt <= 2 * 60_000;
  return {
    configured: Boolean(config.autopilotWorkerToken),
    writeEnabled: canRunAutopilot(config),
    pilotBusinessConfigured: Boolean(config.livePilotBusinessId),
    running: runtime.running === true,
    attempts: Number(runtime.attempts || 0),
    consecutiveFailures: Number(runtime.consecutiveFailures || 0),
    startedAt: runtime.startedAt || null,
    lastStartedAt: runtime.lastStartedAt || null,
    lastSucceededAt: runtime.lastSucceededAt || null,
    lastFailedAt: runtime.lastFailedAt || null,
    heartbeatFresh,
    starting,
    healthy:
      Number(runtime.consecutiveFailures || 0) === 0 &&
      (!canRunAutopilot(config) || heartbeatFresh || starting),
  };
}

async function writeEvent(tx, businessId, payload, now = Date.now()) {
  const value = {
    id: randomUUID(),
    at: new Date(now).toISOString(),
    ...payload,
  };
  await tx
    .prepare("INSERT INTO events VALUES(?,?,?,?)")
    .run(value.id, businessId, value.at, JSON.stringify(value));
}

function campaignId(callsJson) {
  const id = json(callsJson, []).find((call) => call.key === "campaign")
    ?.ids?.[0];
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function safeSum(rows, field) {
  const value = rows.reduce((sum, row) => sum + Number(row[field] || 0), 0);
  if (!Number.isSafeInteger(value) || value < 0)
    throw new AppError(502, "Показатели отчёта вышли за допустимый диапазон.");
  return value;
}

async function currentConnection(db, businessId, key) {
  const row = await db
    .prepare(
      "SELECT encrypted,metadata FROM connections WHERE business_id=? AND provider='yandex'",
    )
    .get(businessId);
  if (!row) throw new AppError(409, "Подключение Яндекса не найдено.");
  const metadata = json(row.metadata, {});
  return {
    metadata,
    credentials: decrypt(row.encrypted, key, `${businessId}:yandex`),
  };
}

async function ownedBusiness(db, userId, businessId) {
  const row = await db
    .prepare("SELECT id FROM businesses WHERE id=? AND user_id=?")
    .get(businessId, userId);
  if (!row) throw new AppError(404, "Бизнес не найден.");
  return row;
}

async function activeCampaigns(db) {
  return db
    .prepare(
      `SELECT cl.business_id,cl.change_id,b.user_id,b.state,
              dc.plan_json,de.calls_json,de.connection_id,c.metadata
       FROM campaign_ad_lifecycle cl
       JOIN businesses b ON b.id=cl.business_id
       JOIN direct_changes dc ON dc.id=cl.change_id AND dc.business_id=cl.business_id
       JOIN direct_executions de ON de.change_id=cl.change_id AND de.business_id=cl.business_id
       JOIN connections c ON c.business_id=cl.business_id AND c.provider='yandex'
       WHERE cl.status='active' AND de.status='succeeded'`,
    )
    .all();
}

async function moderationPilotCampaigns(db, config = {}) {
  const pilotBusinessId = String(config?.livePilotBusinessId || "");
  if (!/^[0-9a-f-]{36}$/i.test(pilotBusinessId)) return [];
  return db
    .prepare(
      `SELECT cl.business_id,cl.change_id,b.user_id,b.state,
              dc.plan_json,de.calls_json,de.connection_id,c.metadata
       FROM campaign_ad_lifecycle cl
       JOIN businesses b ON b.id=cl.business_id
       JOIN direct_changes dc ON dc.id=cl.change_id AND dc.business_id=cl.business_id
       JOIN direct_executions de ON de.change_id=cl.change_id AND de.business_id=cl.business_id
       JOIN connections c ON c.business_id=cl.business_id AND c.provider='yandex'
       WHERE cl.business_id=? AND cl.status='moderation'
         AND de.status='succeeded' AND de.suspend_verified=1`,
    )
    .all(pilotBusinessId);
}

async function reportableCampaigns(db, config = {}) {
  const rows = [
    ...(await activeCampaigns(db)),
    ...(await moderationPilotCampaigns(db, config)),
  ];
  return [
    ...new Map(
      rows.map((row) => [`${row.business_id}:${row.change_id}`, row]),
    ).values(),
  ];
}

// Moderation polling is deliberately read-only. It is restricted to the exact
// production pilot and stores only an internal control review; it never resumes
// a campaign or repeats a moderation submission.
export async function pollPostgresPilotModeration(
  db,
  {
    key,
    config,
    now = Date.now(),
    directFactory = (options) => new DirectClient(options),
  } = {},
) {
  const pilotBusinessId = String(config?.livePilotBusinessId || "");
  if (!/^[0-9a-f-]{36}$/i.test(pilotBusinessId))
    return { status: "disabled", checked: 0, failed: 0 };
  const rows = await db
    .prepare(
      `SELECT cl.business_id,cl.change_id,b.user_id,dc.plan_json,
              de.connection_id,c.metadata
       FROM campaign_ad_lifecycle cl
       JOIN businesses b ON b.id=cl.business_id
       JOIN direct_changes dc ON dc.id=cl.change_id AND dc.business_id=cl.business_id
       JOIN direct_executions de ON de.change_id=cl.change_id AND de.business_id=cl.business_id
       JOIN connections c ON c.business_id=cl.business_id AND c.provider='yandex'
       WHERE cl.business_id=? AND cl.status='moderation'
         AND de.status='succeeded' AND de.suspend_verified=1
       ORDER BY cl.updated_at,cl.change_id LIMIT 5`,
    )
    .all(pilotBusinessId);
  if (!rows.length) return { status: "idle", checked: 0, failed: 0 };
  let checked = 0;
  let failed = 0;
  const bucket = Math.floor(now / (15 * 60_000));
  for (const row of rows) {
    try {
      const plan = json(row.plan_json, {});
      const { metadata, credentials } = await currentConnection(
        db,
        row.business_id,
        key,
      );
      if (
        metadata.sandbox === true ||
        metadata.connectionId !== row.connection_id ||
        !plan.login
      )
        throw new AppError(409, "Подключение или кампания изменились.");
      const requestKey = stableUuid(
        `postgres-moderation-poll:${row.business_id}:${row.change_id}:${bucket}:${
          (
            await db
              .prepare(
                `SELECT id FROM report_snapshots
                 WHERE business_id=? AND scope='campaign'
                   AND source='yandex' AND login=?
                 ORDER BY received_at DESC,ctid DESC LIMIT 1`,
              )
              .get(row.business_id, plan.login)
          )?.id || "no-report"
        }`,
      );
      await inspectPostgresDirectControl(
        db,
        row.user_id,
        row.business_id,
        row.change_id,
        requestKey,
        directFactory({
          accessToken: credentials.access_token,
          login: plan.login,
          sandbox: false,
        }),
        row.connection_id,
        now,
      );
      checked++;
    } catch {
      failed++;
    }
  }
  return {
    status: failed ? (checked ? "partial" : "failed") : "succeeded",
    checked,
    failed,
  };
}

// Report scheduling is safe while write-autopilot is disabled: it performs only
// provider reads and gives every business one idempotent daily report request.
export async function schedulePostgresAutopilotReports(
  db,
  now = Date.now(),
  config = {},
) {
  let queued = 0;
  for (const row of await reportableCampaigns(db, config)) {
    const state = json(row.state, {});
    const plan = json(row.plan_json, {});
    const metadata = json(row.metadata, {});
    const account = Array.isArray(metadata.clients)
      ? metadata.clients.find((item) => item?.Login === plan.login)
      : null;
    const date = localDate(now, state.timezone);
    if (
      state.mode !== "live" ||
      metadata.sandbox === true ||
      metadata.connectionId !== row.connection_id ||
      !account?.Login ||
      account.Currency !== "RUB" ||
      date < plan.periodStart ||
      date > plan.periodEnd
    )
      continue;
    const requestKey = stableUuid(
      `postgres-live-report:${row.business_id}:${plan.login}:${date}`,
    );
    try {
      const response = await enqueuePostgresReport(
        db,
        row.user_id,
        row.business_id,
        requestKey,
        { login: plan.login },
        now,
        {
          includeEnqueueState: true,
          periodStart: plan.periodStart,
          periodEnd: plan.periodEnd,
        },
      );
      queued += response.newlyQueued ? 1 : 0;
    } catch (error) {
      if (!(error instanceof AppError) || error.status !== 409) throw error;
    }
  }
  return queued;
}

export async function schedulePostgresShadowReviews(db, now = Date.now()) {
  let queued = 0;
  for (const row of await activeCampaigns(db)) {
    const plan = json(row.plan_json, {});
    const snapshot = await db
      .prepare(
        `SELECT id,received_at,date_from,date_to FROM report_snapshots
         WHERE business_id=? AND source='yandex' AND login=?
           AND date_from<=? AND date_to>=?
         ORDER BY received_at DESC,ctid DESC LIMIT 1`,
      )
      .get(row.business_id, plan.login, plan.periodStart, plan.periodStart);
    const receivedAt = Date.parse(snapshot?.received_at || "");
    if (
      !snapshot ||
      !Number.isFinite(receivedAt) ||
      receivedAt > now ||
      now - receivedAt > 48 * 60 * 60 * 1000
    )
      continue;
    const id = stableUuid(
      `postgres-shadow:${row.business_id}:${row.change_id}:${snapshot.id}`,
    );
    const inserted = await db
      .prepare(
        `INSERT OR IGNORE INTO jobs
         (id,business_id,kind,status,available_at,payload)
         VALUES(?,?,'postgres_shadow_review','pending',?,?)`,
      )
      .run(
        id,
        row.business_id,
        now,
        JSON.stringify({
          changeId: row.change_id,
          connectionId: row.connection_id,
          snapshotId: snapshot.id,
          requestKey: id,
        }),
      );
    queued += Number(inserted.changes || 0);
  }
  return queued;
}

function observedPerformance(review, policy) {
  const source = review?.source;
  if (
    review?.status !== "observed" ||
    review?.executed !== false ||
    !["direct_campaign_last_significant", "direct_report_conversions"].includes(
      source?.attribution,
    ) ||
    !Number.isSafeInteger(source?.direct?.spentKopecks) ||
    !Number.isSafeInteger(source?.direct?.clicks) ||
    !Number.isSafeInteger(source?.campaignGoalReaches) ||
    source.direct.clicks < policy.minClicks
  )
    return null;
  return {
    spentKopecks: source.direct.spentKopecks,
    clicks: source.direct.clicks,
    goals: source.campaignGoalReaches,
    cpaKopecks: source.campaignGoalReaches
      ? Math.round(source.direct.spentKopecks / source.campaignGoalReaches)
      : null,
    snapshotId: source.direct.snapshotId,
  };
}

async function unresolved(db, businessId, changeId) {
  const rows = await db
    .prepare(
      `SELECT change_id,guard_json FROM optimizer_actions
       WHERE business_id=? AND status IN ('proposed','dispatching','needs_reconciliation')`,
    )
    .all(businessId);
  return rows.some(
    (row) =>
      row.change_id === changeId ||
      json(row.guard_json, {})?.reallocation?.donor?.changeId === changeId,
  );
}

async function allocationCandidate(
  db,
  businessId,
  recipientChangeId,
  recipientPlan,
  recipient,
  targetCpa,
  policy,
) {
  const rows = await db
    .prepare(
      `SELECT cl.change_id,dc.plan_json,cba.limit_kopecks,de.calls_json,de.connection_id
       FROM campaign_ad_lifecycle cl
       JOIN direct_changes dc ON dc.id=cl.change_id AND dc.business_id=cl.business_id
       LEFT JOIN campaign_budget_allocations cba
         ON cba.business_id=cl.business_id AND cba.change_id=cl.change_id
       JOIN direct_executions de ON de.change_id=cl.change_id AND de.business_id=cl.business_id
       WHERE cl.business_id=? AND cl.change_id<>? AND cl.status='active'
         AND de.status='succeeded'`,
    )
    .all(businessId, recipientChangeId);
  const choices = [];
  for (const row of rows) {
    const reviewRow = await db
      .prepare(
        `SELECT result_json FROM direct_shadow_reviews
         WHERE business_id=? AND change_id=?
         ORDER BY created_at DESC,ctid DESC LIMIT 1`,
      )
      .get(businessId, row.change_id);
    const plan = json(row.plan_json, {});
    const performance = observedPerformance(
      json(reviewRow?.result_json, {}),
      policy,
    );
    const limitKopecks = Number(row.limit_kopecks ?? plan.budget);
    const remoteId = campaignId(row.calls_json);
    if (
      !performance ||
      remoteId === null ||
      plan.login !== recipientPlan.login ||
      plan.counterId !== recipientPlan.counterId ||
      plan.goalId !== recipientPlan.goalId ||
      performance.cpaKopecks === null ||
      performance.cpaKopecks <= recipient.cpaKopecks ||
      performance.cpaKopecks > targetCpa * policy.pauseCpaTargetMultiple ||
      !Number.isSafeInteger(limitKopecks) ||
      performance.spentKopecks >= limitKopecks
    )
      continue;
    choices.push({
      changeId: row.change_id,
      campaignId: remoteId,
      connectionId: row.connection_id,
      performance,
      limitKopecks,
      freeKopecks: limitKopecks - performance.spentKopecks,
    });
  }
  return (
    choices.sort(
      (left, right) =>
        right.performance.cpaKopecks - left.performance.cpaKopecks,
    )[0] || null
  );
}

export async function queuePostgresOptimizerAction(
  db,
  businessId,
  changeId,
  review,
  targetCpa,
  rawPolicy = {},
) {
  const policy = { ...defaultPolicy, ...rawPolicy };
  const lifecycle = await db
    .prepare(
      "SELECT status FROM campaign_ad_lifecycle WHERE business_id=? AND change_id=?",
    )
    .get(businessId, changeId);
  const performance = observedPerformance(review, policy);
  if (
    lifecycle?.status !== "active" ||
    !performance ||
    !Number.isSafeInteger(targetCpa) ||
    targetCpa <= 0 ||
    performance.spentKopecks < targetCpa * policy.minSpendTargetMultiple
  )
    return null;
  const action =
    !performance.goals ||
    performance.cpaKopecks > targetCpa * policy.pauseCpaTargetMultiple
      ? "pause_campaign"
      : performance.cpaKopecks <
            targetCpa * policy.efficientCpaTargetMultiple &&
          performance.goals >= policy.minGoalsForReallocation
        ? "consider_reallocation"
        : null;
  if (!action) return null;
  const existing = await db
    .prepare("SELECT id,action,status FROM optimizer_actions WHERE review_id=?")
    .get(review.id);
  if (existing) return existing;
  if (await unresolved(db, businessId, changeId)) return null;
  const recipient = await db
    .prepare(
      `SELECT dc.plan_json,cba.limit_kopecks,de.calls_json,de.connection_id
       FROM direct_changes dc
       JOIN direct_executions de ON de.change_id=dc.id AND de.business_id=dc.business_id
       LEFT JOIN campaign_budget_allocations cba
         ON cba.business_id=dc.business_id AND cba.change_id=dc.id
       WHERE dc.id=? AND dc.business_id=? AND de.status='succeeded'`,
    )
    .get(changeId, businessId);
  if (!recipient) return null;
  const recipientPlan = json(recipient.plan_json, {});
  const recipientCampaignId = campaignId(recipient.calls_json);
  if (recipientCampaignId === null) return null;
  const donor =
    action === "consider_reallocation"
      ? await allocationCandidate(
          db,
          businessId,
          changeId,
          recipientPlan,
          performance,
          targetCpa,
          policy,
        )
      : null;
  if (action === "consider_reallocation" && !donor) return null;
  if (donor && (await unresolved(db, businessId, donor.changeId))) return null;
  const guard = {
    totalBudgetIncreaseAllowed: false,
    sourceSnapshotId: performance.snapshotId,
    spentKopecks: performance.spentKopecks,
    goals: performance.goals,
    cpaKopecks: performance.cpaKopecks,
    targetCpaKopecks: targetCpa,
    policy,
  };
  if (donor)
    guard.reallocation = {
      recipient: {
        changeId,
        campaignId: recipientCampaignId,
        connectionId: recipient.connection_id,
        previousLimitKopecks: Number(
          recipient.limit_kopecks ?? recipientPlan.budget,
        ),
        snapshotId: performance.snapshotId,
        cpaKopecks: performance.cpaKopecks,
      },
      donor: {
        changeId: donor.changeId,
        campaignId: donor.campaignId,
        connectionId: donor.connectionId,
        previousLimitKopecks: donor.limitKopecks,
        snapshotId: donor.performance.snapshotId,
        cpaKopecks: donor.performance.cpaKopecks,
        spentKopecks: donor.performance.spentKopecks,
      },
      transferKopecks: donor.freeKopecks,
    };
  const id = randomUUID();
  const at = new Date().toISOString();
  await db
    .prepare(
      `INSERT OR IGNORE INTO optimizer_actions
       (id,business_id,change_id,review_id,action,status,reason,guard_json,created_at,updated_at)
       VALUES(?,?,?,?,?,'proposed',?,?,?,?)`,
    )
    .run(
      id,
      businessId,
      changeId,
      review.id,
      action,
      action === "pause_campaign"
        ? "Стоимость обращения устойчиво выше цели; подготовлена защитная остановка."
        : "Свободный остаток менее результативной кампании подготовлен к переносу без увеличения общего бюджета.",
      JSON.stringify(guard),
      at,
      at,
    );
  return db
    .prepare("SELECT id,action,status FROM optimizer_actions WHERE review_id=?")
    .get(review.id);
}

async function createShadowReview(
  db,
  job,
  { key, directFactory, metricaFactory, now, optimizerPolicy },
) {
  const payload = json(job.payload, {});
  const row = await db
    .prepare(
      `SELECT b.state,dc.plan_json,de.calls_json,de.connection_id,
              c.encrypted,c.metadata,cl.status AS lifecycle_status,
              rs.received_at,rs.date_from,rs.date_to,rs.rows_json
       FROM businesses b
       JOIN direct_changes dc ON dc.id=? AND dc.business_id=b.id
       JOIN direct_executions de ON de.change_id=dc.id AND de.business_id=b.id
       JOIN connections c ON c.business_id=b.id AND c.provider='yandex'
       JOIN campaign_ad_lifecycle cl ON cl.business_id=b.id AND cl.change_id=dc.id
       JOIN report_snapshots rs ON rs.id=? AND rs.business_id=b.id
       WHERE b.id=?`,
    )
    .get(payload.changeId, payload.snapshotId, job.business_id);
  if (!row) throw new AppError(409, "Данные кампании для анализа изменились.");
  const state = json(row.state, {});
  const plan = json(row.plan_json, {});
  const metadata = json(row.metadata, {});
  const remoteId = campaignId(row.calls_json);
  const attribution = analyticsAttribution(state, plan);
  if (
    row.lifecycle_status !== "active" ||
    remoteId === null ||
    row.connection_id !== payload.connectionId ||
    metadata.connectionId !== payload.connectionId ||
    metadata.sandbox === true ||
    !attribution.ready ||
    attribution.changed
  )
    throw new AppError(409, "Кампания, аналитика или подключение изменились.");
  const receivedAt = Date.parse(row.received_at);
  if (
    !Number.isFinite(receivedAt) ||
    receivedAt > now ||
    now - receivedAt > 48 * 3600000
  )
    throw new AppError(409, "Отчёт устарел; решение не подготовлено.");
  const rows = json(row.rows_json, []).filter(
    (item) =>
      String(item.CampaignId) === String(remoteId) &&
      item.Date >= plan.periodStart &&
      item.Date <= row.date_to,
  );
  const direct = {
    snapshotId: payload.snapshotId,
    spentKopecks: safeSum(rows, "spent"),
    clicks: safeSum(rows, "clicks"),
    impressions: safeSum(rows, "impressions"),
    conversions: safeSum(rows, "conversions"),
  };
  const credentials = decrypt(row.encrypted, key, `${job.business_id}:yandex`);
  const directClient = directFactory({
    accessToken: credentials.access_token,
    login: plan.login,
    sandbox: false,
  });
  const directAttribution = usesDirectConversions(state);
  const [stats, remote] = await Promise.all([
    directAttribution
      ? Promise.resolve(null)
      : metricaFactory(credentials.access_token).campaignStatistics(
          plan.counterId,
          plan.goalId,
          remoteId,
          plan.periodStart,
          row.date_to,
        ),
    directClient.campaignsByIds([remoteId]),
  ]);
  const totals = stats?.totals;
  const campaign = remote?.Campaigns?.length === 1 ? remote.Campaigns[0] : null;
  if (
    (!directAttribution &&
      (!Array.isArray(totals) ||
        totals.length !== 2 ||
        totals.some(
          (value) => !Number.isSafeInteger(Number(value)) || Number(value) < 0,
        ) ||
        stats.sampled === true)) ||
    campaign?.Id !== remoteId ||
    campaign.State !== "ON"
  )
    throw new AppError(
      409,
      "Источники не подтвердили активную кампанию и точную атрибуцию.",
    );
  const result = {
    id: randomUUID(),
    changeId: payload.changeId,
    campaignId: remoteId,
    checkedAt: new Date(now).toISOString(),
    status: "observed",
    blocker: null,
    executed: false,
    requiresReview: true,
    action: direct.spentKopecks > 0 ? "review_campaign_performance" : "observe",
    reason:
      direct.spentKopecks > 0
        ? "Расход и обращения сопоставлены только с этой кампанией; решение ограничено защитными правилами."
        : "Расхода пока нет; реклама не менялась.",
    source: {
      attribution: directAttribution
        ? "direct_report_conversions"
        : "direct_campaign_last_significant",
      direct,
      campaignGoalReaches: directAttribution
        ? direct.conversions
        : Number(totals[1]),
      campaignVisits: directAttribution ? null : Number(totals[0]),
      campaignState: { state: campaign.State, status: campaign.Status },
    },
  };
  return db.transaction(async (tx) => {
    const existing = await tx
      .prepare(
        "SELECT result_json FROM direct_shadow_reviews WHERE business_id=? AND request_key=?",
      )
      .get(job.business_id, payload.requestKey);
    const stored = existing ? json(existing.result_json, result) : result;
    if (!existing)
      await tx
        .prepare(
          `INSERT INTO direct_shadow_reviews
           (id,business_id,change_id,connection_id,request_key,created_at,result_json)
           VALUES(?,?,?,?,?,?,?)`,
        )
        .run(
          result.id,
          job.business_id,
          payload.changeId,
          payload.connectionId,
          payload.requestKey,
          result.checkedAt,
          JSON.stringify(result),
        );
    const business = await tx
      .prepare("SELECT state FROM businesses WHERE id=?")
      .get(job.business_id);
    const targetCpa = Number(json(business?.state, {}).targetCpa);
    const queued = await queuePostgresOptimizerAction(
      tx,
      job.business_id,
      payload.changeId,
      stored,
      targetCpa,
      optimizerPolicy,
    );
    await tx
      .prepare(
        "UPDATE jobs SET status='succeeded',available_at=?,error=NULL WHERE id=?",
      )
      .run(now, job.id);
    await writeEvent(
      tx,
      job.business_id,
      {
        kind: "shadow_review",
        title: queued
          ? "Ритм подготовил защитное решение"
          : "Ритм проверил результат",
        reason: queued
          ? "Решение будет применено только после повторной проверки кабинета и общего бюджета."
          : result.reason,
        rule: "postgres-autopilot/shadow@1",
        reviewId: stored.id,
      },
      now,
    );
    return { status: "succeeded", review: stored, optimizerAction: queued };
  });
}

export async function runPostgresShadowCycle(
  db,
  {
    key,
    config,
    now = Date.now(),
    directFactory = (options) => new DirectClient(options),
    metricaFactory = (accessToken) => new MetricaClient(accessToken),
  } = {},
) {
  const job = await db.transaction(async (tx) => {
    const row = await tx
      .prepare(
        `SELECT * FROM jobs WHERE kind='postgres_shadow_review'
         AND status='pending' AND available_at<=?
         ORDER BY available_at,ctid LIMIT 1 FOR UPDATE SKIP LOCKED`,
      )
      .get(now);
    if (!row) return null;
    await tx
      .prepare(
        "UPDATE jobs SET status='running',attempts=attempts+1,available_at=? WHERE id=?",
      )
      .run(now + 60_000, row.id);
    return { ...row, attempts: Number(row.attempts) + 1 };
  });
  if (!job) return { status: "idle" };
  try {
    return await createShadowReview(db, job, {
      key,
      directFactory,
      metricaFactory,
      now,
      optimizerPolicy: config?.optimizerPolicy,
    });
  } catch (error) {
    await db.transaction(async (tx) => {
      const retry =
        Number(job.attempts) < 3 &&
        !(error instanceof AppError && error.status === 409);
      await tx
        .prepare("UPDATE jobs SET status=?,available_at=?,error=? WHERE id=?")
        .run(
          retry ? "pending" : "failed",
          retry ? now + 300_000 * 3 ** (Number(job.attempts) - 1) : now,
          retry
            ? "Источники временно недоступны. Проверка будет повторена."
            : "Автоматическое решение не принято: данные не прошли проверку.",
          job.id,
        );
    });
    return { status: "failed" };
  }
}

function remoteBudget(response, id) {
  const campaign =
    response?.Campaigns?.length === 1 ? response.Campaigns[0] : null;
  const network = campaign?.Type === "UNIFIED_CAMPAIGN";
  const strategy = network
    ? campaign?.UnifiedCampaign?.BiddingStrategy
    : campaign?.TextCampaign?.BiddingStrategy;
  const placement = network ? strategy?.Network : strategy?.Search;
  const period = placement?.WbMaximumClicks?.CustomPeriodBudget;
  const micros = period?.SpendLimit;
  if (
    campaign?.Id !== id ||
    !["TEXT_CAMPAIGN", "UNIFIED_CAMPAIGN"].includes(campaign.Type) ||
    (network
      ? strategy?.Search?.BiddingStrategyType !== "SERVING_OFF" ||
        strategy?.Network?.BiddingStrategyType !== "WB_MAXIMUM_CLICKS" ||
        strategy?.Network?.PlacementTypes?.Network !== "YES" ||
        strategy?.Network?.PlacementTypes?.Maps !== "NO"
      : strategy?.Search?.BiddingStrategyType !== "WB_MAXIMUM_CLICKS" ||
        strategy?.Network?.BiddingStrategyType !== "SERVING_OFF") ||
    !Number.isSafeInteger(micros) ||
    micros <= 0 ||
    micros % 10_000 !== 0 ||
    period.AutoContinue !== "NO"
  )
    throw new AppError(409, "Стратегия или лимит кампании изменились.");
  return {
    channel: network ? "network" : "search",
    state: campaign.State,
    limitKopecks: micros / 10_000,
    periodStart: period.StartDate,
    periodEnd: period.EndDate,
  };
}

async function updateBudget(client, id, before, limitKopecks) {
  const update =
    before.channel === "network"
      ? client.updateUnifiedCampaignPeriodBudget.bind(client)
      : client.updateTextCampaignPeriodBudget.bind(client);
  const response = await update(id, {
    spendLimitKopecks: limitKopecks,
    startDate: before.periodStart,
    endDate: before.periodEnd,
  });
  if (
    response?.UpdateResults?.length !== 1 ||
    response.UpdateResults[0].Id !== id ||
    response.UpdateResults[0].Errors?.length
  )
    throw new AppError(502, "Директ не подтвердил изменение лимита.");
  const after = remoteBudget(await client.campaignBudgetById(id), id);
  if (
    after.state !== "ON" ||
    after.limitKopecks !== limitKopecks ||
    after.periodStart !== before.periodStart ||
    after.periodEnd !== before.periodEnd
  )
    throw new AppError(502, "Новый лимит не подтверждён чтением Директа.");
  return after;
}

async function freshOptimizerEvidence(db, action, now) {
  const guard = json(action.guard_json, {});
  if (guard.manual === true) return true;
  const snapshotIds = [
    guard.sourceSnapshotId,
    guard.reallocation?.recipient?.snapshotId,
    guard.reallocation?.donor?.snapshotId,
  ].filter(Boolean);
  if (!snapshotIds.length) return false;
  for (const snapshotId of new Set(snapshotIds)) {
    const snapshot = await db
      .prepare(
        "SELECT source,received_at FROM report_snapshots WHERE id=? AND business_id=?",
      )
      .get(snapshotId, action.business_id);
    const receivedAt = Date.parse(snapshot?.received_at || "");
    if (
      snapshot?.source !== "yandex" ||
      !Number.isFinite(receivedAt) ||
      receivedAt > now ||
      now - receivedAt > 48 * 60 * 60 * 1000
    )
      return false;
  }
  return true;
}

async function applyPause(db, action, client) {
  let writeAttempted = false;
  try {
    const execution = await db
      .prepare(
        "SELECT calls_json FROM direct_executions WHERE business_id=? AND change_id=? AND status='succeeded'",
      )
      .get(action.business_id, action.change_id);
    const id = campaignId(execution?.calls_json);
    const lifecycle = await db
      .prepare(
        "SELECT status FROM campaign_ad_lifecycle WHERE business_id=? AND change_id=?",
      )
      .get(action.business_id, action.change_id);
    if (id === null || lifecycle?.status !== "active")
      throw new AppError(409, "Кампания больше не активна.");
    const before = await client.campaignsByIds([id]);
    const remote = before?.Campaigns?.length === 1 ? before.Campaigns[0] : null;
    if (remote?.Id !== id)
      throw new AppError(409, "Кампания не найдена в Директе.");
    if (remote.State === "SUSPENDED")
      return {
        status: "applied",
        reason: "Кампания уже остановлена; состояние подтверждено Директом.",
      };
    if (remote.State !== "ON")
      throw new AppError(
        409,
        "Директ не подтвердил активное состояние кампании.",
      );
    writeAttempted = true;
    const result = await client.suspendCampaigns([id]);
    if (
      result?.SuspendResults?.length !== 1 ||
      result.SuspendResults[0].Id !== id ||
      result.SuspendResults[0].Errors?.length
    )
      throw new AppError(502, "Директ не подтвердил остановку кампании.");
    const after = await client.campaignsByIds([id]);
    if (
      after?.Campaigns?.length !== 1 ||
      after.Campaigns[0].State !== "SUSPENDED"
    )
      throw new AppError(
        502,
        "Состояние SUSPENDED не подтверждено чтением Директа.",
      );
    return {
      status: "applied",
      reason:
        "Неэффективная кампания остановлена; состояние подтверждено чтением Директа.",
    };
  } catch {
    return {
      status: writeAttempted ? "needs_reconciliation" : "failed_no_write",
      reason: writeAttempted
        ? "Результат остановки неоднозначен; автоматический повтор запрещён до сверки."
        : "Проверка перед остановкой не пройдена; команда в Директ не отправлялась.",
    };
  }
}

async function applyReallocation(db, action, client, connectionId) {
  const guard = json(action.guard_json, {});
  const value = guard.reallocation;
  let writeAttempted = false;
  try {
    if (
      guard.totalBudgetIncreaseAllowed !== false ||
      !value ||
      !Number.isSafeInteger(value.transferKopecks) ||
      value.transferKopecks <= 0 ||
      value.recipient?.changeId !== action.change_id ||
      value.recipient?.connectionId !== connectionId ||
      value.donor?.connectionId !== connectionId ||
      value.recipient.changeId === value.donor.changeId ||
      value.transferKopecks >
        value.donor.previousLimitKopecks - value.donor.spentKopecks
    )
      throw new AppError(
        409,
        "План перераспределения неполный или небезопасный.",
      );
    const lifecycles = await db
      .prepare(
        "SELECT change_id,status FROM campaign_ad_lifecycle WHERE business_id=? AND change_id IN (?,?)",
      )
      .all(action.business_id, value.recipient.changeId, value.donor.changeId);
    if (
      lifecycles.length !== 2 ||
      lifecycles.some((item) => item.status !== "active")
    )
      throw new AppError(409, "Одна из кампаний больше не активна.");
    const allocations = await db
      .prepare(
        "SELECT limit_kopecks FROM campaign_budget_allocations WHERE business_id=?",
      )
      .all(action.business_id);
    const business = await db
      .prepare("SELECT state FROM businesses WHERE id=?")
      .get(action.business_id);
    const portfolioLimit = Number(json(business?.state, {}).budget);
    const allocated = allocations.reduce(
      (sum, item) => sum + Number(item.limit_kopecks),
      0,
    );
    if (
      !Number.isSafeInteger(allocated) ||
      !Number.isSafeInteger(portfolioLimit) ||
      allocated > portfolioLimit
    )
      throw new AppError(409, "Общий лимит портфеля не подтверждён.");
    const [recipientBefore, donorBefore] = await Promise.all([
      client
        .campaignBudgetById(value.recipient.campaignId)
        .then((result) => remoteBudget(result, value.recipient.campaignId)),
      client
        .campaignBudgetById(value.donor.campaignId)
        .then((result) => remoteBudget(result, value.donor.campaignId)),
    ]);
    if (
      recipientBefore.state !== "ON" ||
      donorBefore.state !== "ON" ||
      recipientBefore.limitKopecks !== value.recipient.previousLimitKopecks ||
      donorBefore.limitKopecks !== value.donor.previousLimitKopecks ||
      recipientBefore.periodStart !== donorBefore.periodStart ||
      recipientBefore.periodEnd !== donorBefore.periodEnd
    )
      throw new AppError(
        409,
        "Лимиты кампаний изменились после контрольного среза.",
      );
    const donorLimit = donorBefore.limitKopecks - value.transferKopecks;
    const recipientLimit = recipientBefore.limitKopecks + value.transferKopecks;
    if (
      donorLimit < value.donor.spentKopecks ||
      donorLimit + recipientLimit !==
        donorBefore.limitKopecks + recipientBefore.limitKopecks
    )
      throw new AppError(409, "Перенос нарушает подтверждённый общий лимит.");
    writeAttempted = true;
    await updateBudget(client, value.donor.campaignId, donorBefore, donorLimit);
    await updateBudget(
      client,
      value.recipient.campaignId,
      recipientBefore,
      recipientLimit,
    );
    await db.transaction(async (tx) => {
      const at = new Date().toISOString();
      for (const [changeId, limit] of [
        [value.donor.changeId, donorLimit],
        [value.recipient.changeId, recipientLimit],
      ])
        await tx
          .prepare(
            `INSERT INTO campaign_budget_allocations
             (business_id,change_id,limit_kopecks,updated_at) VALUES(?,?,?,?)
             ON CONFLICT(business_id,change_id) DO UPDATE
             SET limit_kopecks=excluded.limit_kopecks,updated_at=excluded.updated_at`,
          )
          .run(action.business_id, changeId, limit, at);
    });
    return {
      status: "applied",
      reason: `Перенесено ${value.transferKopecks} коп. Общий лимит портфеля не изменился.`,
    };
  } catch {
    return {
      status: writeAttempted ? "needs_reconciliation" : "failed_no_write",
      reason: writeAttempted
        ? "Перераспределение могло примениться частично; автоматический повтор запрещён до сверки обоих лимитов."
        : "Проверка лимитов не пройдена; команды в Директ не отправлялись.",
    };
  }
}

async function executeClaimedPostgresOptimizerAction(
  db,
  action,
  {
    key,
    config,
    now = Date.now(),
    directFactory = (options) => new DirectClient(options),
  } = {},
) {
  let result;
  try {
    if (!(await freshOptimizerEvidence(db, action, now)))
      throw new AppError(
        409,
        "Отчёт устарел; сначала нужно получить свежие данные Директа.",
        "optimizer_report_stale",
      );
    const { metadata, credentials } = await currentConnection(
      db,
      action.business_id,
      key,
    );
    const execution = await db
      .prepare(
        "SELECT connection_id FROM direct_executions WHERE business_id=? AND change_id=?",
      )
      .get(action.business_id, action.change_id);
    const planRow = await db
      .prepare(
        "SELECT plan_json FROM direct_changes WHERE business_id=? AND id=?",
      )
      .get(action.business_id, action.change_id);
    const plan = json(planRow?.plan_json, {});
    if (
      metadata.sandbox === true ||
      !execution ||
      execution.connection_id !== metadata.connectionId ||
      !plan.login
    )
      throw new AppError(409, "Подключение или кампания изменились.");
    const client = directFactory({
      accessToken: credentials.access_token,
      login: plan.login,
      sandbox: false,
    });
    result =
      action.action === "pause_campaign"
        ? await applyPause(db, action, client)
        : await applyReallocation(db, action, client, metadata.connectionId);
  } catch (error) {
    result = {
      status: "failed_no_write",
      reason:
        error instanceof AppError && error.code === "optimizer_report_stale"
          ? "Свежий отчёт не найден; реклама не изменена."
          : "Подключение или контрольные данные изменились; внешняя команда не отправлялась.",
    };
  }
  return db.transaction(async (tx) => {
    await tx
      .prepare(
        "UPDATE optimizer_actions SET status=?,reason=?,updated_at=? WHERE id=? AND status='dispatching'",
      )
      .run(
        result.status,
        result.reason,
        new Date(now).toISOString(),
        action.id,
      );
    if (result.status === "applied" && action.action === "pause_campaign")
      await tx
        .prepare(
          "UPDATE campaign_ad_lifecycle SET status='paused',reason=?,updated_at=? WHERE business_id=? AND change_id=? AND status='active'",
        )
        .run(
          result.reason,
          new Date(now).toISOString(),
          action.business_id,
          action.change_id,
        );
    await writeEvent(
      tx,
      action.business_id,
      {
        kind:
          result.status === "applied"
            ? "optimizer_action_applied"
            : result.status === "needs_reconciliation"
              ? "optimizer_action_uncertain"
              : "optimizer_action_not_applied",
        title:
          result.status === "applied"
            ? action.action === "pause_campaign"
              ? "Ритм остановил неэффективную кампанию"
              : "Ритм перенёс свободный остаток"
            : result.status === "needs_reconciliation"
              ? "Решение требует сверки"
              : "Реклама не изменена",
        reason: result.reason,
        rule: "postgres-budget-guard/executor@1",
        jobId: action.id,
      },
      now,
    );
    return { id: action.id, action: action.action, ...result };
  });
}

export async function createPostgresManualSuspendAction(
  db,
  userId,
  businessId,
  changeId,
  requestKey,
  { confirmed = false, now = Date.now() } = {},
) {
  if (!confirmed)
    throw new AppError(400, "Подтвердите защитную остановку кампании.");
  await ownedBusiness(db, userId, businessId);
  return db.transaction(async (tx) => {
    const reviewId = `manual-suspend:${requestKey}`;
    const existing = await tx
      .prepare("SELECT * FROM optimizer_actions WHERE review_id=?")
      .get(reviewId);
    if (existing) return existing;
    const lifecycle = await tx
      .prepare(
        "SELECT status FROM campaign_ad_lifecycle WHERE business_id=? AND change_id=?",
      )
      .get(businessId, changeId);
    const execution = await tx
      .prepare(
        "SELECT calls_json FROM direct_executions WHERE business_id=? AND change_id=? AND status='succeeded'",
      )
      .get(businessId, changeId);
    const remoteId = campaignId(execution?.calls_json);
    if (lifecycle?.status !== "active" || remoteId === null)
      throw new AppError(409, "Активная кампания для остановки не найдена.");
    const id = randomUUID();
    const at = new Date(now).toISOString();
    await tx
      .prepare(
        `INSERT INTO optimizer_actions
         (id,business_id,change_id,review_id,action,status,reason,guard_json,created_at,updated_at)
         VALUES(?,?,?,?,?,'proposed',?,?,?,?)`,
      )
      .run(
        id,
        businessId,
        changeId,
        reviewId,
        "pause_campaign",
        "Владелец запросил защитную остановку кампании.",
        JSON.stringify({ manual: true, campaignId: remoteId }),
        at,
        at,
      );
    await writeEvent(
      tx,
      businessId,
      {
        kind: "optimizer_action_proposed",
        title: "Подготовлена остановка кампании",
        reason: "Показы будут остановлены после контрольного чтения Директа.",
        rule: "postgres-budget-guard/manual-suspend@1",
        jobId: id,
      },
      now,
    );
    return tx.prepare("SELECT * FROM optimizer_actions WHERE id=?").get(id);
  });
}

export async function applyPostgresOptimizerAction(
  db,
  userId,
  businessId,
  actionId,
  options = {},
) {
  await ownedBusiness(db, userId, businessId);
  if (!canRunAutopilotForBusiness(options.config, businessId))
    return { status: "disabled" };
  const now = options.now ?? Date.now();
  const action = await db.transaction(async (tx) => {
    const row = await tx
      .prepare(
        `SELECT * FROM optimizer_actions
         WHERE id=? AND business_id=? FOR UPDATE`,
      )
      .get(actionId, businessId);
    if (!row) throw new AppError(404, "Решение Budget Guard не найдено.");
    if (row.status !== "proposed") return row;
    await tx
      .prepare(
        "UPDATE optimizer_actions SET status='dispatching',updated_at=? WHERE id=? AND status='proposed'",
      )
      .run(new Date(now).toISOString(), row.id);
    return { ...row, status: "dispatching" };
  });
  if (action.status !== "dispatching")
    return {
      id: action.id,
      action: action.action,
      status: action.status,
      reason: action.reason,
    };
  return executeClaimedPostgresOptimizerAction(db, action, {
    ...options,
    now,
  });
}

export async function rollbackPostgresOptimizerAction(
  db,
  userId,
  businessId,
  actionId,
  requestKey,
  {
    key,
    config,
    directFactory = (options) => new DirectClient(options),
    spendConfirmed = false,
    launchConfirmed = false,
    now = Date.now(),
  } = {},
) {
  await ownedBusiness(db, userId, businessId);
  if (!canRunAutopilotForBusiness(config, businessId))
    throw new AppError(
      409,
      "Откат защитного действия отключён.",
      "autopilot_gate",
    );
  if (!spendConfirmed || !launchConfirmed)
    throw new AppError(
      400,
      "Подтвердите повторное разрешение расходов и откат решения.",
    );
  const action = await db.transaction(async (tx) => {
    const row = await tx
      .prepare(
        "SELECT * FROM optimizer_actions WHERE id=? AND business_id=? FOR UPDATE",
      )
      .get(actionId, businessId);
    if (!row) throw new AppError(404, "Решение Budget Guard не найдено.");
    if (["rolled_back", "rollback_needs_reconciliation"].includes(row.status))
      return row;
    if (row.status !== "applied")
      throw new AppError(409, "Это решение сейчас нельзя откатить.");
    const guard = json(row.guard_json, {});
    guard.rollback = { requestKey, startedAt: new Date(now).toISOString() };
    await tx
      .prepare(
        "UPDATE optimizer_actions SET status='rollback_dispatching',guard_json=?,updated_at=? WHERE id=? AND status='applied'",
      )
      .run(JSON.stringify(guard), new Date(now).toISOString(), row.id);
    return {
      ...row,
      status: "rollback_dispatching",
      guard_json: JSON.stringify(guard),
    };
  });
  if (action.status !== "rollback_dispatching")
    return {
      id: action.id,
      action: action.action,
      status: action.status,
      reason: action.reason,
    };

  let status = "applied";
  let reason = "Откат не применён; внешняя реклама не изменена.";
  let possibleWrite = false;
  try {
    const { metadata, credentials } = await currentConnection(
      db,
      businessId,
      key,
    );
    const planRow = await db
      .prepare(
        `SELECT dc.plan_json,de.connection_id,de.calls_json,cba.limit_kopecks
         FROM direct_changes dc
         JOIN direct_executions de ON de.change_id=dc.id AND de.business_id=dc.business_id
         LEFT JOIN campaign_budget_allocations cba
           ON cba.business_id=dc.business_id AND cba.change_id=dc.id
         WHERE dc.id=? AND dc.business_id=? AND de.status='succeeded'`,
      )
      .get(action.change_id, businessId);
    const plan = json(planRow?.plan_json, {});
    const campaign = campaignId(planRow?.calls_json);
    const limit = Number(planRow?.limit_kopecks ?? plan.budget);
    if (
      metadata.sandbox === true ||
      planRow?.connection_id !== metadata.connectionId ||
      campaign === null ||
      !Number.isSafeInteger(limit) ||
      limit <= 0
    )
      throw new AppError(409, "Кампания или подключение изменились.");
    const client = directFactory({
      accessToken: credentials.access_token,
      login: plan.login,
      sandbox: false,
    });

    if (action.action === "pause_campaign") {
      possibleWrite = true;
      const resumed = await resumePostgresVerifiedCampaign(
        db,
        userId,
        businessId,
        action.change_id,
        requestKey,
        client,
        metadata.connectionId,
        {
          enabled: true,
          advertiserConfirmed: true,
          siteConfirmed: true,
          markingConfirmed: true,
          spendConfirmed: true,
          launchConfirmed: true,
          confirmCampaignId: campaign,
          confirmLimitKopecks: limit,
          now,
        },
      );
      status =
        resumed.status === "succeeded"
          ? "rolled_back"
          : resumed.status === "needs_reconciliation"
            ? "rollback_needs_reconciliation"
            : "applied";
      reason =
        status === "rolled_back"
          ? "Защитная остановка отменена; запуск подтверждён чтением Директа."
          : "Откат не считается завершённым без подтверждения Директа.";
    } else if (action.action === "consider_reallocation") {
      const value = json(action.guard_json, {})?.reallocation;
      if (!value)
        throw new AppError(
          409,
          "Исходные лимиты перераспределения не найдены.",
        );
      const [recipient, donor] = await Promise.all([
        client
          .campaignBudgetById(value.recipient.campaignId)
          .then((result) => remoteBudget(result, value.recipient.campaignId)),
        client
          .campaignBudgetById(value.donor.campaignId)
          .then((result) => remoteBudget(result, value.donor.campaignId)),
      ]);
      const expectedRecipient =
        value.recipient.previousLimitKopecks + value.transferKopecks;
      const expectedDonor =
        value.donor.previousLimitKopecks - value.transferKopecks;
      if (
        recipient.state !== "ON" ||
        donor.state !== "ON" ||
        recipient.limitKopecks !== expectedRecipient ||
        donor.limitKopecks !== expectedDonor
      )
        throw new AppError(409, "Лимиты изменились после перераспределения.");
      possibleWrite = true;
      await updateBudget(
        client,
        value.recipient.campaignId,
        recipient,
        value.recipient.previousLimitKopecks,
      );
      await updateBudget(
        client,
        value.donor.campaignId,
        donor,
        value.donor.previousLimitKopecks,
      );
      await db.transaction(async (tx) => {
        const at = new Date(now).toISOString();
        for (const [changeId, restored] of [
          [value.recipient.changeId, value.recipient.previousLimitKopecks],
          [value.donor.changeId, value.donor.previousLimitKopecks],
        ])
          await tx
            .prepare(
              `UPDATE campaign_budget_allocations
               SET limit_kopecks=?,updated_at=?
               WHERE business_id=? AND change_id=?`,
            )
            .run(restored, at, businessId, changeId);
      });
      status = "rolled_back";
      reason = "Прежние лимиты восстановлены; общий бюджет не изменился.";
    } else {
      throw new AppError(409, "Этот тип решения нельзя откатить.");
    }
  } catch {
    status = possibleWrite ? "rollback_needs_reconciliation" : "applied";
    reason = possibleWrite
      ? "Откат мог примениться частично; повтор запрещён до сверки Директа."
      : "Проверка перед откатом не пройдена; внешняя команда не отправлялась.";
  }

  return db.transaction(async (tx) => {
    await tx
      .prepare(
        "UPDATE optimizer_actions SET status=?,reason=?,updated_at=? WHERE id=? AND status='rollback_dispatching'",
      )
      .run(status, reason, new Date(now).toISOString(), action.id);
    if (status === "rolled_back" && action.action === "pause_campaign")
      await tx
        .prepare(
          "UPDATE campaign_ad_lifecycle SET status='active',reason=?,updated_at=? WHERE business_id=? AND change_id=? AND status='paused'",
        )
        .run(reason, new Date(now).toISOString(), businessId, action.change_id);
    await writeEvent(
      tx,
      businessId,
      {
        kind:
          status === "rolled_back"
            ? "optimizer_action_rolled_back"
            : status === "rollback_needs_reconciliation"
              ? "optimizer_rollback_uncertain"
              : "optimizer_rollback_not_applied",
        title:
          status === "rolled_back"
            ? "Решение отменено"
            : status === "rollback_needs_reconciliation"
              ? "Откат требует сверки"
              : "Откат не применён",
        reason,
        rule: "postgres-budget-guard/rollback@1",
        jobId: action.id,
      },
      now,
    );
    return { id: action.id, action: action.action, status, reason };
  });
}

export async function runPostgresOptimizerCycle(
  db,
  {
    key,
    config,
    now = Date.now(),
    directFactory = (options) => new DirectClient(options),
  } = {},
) {
  if (!canRunAutopilot(config)) return { status: "disabled" };
  if (config.production === true && !config.livePilotBusinessId)
    return { status: "disabled" };
  const action = await db.transaction(async (tx) => {
    const productionScope = config.production === true;
    const row = await tx
      .prepare(
        `SELECT * FROM optimizer_actions WHERE status='proposed'
         AND action IN ('pause_campaign','consider_reallocation')
         ${productionScope ? "AND business_id=?" : ""}
         ORDER BY created_at,ctid LIMIT 1 FOR UPDATE SKIP LOCKED`,
      )
      .get(...(productionScope ? [config.livePilotBusinessId] : []));
    if (!row) return null;
    await tx
      .prepare(
        "UPDATE optimizer_actions SET status='dispatching',updated_at=? WHERE id=?",
      )
      .run(new Date(now).toISOString(), row.id);
    return { ...row, status: "dispatching" };
  });
  if (!action) return { status: "idle" };
  return executeClaimedPostgresOptimizerAction(db, action, {
    key,
    config,
    now,
    directFactory,
  });
}

export async function recoverPostgresOptimizerDispatches(db, now = Date.now()) {
  const at = new Date(now).toISOString();
  const dispatching = await db
    .prepare(
      `UPDATE optimizer_actions SET status='needs_reconciliation',
       reason='Процесс прервался во время возможной записи; автоматический повтор запрещён.',
       updated_at=? WHERE status='dispatching'`,
    )
    .run(at);
  const rollback = await db
    .prepare(
      `UPDATE optimizer_actions SET status='rollback_needs_reconciliation',
       reason='Процесс прервался во время отката; повтор запрещён до сверки.',
       updated_at=? WHERE status='rollback_dispatching'`,
    )
    .run(at);
  return Number(dispatching.changes || 0) + Number(rollback.changes || 0);
}

export async function postgresAutopilotView(db, userId, businessId) {
  const owner = await db
    .prepare("SELECT 1 FROM businesses WHERE id=? AND user_id=?")
    .get(businessId, userId);
  if (!owner) throw new AppError(404, "Бизнес не найден.");
  const [reviews, actions] = await Promise.all([
    db
      .prepare(
        "SELECT result_json FROM direct_shadow_reviews WHERE business_id=? ORDER BY created_at DESC,ctid DESC LIMIT 20",
      )
      .all(businessId),
    db
      .prepare(
        "SELECT id,change_id,review_id,action,status,reason,guard_json,created_at,updated_at FROM optimizer_actions WHERE business_id=? ORDER BY created_at DESC,ctid DESC LIMIT 20",
      )
      .all(businessId),
  ]);
  return {
    shadowReviews: reviews.map((row) => json(row.result_json, {})),
    optimizerActions: actions.map((row) => ({
      id: row.id,
      changeId: row.change_id,
      reviewId: row.review_id,
      action: row.action,
      status: row.status,
      reason: row.reason,
      guard: json(row.guard_json, {}),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    })),
  };
}

export async function runPostgresAutopilotTick(
  db,
  { key, config, now = Date.now(), directFactory } = {},
) {
  return monitoredTick(
    config,
    async () => {
      const moderation = await pollPostgresPilotModeration(db, {
        key,
        config,
        now,
        ...(directFactory ? { directFactory } : {}),
      });
      const reportsQueued = await schedulePostgresAutopilotReports(
        db,
        now,
        config,
      );
      const reviewsQueued = await schedulePostgresShadowReviews(db, now);
      const shadow = await runPostgresShadowCycle(db, { key, config, now });
      const optimizer = await runPostgresOptimizerCycle(db, {
        key,
        config,
        now,
      });
      return {
        moderation: moderation.status,
        moderationChecked: moderation.checked,
        reportsQueued,
        reviewsQueued,
        shadow: shadow.status,
        optimizer: optimizer.status,
        paidWritesEnabled: canRunAutopilot(config),
      };
    },
    now,
  );
}

export function startPostgresAutopilotWorker(db, { key, config } = {}) {
  let pending = null;
  let stopped = false;
  let lastScheduled = 0;
  const scheduleEvery = Math.max(
    60_000,
    Number(config?.liveDataScheduleMs) || 300_000,
  );
  const tickEvery = Math.max(5_000, Number(config?.liveDataTickMs) || 15_000);
  const tick = () => {
    if (stopped || pending) return;
    const now = Date.now();
    pending = monitoredTick(
      config,
      async () => {
        let reportsQueued = 0;
        let reviewsQueued = 0;
        let moderation = { status: "idle", checked: 0 };
        if (now - lastScheduled >= scheduleEvery) {
          moderation = await pollPostgresPilotModeration(db, {
            key,
            config,
            now,
          });
          reportsQueued = await schedulePostgresAutopilotReports(
            db,
            now,
            config,
          );
          reviewsQueued = await schedulePostgresShadowReviews(db, now);
          lastScheduled = now;
        }
        const shadow = await runPostgresShadowCycle(db, { key, config, now });
        const optimizer = await runPostgresOptimizerCycle(db, {
          key,
          config,
          now,
        });
        return {
          moderation: moderation.status,
          moderationChecked: moderation.checked,
          reportsQueued,
          reviewsQueued,
          shadow: shadow.status,
          optimizer: optimizer.status,
          paidWritesEnabled: canRunAutopilot(config),
        };
      },
      now,
    )
      .catch(() =>
        console.error(
          JSON.stringify({ event: "postgres_autopilot_worker_error" }),
        ),
      )
      .finally(() => {
        pending = null;
      });
  };
  const timer = setInterval(tick, tickEvery);
  timer.unref();
  tick();
  return async () => {
    stopped = true;
    clearInterval(timer);
    if (pending) await pending;
  };
}
