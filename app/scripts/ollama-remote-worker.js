import { createAdvertisingPlan } from "../server/ai-plan.js";

const once = process.argv.includes("--once");
const server = String(process.env.REMOTE_AI_SERVER_URL || "").replace(/\/$/, "");
const token = process.env.REMOTE_AI_WORKER_TOKEN || "";
const model = process.env.OLLAMA_MODEL || "qwen3.5:4b";
const ollamaUrl = process.env.OLLAMA_URL || "http://127.0.0.1:11434";

if (!/^https:\/\//i.test(server) && !/^http:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?$/i.test(server))
  throw new Error("REMOTE_AI_SERVER_URL должен использовать HTTPS или локальный HTTP.");
if (token.length < 32) throw new Error("REMOTE_AI_WORKER_TOKEN должен содержать не менее 32 символов.");

const headers = {
  authorization: `Bearer ${token}`,
  "content-type": "application/json",
  origin: server,
  "x-ritm-request": "1",
};

async function request(path, body = {}) {
  const response = await fetch(`${server}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(45_000),
  });
  if (response.status === 204) return null;
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}

async function cycle() {
  const job = await request("/api/internal/ai-worker/claim");
  if (!job) return false;
  process.stdout.write(`Рита обрабатывает задачу ${job.id.slice(0, 8)} (попытка ${job.attempt}).\n`);
  try {
    const result = await createAdvertisingPlan(job.state, {
      aiProvider: "ollama",
      aiOllamaUrl: ollamaUrl,
      aiModel: job.model || model,
    });
    if (result.provider !== "ollama") throw new Error("Ollama did not return a valid plan");
    await request(`/api/internal/ai-worker/${encodeURIComponent(job.id)}/complete`, {
      attempt: job.attempt,
      result: {
        provider: "ollama",
        model: result.model,
        corrections: result.corrections,
        plan: result.plan,
      },
    });
    process.stdout.write("План проверен сервером и сохранён.\n");
  } catch {
    await request(`/api/internal/ai-worker/${encodeURIComponent(job.id)}/fail`, {
      attempt: job.attempt,
    }).catch(() => {});
    process.stderr.write("Ollama не вернула проверяемый план; задача будет повторена безопасно.\n");
  }
  return true;
}

let delay = 5_000;
do {
  try {
    const worked = await cycle();
    delay = worked ? 2_000 : 30_000;
  } catch {
    process.stderr.write("Render временно недоступен; повторяем без потери задания.\n");
    delay = Math.min(120_000, Math.max(15_000, delay * 2));
  }
  if (!once) await new Promise((resolve) => setTimeout(resolve, delay));
} while (!once);
