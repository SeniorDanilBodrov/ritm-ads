import { test } from "node:test";
import assert from "node:assert/strict";
import {
  seedDemo,
  totals,
  rebalance,
  assertBudget,
  tickDemo,
  optimize,
  rollback,
  experimentVerdict,
  freshBusiness,
  launchDemo,
  generateCreatives,
} from "../server/engine.js";

test("demo respects cap through 500 simulated days and pauses at exhaustion", () => {
  const s = seedDemo();
  let previous = totals(s).spent;
  for (let i = 0; i < 500 && s.running; i++) {
    tickDemo(s);
    assertBudget(s);
    assert.ok(totals(s).spent >= previous);
    previous = totals(s).spent;
    assert.ok(previous <= s.budget * (1 - s.reservePercent / 100));
  }
  assert.equal(s.running, false);
});
test("cannot decrease budget below incurred spend or remove reserve", () => {
  const s = seedDemo();
  s.budget = totals(s).spent - 1;
  assert.throws(() => rebalance(s), /резерв/);
  const t = seedDemo();
  t.budget = totals(t).spent;
  assert.throws(() => rebalance(t), /резерв/);
});
test("rebalance conserves already spent money and total allocation", () => {
  const s = seedDemo();
  s.budget = 5000000;
  const before = s.campaigns.map((c) => c.spent);
  rebalance(s);
  assert.deepEqual(
    s.campaigns.map((c) => c.spent),
    before,
  );
  assertBudget(s);
  assert.equal(
    s.campaigns.reduce((a, c) => a + c.allocation, 0),
    4500000,
  );
});
test("optimizer pauses losing ads and transfers only unused allocation", () => {
  const s = seedDemo();
  const c = s.campaigns[3];
  c.status = "active";
  c.spent = 140000;
  const spent = totals(s).spent;
  const changes = optimize(s);
  assert.equal(c.status, "paused");
  assert.ok(changes.some((e) => e.kind === "pause"));
  assert.ok(changes.some((e) => e.kind === "rebalance"));
  assert.equal(totals(s).spent, spent);
  assertBudget(s);
});
test("rollback restores limits and rejects later changes", () => {
  const s = seedDemo();
  const change = optimize(s).find((e) => e.kind === "rebalance");
  change.id = "x";
  const before = change.before;
  rollback(s, change, []);
  assert.deepEqual(
    s.campaigns.map((c) => c.allocation),
    before.map((c) => c.allocation),
  );
  assert.throws(
    () => rollback(s, change, [{ rollbackOf: "x" }]),
    /уже отменено/,
  );
  const b = seedDemo(),
    entry = optimize(b).find((e) => e.kind === "rebalance");
  b.campaigns[0].spent += 100;
  assert.throws(() => rollback(b, entry, []), /новые данные/);
});
test("experiment analyses each update without day or click thresholds", () => {
  const e = {
    elapsedDays: 20,
    maxDays: 21,
    minDays: 7,
    minClicks: 100,
    variants: [
      { clicks: 1000, leads: 10 },
      { clicks: 1000, leads: 200 },
    ],
  };
  assert.equal(experimentVerdict(e).winner, 1);
  e.variants = [
    { clicks: 1000, leads: 100 },
    { clicks: 1000, leads: 105 },
  ];
  assert.equal(experimentVerdict(e), null);
  e.variants[0].clicks = 50;
  assert.equal(experimentVerdict(e), null);
});
test("seed experiment can finish and applies its verdict", () => {
  const s = seedDemo();
  for (let i = 0; i < 17; i++) tickDemo(s);
  const e = s.experiments[0];
  assert.equal(e.status, "completed");
  assert.equal(e.winner, 1);
  assert.ok(s.campaigns[2].selectedVariant);
});
test("new business needs analytics and approved text, no live writes", () => {
  const s = freshBusiness({
    name: "Студия",
    service: "Маникюр",
    city: "Екатеринбург",
    benefit: "Точная запись",
    budget: 3000000,
    targetCpa: 45000,
    price: 1000,
  });
  s.creatives = generateCreatives(s);
  assert.throws(() => launchDemo(s), /аналитику/);
  s.counterId = "demo";
  s.goalId = "form";
  assert.throws(() => launchDemo(s), /согласуйте/);
  s.creatives[0].status = "approved";
  launchDemo(s);
  assert.equal(s.campaigns.length, 2);
  assertBudget(s);
  assert.throws(() => launchDemo({ ...s, mode: "live" }), /закрыт/);
});
