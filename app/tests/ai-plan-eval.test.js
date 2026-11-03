import { readFileSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  advertisingPlanSchema,
  fallbackAdvertisingPlan,
} from "../server/ai-plan.js";

const fixtures = JSON.parse(
  readFileSync(new URL("./fixtures/ai-plan-businesses.json", import.meta.url), "utf8"),
);

const forbiddenClaims =
  /скидк|акци|лучший|лучшая|№\s*1|рейтинг\s*\d|лицензи|гаранти/iu;

test("AI plan eval set covers at least 15 distinct business categories", () => {
  assert.ok(fixtures.length >= 15);
  assert.equal(
    new Set(fixtures.map((item) => item.category.toLocaleLowerCase("ru"))).size,
    fixtures.length,
  );
});

for (const fixture of fixtures) {
  test(`AI plan eval: ${fixture.category}`, () => {
    const state = {
      ...fixture,
      website: "https://example.test",
      budget: 3_000_000,
      periodStart: "2026-11-05",
      periodEnd: "2026-11-30",
    };
    const plan = fallbackAdvertisingPlan(state);

    assert.deepEqual(advertisingPlanSchema.parse(plan), plan);
    assert.ok(plan.summary.length >= 30);
    assert.ok(plan.audiences.length >= 1);
    assert.ok(plan.ads.length >= 3);
    assert.equal(
      new Set(plan.ads.map((ad) => `${ad.title}\n${ad.text}`.toLocaleLowerCase("ru"))).size,
      plan.ads.length,
    );
    assert.equal(
      new Set(plan.ads.map((ad) => ad.angle.toLocaleLowerCase("ru"))).size,
      plan.ads.length,
    );
    assert.ok(plan.ads.every((ad) => ad.title.length <= 56 && ad.text.length <= 81));
    assert.ok(plan.keywords.length >= 3);
    assert.equal(
      plan.budgetAllocation.reduce((sum, item) => sum + item.percent, 0),
      100,
    );
    assert.equal(plan.abHypotheses.length >= 1, true);
    assert.equal(
      plan.ads.some((ad) =>
        forbiddenClaims.test(`${ad.title} ${ad.text}`),
      ),
      false,
    );
  });
}
