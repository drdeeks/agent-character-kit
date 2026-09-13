import { CharacterKitCore } from "@drdeeks/character-kit-core";
import { toV0ToolResult } from "@drdeeks/character-kit-protocol";

/**
 * Thin factory. This module does not evaluate constitution, habits, or
 * allow/deny lists itself. Production hosts must pass `options.core` that
 * talks to the ACK daemon (`processToolCall` / `EnforcerClient`).
 *
 * The default `CharacterKitCore` is an in-process engine for unit tests.
 * It is not the live 1.6.0 enforcer.
 *
 * @param {object} [options]
 * @param {object} [options.core] daemon-backed core; required in production
 */
export function createCompanion(options = {}) {
  const core = options.core || new CharacterKitCore(options);

  return {
    core,
    async initialize(context) {
      return core.initialize(context);
    },
    async beforeModel(input) {
      return core.beforeModel(input);
    },
    async beforeTool(input) {
      return core.beforeTool(input);
    },
    async submitAcknowledgment(input) {
      return core.submitAcknowledgment(input);
    },
    async shutdown() {
      return core.shutdown();
    },
    async onToolCall(request) {
      const decision = await core.beforeTool(request);
      return toV0ToolResult(decision);
    },
  };
}
