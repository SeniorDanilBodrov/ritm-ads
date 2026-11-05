import { isPilotOrigin } from "./security.js";

// The running process always supplies an explicit `liveAdsEnabled` value.
// The undefined branch keeps isolated module tests and legacy callers from
// silently changing behaviour; it is never used by server/index.js.
export function canWritePaidAdvertising(config = {}) {
  if (
    config.liveAdsEnabled === undefined &&
    config.encryptionConfigured === undefined &&
    config.origin === undefined
  )
    return true;
  if (config.liveAdsEnabled === undefined)
    return !!config.encryptionConfigured && isPilotOrigin(config.origin);
  return (
    config.liveAdsEnabled === true &&
    config.production === true &&
    config.encryptionConfigured === true &&
    /^https:\/\//.test(config.origin || "")
  );
}

export function canRunAutopilot(config = {}) {
  if (config.autopilotEnabled === undefined)
    return canWritePaidAdvertising(config);
  return canWritePaidAdvertising(config) && config.autopilotEnabled === true;
}

// Live launch and optimizer writes are deliberately scoped to one business
// during the production pilot. Read-only reporting and shadow reviews stay
// available for every connected business, but no paid write may escape this
// allowlist. Local/test environments keep their existing behavior so isolated
// contract tests do not need production identifiers.
export function canRunLivePilotForBusiness(config = {}, businessId) {
  if (!canWritePaidAdvertising(config)) return false;
  if (config.production !== true) return true;
  return (
    typeof config.livePilotBusinessId === "string" &&
    config.livePilotBusinessId.length > 0 &&
    config.livePilotBusinessId === businessId
  );
}

export function canRunAutopilotForBusiness(config = {}, businessId) {
  return (
    canRunAutopilot(config) && canRunLivePilotForBusiness(config, businessId)
  );
}
