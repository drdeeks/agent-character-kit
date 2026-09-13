/** Policy effects combine as DENY > HOLD > ALLOW. */

export const EFFECTS = Object.freeze({
  allow: "allow",
  hold: "hold",
  deny: "deny",
});

const RANK = Object.freeze({
  deny: 3,
  hold: 2,
  allow: 1,
});

/**
 * @param {Array<{ effect: string }|null|undefined>} results
 * @returns {{ effect: string, reason?: string, code?: string, requirements?: object[] }}
 */
export function aggregateEffects(results) {
  let best = { effect: EFFECTS.allow };
  for (const item of results) {
    if (!item || !item.effect) continue;
    if ((RANK[item.effect] || 0) > (RANK[best.effect] || 0)) {
      best = item;
    }
  }
  return best;
}

/**
 * @param {object} input
 * @param {"allow"|"hold"|"deny"} input.decision
 * @param {string} [input.reason]
 * @param {object[]} [input.requirements]
 * @param {boolean} [input.retryable]
 * @param {string} [input.code]
 * @param {string} [input.stateVersion]
 * @param {object} [input.injected]
 */
export function createToolDecision(input) {
  const decision = input && input.decision;
  if (!decision || !RANK[decision]) {
    throw new Error("tool decision must be allow, hold, or deny");
  }
  return {
    decision,
    reason: input.reason,
    requirements: input.requirements || [],
    retryable: Boolean(input.retryable),
    code: input.code,
    stateVersion: input.stateVersion || "0",
    injected: input.injected,
  };
}

/**
 * Map v1 ToolDecision onto the v0 daemon-shaped fields current companions expect.
 * @param {ReturnType<typeof createToolDecision>} decision
 */
export function toV0ToolResult(decision) {
  return {
    allowed: decision.decision === EFFECTS.allow,
    denied: decision.decision === EFFECTS.deny,
    hold: decision.decision === EFFECTS.hold,
    reason: decision.reason,
    code: decision.code,
    requirements: decision.requirements,
    stateVersion: decision.stateVersion,
  };
}
