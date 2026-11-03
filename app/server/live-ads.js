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
  if (config.autopilotEnabled === undefined) return canWritePaidAdvertising(config);
  return canWritePaidAdvertising(config) && config.autopilotEnabled === true;
}
