import assert from "node:assert/strict";
import test from "node:test";
import { runAcceptanceSimulation } from "../server/acceptance-simulation.js";

test("acceptance simulation checks the live plan without mutating it", () => {
  const business = {
    mode: "live",
    name: "Форма",
    category: "Студия маникюра",
    city: "Екатеринбург",
    website: "https://forma.example/",
    service: "Маникюр с покрытием",
    benefit: "Бережный уход и удобная запись",
    price: 1900,
    budget: 3_000_000,
    targetCpa: 45_000,
    reservePercent: 10,
    timezone: "Asia/Yekaterinburg",
    periodStart: "2026-11-01",
    periodEnd: "2026-11-30",
    running: false,
    clientsTracked: false,
    counterId: "",
    goalId: "",
    campaigns: [],
    experiments: [],
    creatives: [],
    daily: [],
  };
  const plan = {
    name: "Форма · Поиск",
    budget: 3_000_000,
    ads: [
      {
        title: "Маникюр с покрытием",
        text: "Бережный уход и удобная запись",
      },
    ],
  };
  const before = structuredClone(business);
  const report = runAcceptanceSimulation(
    business,
    plan,
    Date.parse("2026-11-04T10:00:00.000Z"),
  );
  assert.deepEqual(business, before);
  assert.equal(report.status, "passed");
  assert.equal(report.mode, "simulation");
  assert.equal(report.externalWrites, 0);
  assert.equal(report.providerCalls, 0);
  assert.deepEqual(
    report.checks.map((item) => item.id),
    [
      "copy",
      "launch",
      "report",
      "guard",
      "rebalance",
      "borderline",
      "rollback",
      "ab",
      "budget",
    ],
  );
  assert.ok(report.checks.every((item) => item.status === "passed"));
});
