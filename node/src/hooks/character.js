import { EnforcerClient } from "../enforcer/client.js";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

// Absolute path to the bundled ack.js bin, never "npx ack hook" as a
// fallback default. If the package isn't globally installed/linked yet,
// npx silently fetches an unrelated public npm package instead of running
// this CLI (verified live during testing).
const ACK_BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "bin", "ack.js");

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

    // Allowed by the constitution/policy check — now apply the daemon-owned
    // periodic HOLD (habit acknowledgment + commit discipline). This was
    // previously only wired for the Hermes/Python companion; every
    // framework routed through here (Claude/Cursor/Gemini/OpenCode/generic)
    // gets it too now — the hold is expressed as a denial with the hold's
    // reason, since most of these frameworks only have an allow/deny gate,
    // not a separate "block with message" concept.
    if (result.allowed) {
      const filePath = normalized.params && (normalized.params.file_path || normalized.params.path);
      const tick = await enforcer.toolTick(normalized.tool, normalized.sessionId || "unknown", filePath);
      if (tick.hold) {
        result = { allowed: false, reason: tick.reason || "acknowledge 2 habits." };
      }
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

// ─── Pre-LLM habit injection ────────────────────────────────────────────────
// Same behavior as python/hermes_plugin/__init__.py's _on_pre_llm_call:
// rotate 2-3 random habit prompts (+ logic/evidence reasoning) into context
// each turn, NEVER the habit name — the agent must search/read
// .agent/habits/*.yaml to find which habit a given prompt belongs to, then
// acknowledge it by the name it discovers there (see HABIT_POLICY.md §4,
// agent_enforcer_daemon.js toolTick). This is the "belts and suspenders"
// second channel described in docs/agent-character-injection-design.md —
// kept alongside the tool-call response channel, not a replacement for it.
//
// The rotation state lives in the DAEMON (pickPrompt RPC), not here. Unlike
// Hermes's Python companion — which stays loaded as one long-running process,
// so a module-level dict genuinely persists across calls — Claude/Cursor/
// Gemini invoke `ack hook` as a FRESH CLI process per hook call. Any
// in-process rotation state here would silently reset every single call and
// never actually rotate. The daemon is the only thing in this architecture
// that's actually long-lived, so it's the only place this state can live.

function _logInjection(prompts) {
  try {
    const logPath = process.env.ACK_INJECT_LOG || "/tmp/ack-inject-log.jsonl";
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.appendFileSync(logPath, JSON.stringify({
      ts: new Date().toISOString(), count: prompts.length, prompts,
    }) + "\n");
  } catch { /* logging must never break injection */ }
}

/**
 * Ask the daemon for this session's next rotating habit-prompt subset and
 * format it into the injectable context string. Returns null if there's
 * nothing to say (no habits, daemon unreachable, or ACK_DISABLE=1).
 */
export async function pickHabitPrompts(sessionId, enforcer) {
  if (process.env.ACK_DISABLE === "1") return null;
  const client = enforcer || ENFORCER;
  const { prompts } = await client.pickPrompt(sessionId);
  if (!prompts || !prompts.length) return null;

  const lines = [];
  for (const h of prompts) {
    const reason = h.logic || h.evidence;
    lines.push("- " + h.prompt);
    if (reason) lines.push("    why: " + reason);
  }
  _logInjection(prompts.map((h) => h.prompt));
  // MOD-002: a vague, non-specific locational nudge -- enough to shorten a
  // search, never enough to skip it. Deliberately does NOT name a habit,
  // a filename, or the exact `.agent/habits/` path (Guiding Principle 2,
  // blueprint.md Part I/1.4) -- an agent that wants to acknowledge one of
  // these by name still has to go look in its own workspace for it.
  const nudge = "\n\n(these live somewhere in your own workspace's hidden agent configuration -- go find the real file before you cite one)";
  return "AGENT CHARACTER HABITS (read before reasoning):\n" + lines.join("\n") + nudge;
}

// MOD-008: Claude transcript acknowledgment detector -- port of
// hermes_plugin's VERIFIED-working _detect_ack() pattern (__init__.py:210,
// called from _on_pre_llm_call every turn) to Claude Code's hook shape.
// Same 3-layer design: this function only APPENDS a detected statement to
// the external ACK_ACK_LOG; it never calls submit_ack itself. Only the
// root-owned monitor (deploy/ack_monitor.js, already reading this exact
// log format) may credit the daemon -- so a compromised or misbehaving
// agent process still cannot forge its own acknowledgment.
//
// Deliberately BROADER than Hermes's literal regex: Hermes's pattern
// (`resonates\s+true\s+because`) only matches one of the five closers the
// daemon's real submitAck() grammar accepts (agent_enforcer_daemon.js:707
// -- resonates true | why: | because | matters because | applies because).
// A straight port of Hermes's narrower regex would silently miss valid
// acknowledgments using any of the other four closers. This uses the
// daemon's own real acceptance grammar instead, so nothing that would
// actually be credited goes undetected.
const ACK_STATEMENT_RE =
  /habit:\s*\S+\s*(?:resonates\s+true|why:|because|matters\s+because|applies\s+because)\s*[-–:]?\s*.+/gi;

/**
 * Read the Claude Code transcript (JSONL, one line per event) at
 * transcriptPath, find the most recent assistant message, and detect any
 * real "Habit: <name> <closer> <reason>" statement in its text content.
 * Verified against a real transcript file's actual schema before writing
 * this (not assumed): { type: "assistant", message: { role, content: [
 * {type:"text", text}, {type:"thinking",...}, {type:"tool_use",...} ] } }.
 *
 * Never throws -- logging must never break the call, same posture as
 * Hermes's own `except Exception: pass` around _detect_ack's body.
 */
export function detectAckFromTranscript(transcriptPath, sessionId) {
  if (!transcriptPath) return;
  try {
    if (!fs.existsSync(transcriptPath)) return;
    const lines = fs.readFileSync(transcriptPath, "utf8").split("\n");
    // Scan from the end -- the acknowledgment, if present, is in the most
    // recent assistant turn, and transcripts can be large.
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (!line) continue;
      let entry;
      try { entry = JSON.parse(line); } catch { continue; }
      if (entry.type !== "assistant") continue;
      const content = entry.message && entry.message.content;
      if (!Array.isArray(content)) return; // found the last assistant turn, nothing to scan
      const text = content
        .filter((b) => b && b.type === "text" && typeof b.text === "string")
        .map((b) => b.text)
        .join("\n");
      const matches = text.match(ACK_STATEMENT_RE);
      if (matches && matches.length) {
        const ackLog = process.env.ACK_ACK_LOG || "/tmp/agent-character-kit-ack.jsonl";
        fs.mkdirSync(path.dirname(ackLog), { recursive: true });
        for (const statement of matches) {
          fs.appendFileSync(ackLog, JSON.stringify({
            session_id: sessionId || "default",
            statement: statement.trim(),
          }) + "\n");
        }
      }
      return; // only the most recent assistant turn is checked, matching
              // Hermes's per-turn (not whole-history) detection scope
    }
  } catch { /* logging must never break the call */ }
}

/**
 * Process a pre-LLM-turn hook, injecting rotating habit prompts into context.
 * Mirrors processToolCall's shape (framework detection, {output, exitCode})
 * but never blocks — this is a reminder channel, not a gate.
 */
export async function processPromptSubmit(payload, options = {}) {
  // MOD-008: detect an acknowledgment BEFORE injecting the next batch of
  // habit prompts, mirroring Hermes's _on_pre_llm_call ordering
  // (_detect_ack runs first, injection second, __init__.py:353-354).
  detectAckFromTranscript(payload.transcript_path, payload.session_id || payload.sessionId);

  const framework = options.framework === "auto"
    ? detectFramework(payload)
    : (options.framework || "generic");
  const enforcer = options.enforcer || ENFORCER;
  const sessionId = payload.session_id || payload.sessionId || payload.task_id || "default";
  const ctx = await pickHabitPrompts(sessionId, enforcer);

  if (!ctx) return { output: {}, exitCode: 0 };

  switch (framework) {
    case "claude":
      return {
        output: {
          hookSpecificOutput: {
            hookEventName: "UserPromptSubmit",
            additionalContext: ctx,
          },
        },
        exitCode: 0,
      };
    case "hermes":
      return { output: { context: ctx }, exitCode: 0 };
    case "opencode":
      return { output: { context: ctx }, exitCode: 0 };
    default:
      return { output: { context: ctx }, exitCode: 0 };
  }
}

/**
 * Generate framework-specific hook configuration.
 */
export function generateConfig(framework, hookCommand) {
  // ack.js's `hook` command takes framework as a POSITIONAL argument
  // (`ack hook claude`), not a --framework flag. Every command string built
  // here must match that shape or the harness's own hook invocation fails
  // with "unknown option" on every single tool call.
  const cmd = hookCommand || `node '${ACK_BIN}' hook`;

  switch (framework) {
    case "claude":
      return {
        hooks: {
          PreToolUse: [{
            matcher: "*",
            hooks: [{ type: "command", command: `${cmd} claude` }],
          }],
          // UserPromptSubmit: the pre-LLM injection channel (see
          // processPromptSubmit above) — same command, the daemon-side hook
          // action routes on hook_event_name to decide gate vs. inject.
          UserPromptSubmit: [{
            hooks: [{ type: "command", command: `${cmd} claude` }],
          }],
        },
      };

    case "cursor":
      return {
        version: 1,
        hooks: {
          preToolUse: [{ command: `${cmd} cursor`, matcher: "*" }],
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
              command: `${cmd} gemini`,
            }],
          }],
        },
      };

    case "hermes":
      // NOTE: the shipped Hermes companion is python/hermes_plugin, which
      // already registers pre_tool_call + pre_llm_call directly against the
      // daemon (no JS layer involved). This snippet is only for a
      // hypothetical JS-based Hermes-style companion.
      return `# Add to your Hermes plugin:
const { processToolCall, processPromptSubmit } = require("agent-character-kit");

ctx.register_hook("pre_tool_call", async (toolName, args, taskId) => {
  const result = await processToolCall(
    { tool_name: toolName, args, task_id: taskId },
    { framework: "hermes" }
  );
  return result.output;
});

ctx.register_hook("pre_llm_call", async (sessionId) => {
  const result = await processPromptSubmit(
    { session_id: sessionId },
    { framework: "hermes" }
  );
  return result.output; // { context: "..." } or {} if nothing to inject
});
`;

    case "opencode":
      return `// Add to your OpenCode plugin:
import { processToolCall, processPromptSubmit } from "agent-character-kit";

export default async ({ tool, args, session }) => {
  const result = await processToolCall(
    { tool, args },
    { framework: "opencode" }
  );
  return result.output;
};

// Call before forwarding the user's message to the model:
export async function onPromptSubmit({ session }) {
  const result = await processPromptSubmit(
    { session_id: session },
    { framework: "opencode" }
  );
  return result.output; // { context: "..." } or {} if nothing to inject
}
`;

    default:
      return {
        hooks: {
          pre_tool_use: [{ command: `${cmd} generic` }],
        },
      };
  }
}
