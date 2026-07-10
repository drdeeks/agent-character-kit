import { EnforcerClient } from "../enforcer/client.js";
import fs from "fs";
import path from "path";

const AUDIT_DIR = path.join(
  process.env.HOME || "/root",
  "var", "log", "agent-enforcer"
);
const AUDIT_LOG = path.join(AUDIT_DIR, "tool-audit.jsonl");

/**
 * Character Hook — Core enforcement for all tool calls.
 *
 * This is the gatekeeper. Every tool call from any framework
 * goes through here before execution.
 *
 * Flow:
 *   1. Receive tool call (framework-specific format)
 *   2. Normalize to unified format
 *   3. Validate through enforcer daemon
 *   4. Return allow/deny in framework-native format
 *   5. Log to audit trail
 */

// ─── Framework Detection ────────────────────────────────────────────────────

function detectFramework(payload) {
  if (payload.hook_event_name) {
    const evt = payload.hook_event_name;
    if (["PreToolUse", "PostToolUse", "SessionStart", "Stop"].includes(evt)) return "claude";
    if (["BeforeTool", "AfterTool", "BeforeToolSelection"].includes(evt)) return "gemini";
    if (["preToolUse", "postToolUse", "beforeShellExecution"].includes(evt)) return "cursor";
  }
  if (payload.tool_name && payload.args) return "hermes";
  if (payload.tool && payload.args) return "opencode";
  return "generic";
}

// ─── Normalization ──────────────────────────────────────────────────────────

function normalizeInput(payload, framework) {
  switch (framework) {
    case "claude":
      return {
        tool: payload.tool_name || "unknown",
        params: payload.tool_input || {},
        event: (payload.hook_event_name || "PreToolUse").toLowerCase(),
        sessionId: payload.session_id,
        cwd: payload.cwd,
      };
    case "cursor":
      return {
        tool: payload.tool_name || payload.tool || "unknown",
        params: payload.tool_input || payload.args || {},
        event: (payload.hook_event_name || "preToolUse").toLowerCase(),
        sessionId: payload.session_id,
        cwd: payload.cwd,
      };
    case "gemini":
      return {
        tool: payload.tool_name || "unknown",
        params: payload.tool_input || {},
        event: (payload.hook_event_name || "BeforeTool").toLowerCase(),
        sessionId: payload.session_id,
        cwd: payload.cwd,
      };
    case "hermes":
      return {
        tool: payload.tool_name || "unknown",
        params: payload.args || {},
        event: "pre_tool_call",
        sessionId: payload.task_id,
      };
    case "opencode":
      return {
        tool: payload.tool || payload.tool_name || "unknown",
        params: payload.args || payload.tool_input || {},
        event: payload.event || "tool.execute.before",
        sessionId: payload.session_id,
      };
    default:
      return {
        tool: payload.tool || payload.tool_name || "unknown",
        params: payload.params || payload.args || payload.tool_input || {},
        event: payload.event || "pre_tool_use",
        sessionId: payload.session_id,
      };
  }
}

// ─── Output Formatting ──────────────────────────────────────────────────────

function formatOutput(result, framework, original) {
  const { allowed, reason } = result;

  switch (framework) {
    case "claude":
      return {
        hookSpecificOutput: {
          hookEventName: original.hook_event_name || "PreToolUse",
          permissionDecision: allowed ? "allow" : "deny",
          ...(allowed ? {} : { permissionDecisionReason: reason }),
        },
      };

    case "cursor":
      return {
        permission: allowed ? "allow" : "deny",
        ...(allowed ? {} : { reason }),
      };

    case "gemini":
      return {
        decision: allowed ? "allow" : "deny",
        ...(allowed ? {} : { reason }),
      };

    case "hermes":
      if (allowed) return {};
      return { action: "block", message: reason };

    case "opencode":
      return {
        block: !allowed,
        ...(allowed ? {} : { reason }),
      };

    default:
      return {
        allow: allowed,
        ...(allowed ? {} : { reason, reflection: result.reflection }),
      };
  }
}

// ─── Audit Trail ────────────────────────────────────────────────────────────

function auditLog(event, tool, params, result) {
  try {
    if (!fs.existsSync(AUDIT_DIR)) {
      fs.mkdirSync(AUDIT_DIR, { recursive: true });
    }
    const entry = {
      ts: new Date().toISOString(),
      event,
      tool,
      params,
      result,
    };
    fs.appendFileSync(AUDIT_LOG, JSON.stringify(entry) + "\n");
  } catch {
    // Silent fail — audit logging should never block enforcement
  }
}

// ─── Main Hook ──────────────────────────────────────────────────────────────

const ENFORCER = new EnforcerClient();

/**
 * Process a tool call through the character hook.
 *
 * @param {object} payload - Raw tool call from framework
 * @param {object} options - { framework: "auto"|"claude"|..., enforcer: EnforcerClient }
 * @returns {Promise<{output: object, exitCode: number}>}
 */
export async function processToolCall(payload, options = {}) {
  const framework = options.framework === "auto"
    ? detectFramework(payload)
    : (options.framework || "generic");

  const enforcer = options.enforcer || ENFORCER;
  const normalized = normalizeInput(payload, framework);

  // Skip enforcer internal calls
  if (["validate_workspace", "heartbeat", "execute_tool"].includes(normalized.tool)) {
    return { output: formatOutput({ allowed: true }, framework, payload), exitCode: 0 };
  }

  // Fail-closed by default: if the enforcer can't be reached, block.
  // Opt out only in development with ACK_FAIL_OPEN=1 (never in production).
  const failClosed = !process.env.ACK_FAIL_OPEN;

  const isPre = [
    "pre_tool_use", "pretooluse", "beforetool",
    "pre_tool_call", "tool.execute.before"
  ].includes(normalized.event);

  let result;
  if (isPre) {
    result = await enforcer.validateTool(
      normalized.tool,
      normalized.params,
      normalized.sessionId || "unknown"
    );

    // Enforcer unreachable → enforce the closed posture.
    if (result.error && !failClosed) {
      result = { allowed: true };
    }

    auditLog("pre_tool_use", normalized.tool, normalized.params, result);
  } else {
    auditLog("post_tool_use", normalized.tool, normalized.params, payload.result);
    result = { allowed: true };
  }

  const output = formatOutput(result, framework, payload);
  const exitCode = !result.allowed && ["claude", "cursor", "gemini"].includes(framework) ? 2 : 0;

  return { output, exitCode };
}

/**
 * Generate framework-specific hook configuration.
 */
export function generateConfig(framework, hookCommand) {
  const cmd = hookCommand || "npx aik hook";

  switch (framework) {
    case "claude":
      return {
        hooks: {
          PreToolUse: [{
            matcher: "*",
            hooks: [{ type: "command", command: `${cmd} --framework claude` }],
          }],
        },
      };

    case "cursor":
      return {
        version: 1,
        hooks: {
          preToolUse: [{ command: `${cmd} --framework cursor`, matcher: "*" }],
        },
      };

    case "gemini":
      return {
        hooks: {
          BeforeTool: [{
            matcher: ".*",
            hooks: [{
              name: "character-enforcer",
              type: "command",
              command: `${cmd} --framework gemini`,
            }],
          }],
        },
      };

    case "hermes":
      return `# Add to your Hermes plugin:
const { processToolCall } = require("agent-character-kit");

ctx.register_hook("pre_tool_call", async (toolName, args, taskId) => {
  const result = await processToolCall(
    { tool_name: toolName, args, task_id: taskId },
    { framework: "hermes" }
  );
  return result.output;
});
`;

    case "opencode":
      return `// Add to your OpenCode plugin:
import { processToolCall } from "agent-character-kit";

export default async ({ tool, args }) => {
  const result = await processToolCall(
    { tool, args },
    { framework: "opencode" }
  );
  return result.output;
};
`;

    default:
      return {
        hooks: {
          pre_tool_use: [{ command: `${cmd} --framework generic` }],
        },
      };
  }
}
