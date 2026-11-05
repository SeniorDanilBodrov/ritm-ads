import assert from "node:assert/strict";
import test from "node:test";
import { analyticsAttribution } from "../server/analytics-attribution.js";

test("Yandex landing uses Direct conversions only for a matching plan", () => {
  assert.deepEqual(
    analyticsAttribution({ landingMode: "yandex_landing" }, {}),
    {
      ready: true,
      changed: false,
      source: "direct_conversions",
    },
  );
  assert.deepEqual(
    analyticsAttribution(
      { landingMode: "yandex_landing" },
      { counterId: "123", goalId: "456" },
    ),
    {
      ready: false,
      changed: true,
      source: "direct_conversions",
    },
  );
});

test("own site requires the same Metrica counter and goal as its plan", () => {
  assert.deepEqual(
    analyticsAttribution(
      { landingMode: "external", counterId: "123", goalId: "456" },
      { counterId: "123", goalId: "456" },
    ),
    { ready: true, changed: false, source: "metrica" },
  );
  assert.deepEqual(
    analyticsAttribution(
      { landingMode: "external", counterId: "123", goalId: "789" },
      { counterId: "123", goalId: "456" },
    ),
    { ready: true, changed: true, source: "metrica" },
  );
});
