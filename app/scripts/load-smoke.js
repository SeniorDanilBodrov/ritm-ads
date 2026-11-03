import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  return Number.isInteger(parsed)
    ? Math.max(minimum, Math.min(maximum, parsed))
    : fallback;
}

function argument(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : null;
}

export function percentile(values, quantile) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b),
    index = Math.min(
      sorted.length - 1,
      Math.max(0, Math.ceil(sorted.length * quantile) - 1),
    );
  return sorted[index];
}

export async function runLoadSmoke({
  baseUrl = "http://127.0.0.1:4310",
  requests = 200,
  concurrency = 20,
  maxP95Ms = 500,
  fetcher = fetch,
  clock = () => performance.now(),
} = {}) {
  const origin = new URL(baseUrl);
  if (!["http:", "https:"].includes(origin.protocol))
    throw new Error("base URL must use HTTP or HTTPS");
  const total = boundedInteger(requests, 200, 1, 5_000),
    workers = boundedInteger(concurrency, 20, 1, 100),
    threshold = boundedInteger(maxP95Ms, 500, 1, 60_000),
    latencies = [],
    failures = [];
  let cursor = 0;
  async function worker() {
    while (true) {
      const index = cursor++;
      if (index >= total) return;
      const path = index % 2 ? "/api/ready" : "/api/health",
        started = clock();
      try {
        const response = await fetcher(new URL(path, origin), {
            signal: AbortSignal.timeout(5_000),
          }),
          body = await response.json();
        if (!response.ok || body.ok !== true)
          throw new Error(`unexpected ${response.status}`);
        if (path === "/api/ready" && body.ready !== true)
          throw new Error("service is not ready");
      } catch {
        failures.push(index);
      } finally {
        latencies.push(Math.max(0, clock() - started));
      }
    }
  }
  const started = clock();
  await Promise.all(Array.from({ length: workers }, () => worker()));
  const result = {
    schema: "ritm.load-smoke.v1",
    requests: total,
    concurrency: workers,
    failures: failures.length,
    durationMs: Math.round(clock() - started),
    latencyMs: {
      p50: Math.round(percentile(latencies, 0.5)),
      p95: Math.round(percentile(latencies, 0.95)),
      p99: Math.round(percentile(latencies, 0.99)),
      max: Math.round(Math.max(...latencies)),
    },
    thresholdMs: { p95: threshold },
  };
  return {
    ...result,
    passed: result.failures === 0 && result.latencyMs.p95 <= threshold,
  };
}

if (
  process.argv[1] &&
  resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1])
) {
  try {
    const result = await runLoadSmoke({
      baseUrl: argument("base-url") || "http://127.0.0.1:4310",
      requests: argument("requests") || 200,
      concurrency: argument("concurrency") || 20,
      maxP95Ms: argument("max-p95-ms") || 500,
    });
    console.log(JSON.stringify(result, null, 2));
    if (!result.passed) process.exitCode = 1;
  } catch (error) {
    console.error(`Load smoke не выполнен: ${error.message}`);
    process.exitCode = 1;
  }
}
