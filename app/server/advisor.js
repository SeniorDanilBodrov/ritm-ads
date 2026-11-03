import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { AppError } from "./db.js";
export function analyzeSnapshot(state) {
  const executable = process.env.PYTHON_EXECUTABLE;
  if (!executable)
    throw new AppError(
      503,
      "Укажите PYTHON_EXECUTABLE на сервере, чтобы включить Python-анализ.",
      "python_missing",
    );
  const snapshot = {
    targetCpa: state.targetCpa,
    campaigns: state.campaigns.map((c) => ({
      id: c.id,
      spent: c.spent,
      leads: c.leads,
      clicks: c.clicks,
      status: c.status,
    })),
  };
  return new Promise((resolveResult, reject) => {
    const child = spawn(executable, [resolve("ai/advisor.py")], {
      windowsHide: true,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        PATH: process.env.PATH || "",
        SystemRoot: process.env.SystemRoot || "",
        PYTHONUTF8: "1",
        AI_PROVIDER: process.env.AI_PROVIDER || "rules",
        OLLAMA_URL: process.env.OLLAMA_URL || "http://127.0.0.1:11434",
        OLLAMA_MODEL: process.env.OLLAMA_MODEL || "",
      },
    });
    let output = "",
      size = 0,
      settled = false;
    const timer = setTimeout(() => {
      child.kill();
      fail(
        new AppError(
          504,
          "Анализ не завершился за 40 секунд. Попробуйте позже.",
        ),
      );
    }, 40000);
    const fail = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    };
    child.on("error", () =>
      fail(
        new AppError(
          503,
          "Не удалось запустить Python. Проверьте PYTHON_EXECUTABLE.",
        ),
      ),
    );
    child.stdin.on("error", () => {});
    child.stderr.resume();
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      size += Buffer.byteLength(chunk);
      if (size > 100000) {
        child.kill();
        fail(new AppError(502, "Ответ аналитика слишком велик."));
      } else output += chunk;
    });
    child.on("close", (code) => {
      if (settled) return;
      if (code !== 0)
        return fail(
          new AppError(
            502,
            "Анализ не прошел проверку или модель недоступна. Реклама не изменена.",
          ),
        );
      try {
        const data = JSON.parse(output);
        if (data.executed !== false || !Array.isArray(data.proposals))
          throw new Error();
        settled = true;
        clearTimeout(timer);
        resolveResult(data);
      } catch {
        fail(new AppError(502, "Некорректный ответ аналитика."));
      }
    });
    child.stdin.end(JSON.stringify(snapshot));
  });
}
