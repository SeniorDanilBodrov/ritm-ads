import { parseTriggerDelivery } from "@neon/functions/triggers";

const workerUrl = process.env.RITM_WORKER_URL || "";
const workerToken = process.env.RITM_WORKER_TOKEN || "";

function configured() {
  try {
    return (
      new URL(workerUrl).protocol === "https:" && workerToken.length >= 32
    );
  } catch {
    return false;
  }
}

export default {
  async fetch(request: Request): Promise<Response> {
    const parsed = await parseTriggerDelivery(request);
    if (!parsed.ok) {
      return new Response(parsed.error, {
        status: parsed.error === "invalid_body" ? 400 : 401,
      });
    }
    if (parsed.invocation.type !== "schedule")
      return new Response("unsupported_trigger", { status: 400 });
    if (!configured())
      return new Response("worker_not_configured", { status: 503 });

    try {
      const response = await fetch(workerUrl, {
        method: "POST",
        headers: {
          authorization: `Bearer ${workerToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          scheduledAt: parsed.invocation.data.scheduledAt,
          invocationId: parsed.invocation.invocationId,
        }),
        signal: AbortSignal.timeout(120_000),
      });
      if (!response.ok)
        return Response.json(
          { ok: false, workerStatus: response.status },
          { status: 502 },
        );
      const result = await response.json();
      return Response.json({ ok: true, worker: result });
    } catch {
      return Response.json({ ok: false, workerStatus: null }, { status: 502 });
    }
  },
};
