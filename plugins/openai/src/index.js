import { ERROR_CODES, missingCapabilities, pluginError } from "@drdeeks/character-kit-protocol";
import { processPromptSubmit, processToolCall } from "../../../node/src/hooks/character.js";
import { detectOpenAiCapabilities } from "./capabilities.js";
import { mapOpenAiRequest } from "./request-mapper.js";
import { mapOpenAiDecision } from "./response-mapper.js";
import { mapOpenAiError } from "./error-mapper.js";

/**
 * OpenAI runtime mapper. Translates host events onto the live daemon via
 * processToolCall / processPromptSubmit. Does not evaluate constitution.
 * @param {object} [options]
 */
export function createOpenAiAdapter(options = {}) {
  return {
    async handleChatCompletions(body, headers = {}) {
      const mapped = mapOpenAiRequest(body, headers);
      const caps = detectOpenAiCapabilities(body);
      if (mapped.hasToolCall) {
        const missing = missingCapabilities(caps, { supportsToolInterception: true });
        if (missing.length) {
          return mapOpenAiError(
            pluginError(
              ERROR_CODES.CK_CAPABILITY_UNSUPPORTED,
              "tool interception is required to gate tool calls",
              { details: { missing } }
            )
          );
        }
        const { output } = await processToolCall(
          {
            hook_event_name: "PreToolUse",
            tool_name: mapped.tool,
            tool_input: mapped.params,
            session_id: mapped.context.sessionId,
          },
          { framework: "generic", ...options }
        );
        if (output && output.allow === false) {
          const hold = /acknowledge/i.test(output.reason || "");
          return mapOpenAiDecision({
            decision: hold ? "hold" : "deny",
            reason: output.reason,
            code: hold ? "CK_HOLD" : "CK_POLICY_DENIED",
          });
        }
        return mapOpenAiDecision({ decision: "allow" });
      }
      const { output } = await processPromptSubmit(
        { session_id: mapped.context.sessionId },
        { framework: "hermes", ...options }
      );
      return { action: "continue", injection: output };
    },
  };
}

export { detectOpenAiCapabilities } from "./capabilities.js";
export { mapOpenAiRequest } from "./request-mapper.js";
export { mapOpenAiDecision } from "./response-mapper.js";
export { mapOpenAiError } from "./error-mapper.js";
