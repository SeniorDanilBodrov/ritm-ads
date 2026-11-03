import { operationalSnapshot } from "./operations.js";

const DEFAULT_INTERVAL_MS = 60_000;

function severity(snapshot) {
  if (!snapshot?.ready) return "unavailable";
  if (snapshot.degraded) return "degraded";
  return "healthy";
}

export function operationalAlertPayload(snapshot, now = Date.now()) {
  const status = severity(snapshot);
  return {
    schema: "ritm.operations.v1",
    service: "ritm",
    status,
    occurredAt: new Date(now).toISOString(),
    summary: {
      ready: !!snapshot?.ready,
      degraded: !!snapshot?.degraded,
      database: {
        schemaVersion: Number(snapshot?.database?.schemaVersion || 0),
        expectedSchemaVersion: Number(
          snapshot?.database?.expectedSchemaVersion || 0,
        ),
      },
      queues: {
        pending: Number(snapshot?.queues?.pending || 0),
        ready: Number(snapshot?.queues?.ready || 0),
        running: Number(snapshot?.queues?.running || 0),
        stale: Number(snapshot?.queues?.stale || 0),
        failed: Number(snapshot?.queues?.failed || 0),
      },
      reconciliationRequired: Number(
        snapshot?.reconciliation?.required || 0,
      ),
    },
  };
}

export function validateOperationsWebhook(rawUrl) {
  if (!rawUrl) return null;
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("OPS_ALERT_WEBHOOK_URL must be a valid HTTPS URL");
  }
  if (url.protocol !== "https:")
    throw new Error("OPS_ALERT_WEBHOOK_URL must use HTTPS");
  return url.toString();
}

export async function sendOperationalAlert(
  webhookUrl,
  snapshot,
  {
    bearerToken,
    fetcher = fetch,
    now = Date.now(),
    timeoutMs = 10_000,
  } = {},
) {
  const url = validateOperationsWebhook(webhookUrl),
    headers = { "Content-Type": "application/json" };
  if (!url) return { sent: false, reason: "not_configured" };
  if (bearerToken) headers.Authorization = `Bearer ${bearerToken}`;
  const response = await fetcher(url, {
    method: "POST",
    headers,
    body: JSON.stringify(operationalAlertPayload(snapshot, now)),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error("operations webhook rejected the alert");
  return { sent: true, status: severity(snapshot) };
}

export function startOperationsMonitor(
  db,
  {
    webhookUrl,
    bearerToken,
    intervalMs = DEFAULT_INTERVAL_MS,
    fetcher = fetch,
    now = () => Date.now(),
    logger = console,
  } = {},
) {
  const url = validateOperationsWebhook(webhookUrl);
  if (!url) {
    const stop = async () => {};
    stop.checkNow = async () => {};
    return stop;
  }
  const delay = Math.max(30_000, Math.min(3_600_000, intervalMs));
  let stopped = false,
    pending = null,
    notifiedStatus = "healthy";

  const tick = () => {
    if (stopped || pending) return pending;
    pending = (async () => {
      const snapshot = operationalSnapshot(db, now()),
        current = severity(snapshot);
      if (current === notifiedStatus) return;
      await sendOperationalAlert(url, snapshot, {
        bearerToken,
        fetcher,
        now: now(),
      });
      notifiedStatus = current;
    })()
      .catch(() =>
        logger.error(JSON.stringify({ event: "operations_alert_failed" })),
      )
      .finally(() => {
        pending = null;
      });
    return pending;
  };

  const timer = setInterval(tick, delay);
  timer.unref();
  void tick();
  const stop = async () => {
    stopped = true;
    clearInterval(timer);
    if (pending) await pending;
  };
  stop.checkNow = tick;
  return stop;
}
