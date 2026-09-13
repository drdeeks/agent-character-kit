/**
 * Map a Character Kit ToolDecision onto an OpenAI-compatible error or pass-through.
 * Hosts execute tools only when decision is allow.
 * @param {object} decision
 */
export function mapOpenAiDecision(decision) {
  if (decision.decision === "allow") {
    return { action: "execute" };
  }
  if (decision.decision === "hold") {
    return {
      action: "hold",
      error: {
        type: "character_kit_hold",
        code: decision.code,
        message: decision.reason || "hold",
        requirements: decision.requirements || [],
      },
    };
  }
  return {
    action: "deny",
    error: {
      type: "character_kit_denied",
      code: decision.code,
      message: decision.reason || "denied",
    },
  };
}
