import test from "node:test";
import assert from "node:assert/strict";
import { canRunAutopilot, canWritePaidAdvertising } from "../server/live-ads.js";

const base = {
  production: true,
  encryptionConfigured: true,
  origin: "https://ritm.example",
};

test("paid advertising is fail-closed until production, HTTPS and opt-in agree", () => {
  assert.equal(canWritePaidAdvertising({ ...base, liveAdsEnabled: true }), true);
  assert.equal(canWritePaidAdvertising({ ...base, liveAdsEnabled: false }), false);
  assert.equal(
    canWritePaidAdvertising({ ...base, production: false, liveAdsEnabled: true }),
    false,
  );
  assert.equal(
    canWritePaidAdvertising({ ...base, origin: "http://localhost:4310", liveAdsEnabled: true }),
    false,
  );
  assert.equal(
    canWritePaidAdvertising({ ...base, encryptionConfigured: false, liveAdsEnabled: true }),
    false,
  );
});

test("autopilot has its own explicit switch after paid writes are allowed", () => {
  assert.equal(
    canRunAutopilot({ ...base, liveAdsEnabled: true, autopilotEnabled: true }),
    true,
  );
  assert.equal(
    canRunAutopilot({ ...base, liveAdsEnabled: true, autopilotEnabled: false }),
    false,
  );
  assert.equal(
    canRunAutopilot({ ...base, liveAdsEnabled: false, autopilotEnabled: true }),
    false,
  );
});
