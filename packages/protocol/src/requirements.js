/** Structured hold requirements. Plugins must not parse prose to learn these. */

export const REQUIREMENT_TYPES = Object.freeze([
  "acknowledgment",
  "commit",
  "commit-message",
  "state-recovery",
  "operator-confirmation",
]);

/**
 * @param {object} input
 * @param {string} input.id
 * @param {string} input.type
 * @param {"pending"|"satisfied"|"rejected"} [input.status]
 * @param {Record<string, unknown>} [input.metadata]
 */
export function createRequirement(input) {
  if (!input || !input.id) {
    throw new Error("requirement id is required");
  }
  if (!REQUIREMENT_TYPES.includes(input.type)) {
    throw new Error("requirement type is not in the closed set");
  }
  return {
    id: input.id,
    type: input.type,
    status: input.status || "pending",
    metadata: input.metadata || {},
  };
}
