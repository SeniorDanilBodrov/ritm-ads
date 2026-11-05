const digits = /^\d+$/;

export function usesDirectConversions(state = {}) {
  return state.landingMode === "yandex_landing";
}

export function analyticsAttribution(state = {}, plan = {}) {
  const planCounterId = String(plan.counterId || "");
  const planGoalId = String(plan.goalId || "");
  if (usesDirectConversions(state)) {
    const changed = Boolean(planCounterId || planGoalId);
    return {
      ready: !changed,
      changed,
      source: "direct_conversions",
    };
  }

  const stateCounterId = String(state.counterId || "");
  const stateGoalId = String(state.goalId || "");
  const ready = digits.test(stateCounterId) && digits.test(stateGoalId);
  return {
    ready,
    changed:
      ready && (stateCounterId !== planCounterId || stateGoalId !== planGoalId),
    source: "metrica",
  };
}
