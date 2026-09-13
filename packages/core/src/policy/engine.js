import { EFFECTS, aggregateEffects } from "@drdeeks/character-kit-protocol";

/**
 * Glob-ish matcher. `*` is a wildcard. Used by allow-list mode.
 * @param {string} pattern
 * @param {string} value
 */
export function matchesPattern(pattern, value) {
  if (!pattern || value == null) return false;
  if (pattern === value) return true;
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp("^" + escaped + "$").test(String(value));
}

/**
 * Live 1.6.0 daemon matcher. Deny/hard-constraint: case-insensitive
 * substring on `tool + command`. Allow-list: glob against tool, full
 * command, or first token.
 * @param {string} pattern
 * @param {string} tool
 * @param {string} command
 * @param {boolean} [allowMode]
 */
export function matchConstraint(pattern, tool, command, allowMode = false) {
  const p = String(pattern || "").trim();
  if (!p) return false;
  const hay = `${tool} ${command}`.toLowerCase();
  if (!allowMode && hay.includes(p.toLowerCase())) return true;
  if (allowMode) {
    const rx = new RegExp(
      "^" + p.toLowerCase().replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$"
    );
    const candidates = [
      String(tool || "").toLowerCase(),
      String(command || "").toLowerCase(),
      (command || "").toLowerCase().split(/\s+/)[0] || "",
    ];
    return candidates.some((c) => rx.test(c));
  }
  return false;
}

/**
 * @typedef {object} Policy
 * @property {string[]} [hardConstraints]
 * @property {string[]} [denyList]
 * @property {string[]} [allowList]
 */

/**
 * Evaluate a tool request. First matching hard constraint denies.
 * A non-empty allow list denies anything that does not match.
 *
 * @param {{ tool?: string, command?: string, params?: Record<string, unknown> }} request
 * @param {Policy} policy
 */
export function evaluatePolicy(request, policy = {}) {
  const tool = String(request.tool || "");
  const command = String(request.command || request.params?.command || "");
  const results = [];

  for (const pattern of policy.hardConstraints || []) {
    if (matchConstraint(pattern, tool, command, false)) {
      results.push({
        effect: EFFECTS.deny,
        reason: "hard constraint",
        code: "CK_POLICY_DENIED",
        matched_by: pattern,
      });
    }
  }

  for (const pattern of policy.denyList || []) {
    if (matchConstraint(pattern, tool, command, false)) {
      results.push({
        effect: EFFECTS.deny,
        reason: "deny list",
        code: "CK_POLICY_DENIED",
        matched_by: pattern,
      });
    }
  }

  const allow = policy.allowList || [];
  if (allow.length > 0) {
    const ok = allow.some((pattern) => matchConstraint(pattern, tool, command, true));
    if (!ok) {
      results.push({
        effect: EFFECTS.deny,
        reason: "not on allow list",
        code: "CK_POLICY_DENIED",
      });
    }
  }

  if (results.length === 0) {
    results.push({ effect: EFFECTS.allow });
  }
  return aggregateEffects(results);
}

export class PolicyEngine {
  /**
   * @param {Policy} policy
   * @param {Array<{ name: string, evaluate: Function }>} [evaluators]
   */
  constructor(policy = {}, evaluators = []) {
    this.policy = policy;
    this.evaluators = [...evaluators];
  }

  registerEvaluator(evaluator) {
    this.evaluators.push(evaluator);
  }

  async evaluate(request) {
    const builtIn = evaluatePolicy(request, this.policy);
    const extras = [];
    for (const evaluator of this.evaluators) {
      const verdict = await evaluator.evaluate(request);
      if (verdict) extras.push(verdict);
    }
    return aggregateEffects([builtIn, ...extras]);
  }
}
