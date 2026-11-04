import { defineConfig } from "@neon/config/v1";

function required(name: "RITM_WORKER_URL" | "RITM_WORKER_TOKEN") {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required for Neon deployment`);
  return value;
}

export default defineConfig({
  functions: {
    autopilotcron: {
      name: "Ritm autopilot scheduler",
      source: "neon/functions/autopilot-cron/index.ts",
      env: {
        RITM_WORKER_URL: required("RITM_WORKER_URL"),
        RITM_WORKER_TOKEN: required("RITM_WORKER_TOKEN"),
      },
    },
  },
  triggers: {
    "ritm-autopilot-every-15-min": {
      type: "schedule",
      function: "autopilotcron",
      cron: "*/15 * * * *",
      enabled: true,
    },
  },
});
