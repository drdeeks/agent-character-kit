import { processPromptSubmit, processToolCall } from "../../../node/src/hooks/character.js";

/**
 * Hermes Node mapper. The installed companion is python/hermes_plugin/.
 * This module asks the same daemon RPCs as that plugin (execute_tool +
 * tool_tick, pick_prompt). It does not evaluate constitution locally.
 *
 * @param {object} [options]
 */
export function createHermesAdapter(options = {}) {
  return {
    async preToolCall(payload = {}) {
      const { output } = await processToolCall(payload, {
        framework: "hermes",
        ...options,
      });
      const blocked = Boolean(output && output.action === "block");
      const reason = (output && output.message) || "";
      return {
        blocked,
        hold: blocked && /acknowledge/i.test(reason),
        reason,
        output,
      };
    },
    async preLlmCall(payload = {}) {
      const { output } = await processPromptSubmit(payload, {
        framework: "hermes",
        ...options,
      });
      return output || {};
    },
  };
}
