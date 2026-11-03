import { spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const startedAt = new Date(),
  reportPath = resolve(
    process.env.ACCEPTANCE_REPORT_PATH || "./data/acceptance-report.json",
  ),
  steps = [];

function run(name, command, args, { optional = false } = {}) {
  const started = Date.now();
  console.log(`\n[acceptance] ${name}`);
  const result = spawnSync(command, args, {
    stdio: "inherit",
    windowsHide: true,
    env: process.env,
  });
  const unavailable = result.error?.code === "ENOENT";
  if (unavailable && optional) {
    steps.push({ name, status: "skipped", reason: "tool_unavailable" });
    console.log(`[acceptance] ${name}: пропущено — инструмент не установлен`);
    return false;
  }
  const ok = !result.error && result.status === 0;
  steps.push({
    name,
    status: ok ? "passed" : "failed",
    exitCode: result.status,
    durationMs: Date.now() - started,
  });
  if (!ok) {
    const detail = result.error?.message || `exit code ${result.status}`;
    throw new Error(`${name}: ${detail}`);
  }
  return true;
}

function pythonCommand() {
  const configured = process.env.PYTHON_EXECUTABLE;
  if (configured) return { command: configured, prefix: [] };
  const candidates =
    process.platform === "win32"
      ? [
          { command: "python", prefix: [] },
          { command: "py", prefix: ["-3"] },
        ]
      : [
          { command: "python3", prefix: [] },
          { command: "python", prefix: [] },
        ];
  return candidates.find(({ command, prefix }) => {
    const check = spawnSync(command, [...prefix, "--version"], {
      stdio: "ignore",
      windowsHide: true,
    });
    return !check.error && check.status === 0;
  });
}

let failure = null;
try {
  const python = pythonCommand(),
    testFiles = readdirSync(resolve("tests"))
      .filter((name) => name.endsWith(".test.js"))
      .map((name) => resolve("tests", name));
  if (process.env.LIVE_ADS_ENABLED === "true")
    throw new Error(
      "LIVE_ADS_ENABLED=true запрещён для безопасной локальной приёмки",
    );
  run("Node/API tests", process.execPath, [
    "--test",
    "--test-concurrency=1",
    ...testFiles,
  ]);
  run("TypeScript check", process.execPath, [
    resolve("node_modules/typescript/bin/tsc"),
    "--noEmit",
  ]);
  run("Production UI build", process.execPath, [
    resolve("node_modules/vite/bin/vite.js"),
    "build",
  ]);
  if (!python) throw new Error("Python 3.10+ не найден");
  run("Python analyst tests", python.command, [
    ...python.prefix,
    "-m",
    "unittest",
    "discover",
    "-s",
    "ai",
    "-p",
    "test_*.py",
    "-v",
  ]);
  run("Database readiness", process.execPath, ["scripts/check-operations.js"]);
  const hasDocker = run(
    "Docker Compose configuration",
    "docker",
    ["compose", "config", "--quiet"],
    { optional: true },
  );
  if (hasDocker && process.argv.includes("--docker")) {
    run("Docker image build", "docker", ["compose", "build"]);
    run("Docker production preflight", "docker", [
      "compose",
      "run",
      "--rm",
      "--no-deps",
      "app",
      "node",
      "scripts/production-preflight.js",
      "--strict",
    ]);
  }
} catch (error) {
  failure = error;
} finally {
  const finishedAt = new Date(),
    report = {
      schema: "ritm.acceptance.v1",
      status: failure ? "failed" : "passed",
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      durationMs: finishedAt.getTime() - startedAt.getTime(),
      runtime: { node: process.version, platform: process.platform },
      safety: { liveAdsEnabled: process.env.LIVE_ADS_ENABLED === "true" },
      steps,
    };
  mkdirSync(dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n", {
    flag: "w",
    mode: 0o600,
  });
  console.log(`\n[acceptance] отчёт: ${reportPath}`);
}

if (failure) {
  console.error(`[acceptance] FAILED: ${failure.message}`);
  process.exitCode = 1;
} else {
  console.log("[acceptance] PASSED");
}
