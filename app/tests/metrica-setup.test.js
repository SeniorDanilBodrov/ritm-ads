import { test } from "node:test";
import assert from "node:assert/strict";
import { buildMetricaSetup } from "../server/metrica-setup.js";

test("Metrica setup returns safe install code and the configured action goal", () => {
  const result = buildMetricaSetup({
    website: "https://www.example.ru/landing",
    counter: {
      id: 113772654,
      name: "Example",
      site: "example.ru",
      mirrors: [],
    },
    goal: {
      id: 674240488,
      name: "Заявка",
      type: "action",
      conditions: [{ type: "exact", url: "lead_sent" }],
    },
  });
  assert.equal(result.ready, true);
  assert.equal(result.goal.eventName, "lead_sent");
  assert.equal(
    result.installation.goalCall,
    'ym(113772654, "reachGoal", "lead_sent");',
  );
  assert.match(result.installation.counterCode, /tag\.js/);
  assert.match(result.installation.counterCode, /ym\(113772654,"init"/);
});

test("Metrica setup warns instead of inventing a call for a non-action goal", () => {
  const result = buildMetricaSetup({
    website: "https://shop.example.ru",
    counter: { id: 1, name: "Counter", site: "example.ru" },
    goal: { id: 2, name: "Visit", type: "url", conditions: [] },
  });
  assert.equal(result.ready, false);
  assert.equal(result.installation.goalCall, null);
  assert.equal(
    result.checks.find((item) => item.code === "action_goal").status,
    "warning",
  );
  assert.equal(
    result.checks.find((item) => item.code === "site_match").status,
    "warning",
  );
});

test("Metrica setup keeps a configured event from breaking a script block", () => {
  const result = buildMetricaSetup({
    counter: { id: 1, name: "Counter", site: "example.ru" },
    goal: {
      id: 2,
      name: "Event",
      type: "action",
      conditions: [{ type: "exact", url: "lead</script>sent" }],
    },
  });
  assert.equal(result.installation.goalCall.includes("</script>"), false);
  assert.match(result.installation.goalCall, /\\u003c\/script>/);
});
