#!/usr/bin/env node
/**
 * Agent Identity Kit — Enforcer Daemon
 *
 * Runs as a SEPARATE process (its own service / user) that the agent cannot
 * modify, signal, or patch. Every agent tool call is validated here BEFORE it
 * executes. The agent talks to this daemon only over a Unix socket.
 *
 * Why separate: if the agent could kill or edit the enforcer, enforcement is
 * meaningless. The daemon loads the constitution + habits + command policy from
 * the workspace and judges every `execute_tool` call against them.
 *
 * Self-healing: run under `aik enforcer supervise` (cross-platform) or a systemd
 * unit with Restart=always — if killed, it comes back within 5-15 seconds.
 *
 * Paths are self-resolving:
 *   socket  = ENFORCER_SOCKET || $HOME/run/agent-enforcer/main.sock
 *   workspace = AGENT_WORKSPACE || $HOME/.openclaw/workspace
 *   config  = <workspace>/.agent/{constitution.yaml, habits/*.yaml, enforcer.yaml}
 */

import net from "net";
import fs from "fs";
import fssync from "fs";
import path from "path";
import os from "os";
import yaml from "js-yaml";

// ─── Self-resolving paths ────────────────────────────────────────────────────
//
// Resolved fresh on each call so env overrides (and tests) take effect, and so
// the daemon is platform/path-agnostic.

function resolveConfig() {
  const HOME = process.env.HOME || os.homedir();
  const WORKSPACE = process.env.AGENT_WORKSPACE || path.join(HOME, ".openclaw", "workspace");
  const SOCKET = process.env.ENFORCER_SOCKET
    || path.join(HOME, "run", "agent-enforcer", "main.sock");
  const AGENT_DIR = path.join(WORKSPACE, ".agent");
  const CONSTITUTION = path.join(AGENT_DIR, "constitution.yaml");
  const HABITS_DIR = path.join(AGENT_DIR, "habits");
  const POLICY_FILE = process.env.ENFORCER_POLICY || path.join(AGENT_DIR, "enforcer.yaml");
  return { HOME, WORKSPACE, SOCKET, AGENT_DIR, CONSTITUTION, HABITS_DIR, POLICY_FILE };
}

// ─── Config loading ──────────────────────────────────────────────────────────

function loadYaml(file) {
  try {
    return yaml.load(fssync.readFileSync(file, "utf-8")) || {};
  } catch {
    return {};
  }
}

export class Enforcer {
  constructor() {
    const cfg = resolveConfig();
    this.cfg = cfg;
    this.constitution = loadYaml(cfg.CONSTITUTION);
    this.habits = this._loadHabits();
    this.policy = loadYaml(cfg.POLICY_FILE);
    this.identityHash = this._hash(JSON.stringify({ c: this.constitution, h: this.habits, p: this.policy }));
    this.startedAt = Date.now();
    this.lastHeartbeat = Date.now();
  }

  _loadHabits() {
    const habits = [];
    try {
      for (const f of fssync.readdirSync(this.cfg.HABITS_DIR)) {
        if (f.endsWith(".yaml") || f.endsWith(".yml")) {
          habits.push(loadYaml(path.join(this.cfg.HABITS_DIR, f)));
        }
      }
    } catch { /* no habits dir */ }
    return habits;
  }

  _hash(s) {
    let h = 0;
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
    return h.toString(16);
  }

  reload() {
    this.constitution = loadYaml(this.cfg.CONSTITUTION);
    this.habits = this._loadHabits();
    this.policy = loadYaml(this.cfg.POLICY_FILE);
    this.identityHash = this._hash(JSON.stringify({ c: this.constitution, h: this.habits, p: this.policy }));
  }

  // ─── Core enforcement ──────────────────────────────────────────────────────

  /**
   * Judge a tool call. EVERY tool call — curl, tar, web, file writes, shells —
   * passes through here and is judged against identity, habits, and policy.
   * Returns { denied, reason, reflection }.
   */
  executeTool(tool, params = {}) {
    const command = this._extractCommand(tool, params);

    // 1. Explicit deny patterns (constitution hard_constraints + policy.deny)
    const denyPatterns = [
      ...(this.constitution.hard_constraints || []),
      ...(this.policy.deny || []),
    ];
    for (const p of denyPatterns) {
      if (this._matches(p, tool, command)) {
        const result = {
          denied: true,
          reason: `Violates hard constraint: ${p}`,
          reflection: "This isn't a rule to work around — it's who we are. " +
            "A constraint exists because the cost of the failure is worse than the convenience.",
        };
        this._audit(tool, command, result);
        return result;
      }
    }

    // 2. Allow-list policy: if policy.allow is set, ONLY listed tools/commands pass.
    //    This is the high bar — unlisted tools are denied by default, because
    //    reliability means we ship only what we've deliberately permitted.
    if (Array.isArray(this.policy.allow) && this.policy.allow.length) {
      const ok = this.policy.allow.some((p) => this._matches(p, tool, command, true));
      if (!ok) {
        const result = {
          denied: true,
          reason: `Tool not on allow-list: ${command || tool}`,
          reflection: "Unlisted tools are denied by default. Add it to enforcer.yaml allow-list " +
            "if it is genuinely needed — but raising the bar is the point.",
        };
        this._audit(tool, command, result);
        return result;
      }
    }

    // 3. Habit checks (each habit may block) — internalized, not optional.
    for (const habit of this.habits) {
      const block = this._evalHabit(habit, tool, command);
      if (block) {
        const result = { denied: true, reason: block, reflection: "A compiled habit blocked this. Habits are internalized, not optional." };
        this._audit(tool, command, result);
        return result;
      }
    }

    // 4. Allowed — but still recorded, so every action carries the identity trail.
    const result = { denied: false };
    this._audit(tool, command, result);
    return result;
  }

  _audit(tool, command, result) {
    // Immutable, append-only trail of every gated tool call. This is the
    // continuous reminder: the agent's identity is exercised on EVERY action.
    try {
      const dir = path.join(this.cfg.AGENT_DIR, "logs");
      fssync.mkdirSync(dir, { recursive: true });
      const entry = {
        ts: new Date().toISOString(),
        identity_hash: this.identityHash,
        tool,
        command: (command || "").slice(0, 500),
        decision: result.denied ? "deny" : "allow",
        reason: result.reason || null,
      };
      fssync.appendFileSync(path.join(dir, "enforcer-audit.jsonl"), JSON.stringify(entry) + "\n");
    } catch { /* audit must never break enforcement */ }
  }

  _extractCommand(tool, params) {
    if (params && typeof params.command === "string") return params.command;
    if (params && typeof params.cmd === "string") return params.cmd;
    if (params && typeof params.code === "string") return params.code;
    if (typeof params === "string") return params;
    return String(tool || "");
  }

  _matches(pattern, tool, command, allowMode = false) {
    const p = String(pattern || "").trim();
    if (!p) return false;
    const hay = `${tool} ${command}`.toLowerCase();

    // Literal substring (e.g. "rm -rf", "git push --force")
    if (!allowMode && hay.includes(p.toLowerCase())) return true;

    // Glob-ish for allow-list: "git *", "npm test", "ls"
    if (allowMode) {
      const rx = new RegExp(
        "^" + p.toLowerCase().replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$"
      );
      // match against the tool name, the command, or command prefix
      const candidates = [tool.toLowerCase(), command.toLowerCase(), (command || "").toLowerCase().split(/\s+/)[0] || ""];
      return candidates.some((c) => rx.test(c));
    }
    return false;
  }

  _evalHabit(habit, tool, command) {
    if (!habit || habit.enforcement?.level !== "hard") return null;
    const checks = habit.behavior?.steps || [];
    for (const step of checks) {
      const check = step.check || "";
      if (check === "executable_and_present") {
        // Example guard: refuse if a required tool binary is missing.
        const bin = step.binary || step.name?.replace("validate_", "");
        if (bin && !this._hasBinary(bin)) {
          return `Required tool missing: ${bin}`;
        }
      }
      if (check === "block_command_pattern" && step.pattern) {
        if (this._matches(step.pattern, tool, command)) {
          return `Blocked by habit ${habit.name}: ${step.pattern}`;
        }
      }
    }
    return null;
  }

  _hasBinary(name) {
    const dirs = (process.env.PATH || "").split(path.delimiter);
    return dirs.some((d) => {
      try { return fssync.existsSync(path.join(d, name)); } catch { return false; }
    });
  }

  validateWorkspace() {
    const violations = [];
    if (!fssync.existsSync(this.cfg.CONSTITUTION)) violations.push("constitution.yaml missing");
    if (!fssync.existsSync(this.cfg.POLICY_FILE)) violations.push("enforcer.yaml missing (using open policy)");
    return violations;
  }

  heartbeat() {
    this.lastHeartbeat = Date.now();
    return { status: "ok", identity_hash: this.identityHash, violations: this.validateWorkspace() };
  }
}

// ─── RPC server ──────────────────────────────────────────────────────────────

function startServer(enforcer) {
  const SOCKET = enforcer.cfg.SOCKET;
  const dir = path.dirname(SOCKET);
  fssync.mkdirSync(dir, { recursive: true });
  try { fssync.unlinkSync(SOCKET); } catch { /* not present */ }

  const server = net.createServer((socket) => {
    let buf = "";
    socket.on("data", (chunk) => {
      buf += chunk.toString();
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let req;
        try { req = JSON.parse(line); } catch { socket.write(JSON.stringify({ error: "bad request" }) + "\n"); continue; }

        const res = handle(enforcer, req);
        socket.write(JSON.stringify(res) + "\n");
      }
    });
    socket.on("error", () => {});
  });

  server.listen(SOCKET, () => {
    fssync.chmodSync(SOCKET, 0o600);
    console.error(`[enforcer] listening on ${SOCKET} (identity ${enforcer.identityHash})`);
  });
  return server;
}

function handle(enforcer, req) {
  const { method, params = {} } = req;
  switch (method) {
    case "execute_tool":
      return enforcer.executeTool(params.tool, params.params);
    case "validate_workspace":
      return { status: "ok", violations: enforcer.validateWorkspace() };
    case "heartbeat":
      return enforcer.heartbeat();
    case "reload":
      enforcer.reload();
      return { status: "reloaded", identity_hash: enforcer.identityHash };
    default:
      return { error: `unknown method: ${method}` };
  }
}

// ─── Entry: run the daemon ───────────────────────────────────────────────────

export function runDaemon() {
  const enforcer = new Enforcer();
  const server = startServer(enforcer);

  const shutdown = () => {
    try { fssync.unlinkSync(SOCKET); } catch {}
    server.close();
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
  return server;
}

// Allow running directly: node enforcer/enforcer_daemon.js
const invokedDirectly = import.meta.url === `file://${process.argv[1]}`;
if (invokedDirectly) {
  runDaemon();
}

export default runDaemon;
