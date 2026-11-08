import { createAdvertisingPlan } from "../server/ai-plan.js";
import { onboardingAssistant } from "../server/onboarding-chat.js";
import { REMOTE_ONBOARDING_JOB_KIND } from "../server/remote-onboarding.js";

const once = process.argv.includes("--once");
const server = String(process.env.REMOTE_AI_SERVER_URL || "").replace(/\/$/, "");
const token = process.env.REMOTE_AI_WORKER_TOKEN || "";
const model = process.env.OLLAMA_MODEL || "qwen3.5:4b";
const ollamaUrl = process.env.OLLAMA_URL || "http://127.0.0.1:11434";
const MODEL_KEEP_ALIVE_MS = 20 * 60_000;

if (!/^https:\/\//i.test(server) && !/^http:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?$/i.test(server))
  throw new Error("REMOTE_AI_SERVER_URL должен использовать HTTPS или локальный HTTP.");
if (token.length < 32) throw new Error("REMOTE_AI_WORKER_TOKEN должен содержать не менее 32 символов.");

const headers = {
  authorization: `Bearer ${token}`,
  "content-type": "application/json",
  origin: server,
  "x-ritm-request": "1",
  "x-ritm-worker-capabilities": "onboarding-v1",
};

async function request(path, body = {}) {
  const response = await fetch(`${server}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(65_000),
  });
  if (response.status === 204) return null;
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}

async function warmOllama() {
  const response = await fetch(new URL("/api/generate", ollamaUrl), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model,
      prompt: "",
      stream: false,
      keep_alive: "30m",
    }),
    signal: AbortSignal.timeout(90_000),
  });
  if (!response.ok) throw new Error("Ollama warm-up failed");
  await response.json();
}

async function cycle() {
  const job = await request("/api/internal/ai-worker/claim");
  if (!job) return false;
  process.stdout.write(`Рита обрабатывает задачу ${job.id.slice(0, 8)} (попытка ${job.attempt}).\n`);
  try {
    const result =
      job.kind === REMOTE_ONBOARDING_JOB_KIND
        ? await onboardingAssistant({
            message: job.message,
            profile: job.profile,
            history: job.history,
            config: {
              aiProvider: "ollama",
              aiOllamaUrl: ollamaUrl,
              aiModel: job.model || model,
            },
          })
        : await createAdvertisingPlan(job.state, {
            aiProvider: "ollama",
            aiOllamaUrl: ollamaUrl,
            aiModel: job.model || model,
          });
    if (result.provider !== "ollama") throw new Error("Ollama did not return a valid response");
    await request(`/api/internal/ai-worker/${encodeURIComponent(job.id)}/complete`, {
      attempt: job.attempt,
      result:
        job.kind === REMOTE_ONBOARDING_JOB_KIND
          ? result
          : {
              provider: "ollama",
              model: result.model,
              corrections: result.corrections,
              plan: result.plan,
            },
    });
    process.stdout.write(
      job.kind === REMOTE_ONBOARDING_JOB_KIND
        ? "Ответ Qwen передан Рите.\n"
        : "План проверен сервером и сохранён.\n",
    );
  } catch {
    await request(`/api/internal/ai-worker/${encodeURIComponent(job.id)}/fail`, {
      attempt: job.attempt,
    }).catch(() => {});
    process.stderr.write("Ollama не вернула проверяемый ответ; включён безопасный резервный сценарий.\n");
  }
  return true;
}

let delay = 5_000;
let nextWarmAt = 0;
do {
  try {
    if (Date.now() >= nextWarmAt) {
      await warmOllama();
      nextWarmAt = Date.now() + MODEL_KEEP_ALIVE_MS;
      process.stdout.write("Qwen загружена и готова отвечать Рите.\n");
    }
    const worked = await cycle();
    delay = worked ? 250 : 1_000;
  } catch {
    process.stderr.write("Render или Ollama временно недоступны; повторяем без потери задания.\n");
    delay = Math.min(120_000, Math.max(15_000, delay * 2));
  }
  if (!once) await new Promise((resolve) => setTimeout(resolve, delay));
} while (!once);
