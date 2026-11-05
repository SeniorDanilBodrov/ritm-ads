import test from "node:test";
import assert from "node:assert/strict";
import {
  canRunAutopilot,
  canRunAutopilotForBusiness,
  canRunLivePilotForBusiness,
  canWritePaidAdvertising,
} from "../server/live-ads.js";

const base = {
  production: true,
  encryptionConfigured: true,
  origin: "https://ritm.example",
};

test("paid advertising is fail-closed until production, HTTPS and opt-in agree", () => {
  assert.equal(
    canWritePaidAdvertising({ ...base, liveAdsEnabled: true }),
    true,
  );
  assert.equal(
    canWritePaidAdvertising({ ...base, liveAdsEnabled: false }),
    false,
  );
  assert.equal(
    canWritePaidAdvertising({
      ...base,
      production: false,
      liveAdsEnabled: true,
    }),
    false,
  );
  assert.equal(
    canWritePaidAdvertising({
      ...base,
      origin: "http://localhost:4310",
      liveAdsEnabled: true,
    }),
    false,
  );
  assert.equal(
    canWritePaidAdvertising({
      ...base,
      encryptionConfigured: false,
      liveAdsEnabled: true,
    }),
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

test("production live writes are restricted to the single pilot business", () => {
  const config = {
    ...base,
    liveAdsEnabled: true,
    autopilotEnabled: true,
    livePilotBusinessId: "pilot-business",
  };
  assert.equal(canRunLivePilotForBusiness(config, "pilot-business"), true);
  assert.equal(canRunLivePilotForBusiness(config, "another-business"), false);
  assert.equal(
    canRunLivePilotForBusiness(
      { ...config, livePilotBusinessId: "" },
      "pilot-business",
    ),
    false,
  );
  assert.equal(canRunAutopilotForBusiness(config, "pilot-business"), true);
  assert.equal(canRunAutopilotForBusiness(config, "another-business"), false);
  assert.equal(
    canRunLivePilotForBusiness(
      { ...config, production: false, livePilotBusinessId: "" },
      "local-business",
    ),
    false,
  );
});

test("production owner-confirmed mode allows each isolated business", () => {
  const config = {
    ...base,
    liveAdsEnabled: true,
    autopilotEnabled: true,
    livePilotBusinessId: "*",
  };
  assert.equal(canRunLivePilotForBusiness(config, "business-a"), true);
  assert.equal(canRunLivePilotForBusiness(config, "business-b"), true);
  assert.equal(canRunLivePilotForBusiness(config, ""), false);
  assert.equal(canRunAutopilotForBusiness(config, "business-a"), true);
  assert.equal(canRunAutopilotForBusiness(config, "business-b"), true);
});
