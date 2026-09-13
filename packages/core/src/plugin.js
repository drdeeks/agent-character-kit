import {
  ERROR_CODES,
  createRequirement,
  createToolDecision,
  missingCapabilities,
  normalizeContext,
  pluginError,
} from "@drdeeks/character-kit-protocol";
import { PolicyEngine } from "./policy/engine.js";
import { InMemoryStateStore } from "./state/memory-store.js";

function idempotencyKey(context) {
  return [context.sessionId, context.runId, context.toolCallId || context.runId].join(":");
}

/**
 * Host-neutral CharacterKitPlugin. Host adapters call this; they do not evaluate policy.
 */
export class CharacterKitCore {
  /**
   * @param {object} [options]
   * @param {import("./policy/engine.js").Policy} [options.policy]
   * @param {InMemoryStateStore} [options.store]
   * @param {object} [options.requiredCapabilities]
   */
  constructor(options = {}) {
    this.engine = new PolicyEngine(options.policy || {});
    this.store = options.store || new InMemoryStateStore();
    this.requiredCapabilities = options.requiredCapabilities || {};
    this.capabilities = options.capabilities || {};
    this.stateVersion = "1";
  }

  async initialize(context) {
    normalizeContext(context);
    const missing = missingCapabilities(this.capabilities, this.requiredCapabilities);
    if (missing.length) {
      throw pluginError(
        ERROR_CODES.CK_CAPABILITY_UNSUPPORTED,
        "host is missing required capabilities",
        { details: { missing } }
      );
    }
  }

  async beforeModel(input) {
    return {
      instructions: undefined,
      metadata: { injected: false, injectionIds: [] },
      context: normalizeContext(input?.context || {}),
    };
  }

  async beforeTool(input) {
    const context = normalizeContext(input?.context || {});
    const key = idempotencyKey(context);
    const prior = await this.store.recallDecision(key);
    if (prior) return prior;

    const verdict = await this.engine.evaluate({
      tool: input.tool,
      command: input.command,
      params: input.params || {},
    });

    let decision;
    if (verdict.effect === "deny") {
      decision = createToolDecision({
        decision: "deny",
        reason: verdict.reason,
        retryable: false,
        code: verdict.code || ERROR_CODES.CK_POLICY_DENIED,
        stateVersion: this.stateVersion,
      });
    } else if (verdict.effect === "hold") {
      decision = createToolDecision({
        decision: "hold",
        reason: "acknowledge habits",
        retryable: true,
        code: ERROR_CODES.CK_ACK_REQUIRED,
        stateVersion: this.stateVersion,
        requirements: [
          createRequirement({ id: "ack-1", type: "acknowledgment" }),
          createRequirement({ id: "ack-2", type: "acknowledgment" }),
        ],
      });
    } else {
      decision = createToolDecision({
        decision: "allow",
        retryable: false,
        stateVersion: this.stateVersion,
      });
    }

    await this.store.rememberDecision(key, decision);
    return decision;
  }

  async submitAcknowledgment(input) {
    const statement = String(input?.statement || "").trim();
    if (!statement.startsWith("Habit:")) {
      return {
        ok: false,
        error: pluginError(ERROR_CODES.CK_ACK_INVALID, "acknowledgment must start with Habit:"),
      };
    }
    return { ok: true };
  }

  async shutdown() {}
}
