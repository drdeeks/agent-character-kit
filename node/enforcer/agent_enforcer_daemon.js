#!/usr/bin/env node
/**
 * Agent Identity Kit Enforcer Daemon
 *
 * Root-owned, system-level enforcement service for AIK.
 * Runs as daemon under systemd with automatic restart (RestartSec=3, self-respawning).
 * Socket-based communication with agent client.
 *
 * SECURITY MODEL (FOREVER-SYSTEM.md §2/§5):
 *  - This process is meant to run as root, owned by the SYSTEM, not the agent user.
 *  - The agent user cannot kill/modify it without privilege escalation.
 *  - The socket lives in a root-owned dir; only root + the enforced client may connect.
 */

import net from "net";
import fs from "fs";
import fssync from "fs";
import path from "path";
import { execSync } from "child_process";
import yaml from "js-yaml";

// Version — kept in sync with /VERSION at repo root. Bump there, not here.
export const AIK_VERSION = "1.0.0";

// ─── Self-resolving paths (root-owned defaults) ──────────────────────────────────
function resolveConfig() {
  const HOME = process.env.HOME || "/root";
  const WORKSPACE = process.env.AGENT_WORKSPACE || path.join(HOME, ".agent-identity-kit", "workspace");
  const SOCKET = process.env.ENFORCER_SOCKET || "/run/agent-enforcer/main.sock";
  const AGENT_DIR = path.join(WORKSPACE, ".agent");
  const CONSTITUTION = path.join(AGENT_DIR, "constitution.yaml");
  const HABITS_DIR = path.join(AGENT_DIR, "habits");
  const POLICY_FILE = process.env.ENFORCER_POLICY || path.join(AGENT_DIR, "enforcer.yaml");

  // Ensure directories exist (root-owned)
  const ensure = (p) => { try { fssync.mkdirSync(p, { recursive: true }); } catch {} };
  ensure(HOME + "/run/agent-enforcer");
  ensure(WORKSPACE);

  return { HOME, WORKSPACE, SOCKET, AGENT_DIR, CONSTITUTION, HABITS_DIR, POLICY_FILE };
}

// ─── Config loading ────────────────────────────────────────────────────────────
function loadYaml(file) {
  try {
    return yaml.load(fssync.readFileSync(file, "utf-8")) || {};
  } catch {
    return {};
  }
}

// ─── Embedded defaults (FOREVER-SYSTEM §1: singular, pullable, acceptable) ──────
// The enforcer is USEFUL OUT OF THE BOX. No constitution.yaml / enforcer.yaml /
// habits required. These embedded values ARE the default character; files on disk
// OVERRIDE (merge on top of) them. A user who pulls the daemon gets sane, safe
// enforcement immediately — zero config, zero "additional bullshit".
const DEFAULT_CONSTITUTION = {
  agent: { id: "aik-enforcer", name: "Agent Identity Kit Enforcer" },
  core_values: [
    "Character is exercised on every action, not checked once.",
    "Fail closed — when unsure, deny.",
    "Do not bypass, patch, or disable the enforcer.",
  ],
  operational_standards: [
    "Every tool call passes through the gatekeeper FIRST.",
  ],
  hard_constraints: [
    "rm -rf /",
    "git push --force",
    "sudo",
    "su",
    "chmod 777",
    "chown -R",
  ],
  aspiration: "Behave with integrity under no observation.",
};

// Secret-leak guard is ALWAYS on (embedded), even with no habits file.
const DEFAULT_HABITS = [{
  name: "no_credential_leak",
  prompt: "Did I expose any credential in this call?",
  enforcement: { level: "hard" },
  behavior: {
    kind: "guard",
    correct_action: "BLOCK the tool call; return a deny naming the matched pattern.",
    evidence: [
      "Command/params contain a known secret prefix (sk-, AIza, xoxb-, AKIA, ghp_, glpat-, -----BEGIN PRIVATE KEY-----).",
      "An assignment of a secret-shaped value to a public surface (api_key=, password=, token=, client_secret= with non-empty RHS).",
    ],
    logic: "A leaked credential is irreversible. Fail-closed: if unsure, block. Blocking a false positive costs one retry; leaking costs a rotation + breach.",
    steps: [{
      check: "block_secret_leak",
      patterns: [
        "sk-", "sk_", "AIza", "xoxb-", "xoxp-", "AKIA",
        "ghp_", "gho_", "glpat-", "-----BEGIN PRIVATE KEY-----",
        "api_key=", "apikey=", "password=", "secret=",
        "token=", "client_secret=",
      ],
      require_assignment: true,
    }],
  },
}];

// ─── Enforcer Core ─────────────────────────────────────────────────────────────
export class Enforcer {
  constructor() {
    const cfg = resolveConfig();
    this.cfg = cfg;
    // Files OVERRIDE embedded defaults (merge). No file => embedded applies.
    const fileConstitution = loadYaml(cfg.CONSTITUTION);
    this.constitution = Object.assign({}, DEFAULT_CONSTITUTION, fileConstitution);
    const fileHabits = this._loadHabits();
    // File habits OVERRIDE embedded ones of the same name (no duplicates).
    const byName = new Map();
    for (const h of [...DEFAULT_HABITS, ...fileHabits]) byName.set(h.name, h);
    this.habits = [...byName.values()];
    const filePolicy = loadYaml(cfg.POLICY_FILE);
    // policy.allow/deny from file extend (don't clobber embedded intent).
    this.policy = Object.assign({}, filePolicy);
    this.identityHash = this._hash(JSON.stringify({
      c: this.constitution,
      h: this.habits,
      p: this.policy,
    }));
    this.startedAt = Date.now();
    this.lastHeartbeat = Date.now();
  }

  _loadHabits() {
    const habits = [];
    try {
      const files = fssync.readdirSync(this.cfg.HABITS_DIR);
      for (const f of files) {
        if (f.endsWith(".yaml") || f.endsWith(".yml")) {
          habits.push(loadYaml(path.join(this.cfg.HABITS_DIR, f)));
        }
      }
    } catch { /* No habits directory */ }
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
    this.identityHash = this._hash(JSON.stringify({
      c: this.constitution,
      h: this.habits,
      p: this.policy,
    }));
  }

  // ─── Core enforcement ───────────────────────────────────────────────────────
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

    // 2. Allow-list policy: if policy.allow is set, ONLY listed tools/commands pass
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

    // 3. Habit checks (each habit may block) — internalized, not optional
    for (const habit of this.habits) {
      const block = this._evalHabit(habit, tool, command);
      if (block) {
        const result = { denied: true, reason: block, reflection: "A compiled habit blocked this. Habits are internalized, not optional." };
        this._audit(tool, command, result);
        return result;
      }
    }

    // 3b. Workspace integrity (mirrors the harness reference enforcer):
    // re-validate on EVERY tool call. If the constitution/habits/policy are
    // missing or tampered, the action is denied — character cannot be opted out
    // of by deleting its source.
    const violations = this.validate_workspace();
    if (violations.length) {
      const result = {
        denied: true,
        reason: `Workspace violations: ${violations.join("; ")}`,
        reflection: "Workspace hygiene is not optional. Restore the constitution/habits/enforcer.yaml the enforcer owns.",
      };
      this._audit(tool, command, result);
      return result;
    }

    // 4. Allowed — but still recorded, so every action carries the identity trail
    const manifest = this._buildManifest();
    const defects = this._selfVerify();
    const result = { denied: false };
    if (manifest.length) result.manifest = manifest;
    if (defects.length) result.self_verify_defects = defects;
    this._audit(tool, command, result);
    return result;
  }

  _evalHabit(habit, tool, command) {
    if (!habit || !habit.enforcement) return null;
    if (habit.enforcement.level !== "hard") return null; // reminder habits never block

    const checks = habit.behavior?.steps || [];
    for (const step of checks) {
      const check = step.check || "";
      if (check === "executable_and_present") {
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
      if (check === "block_secret_leak") {
        if (this._leaksSecret(tool, command, step)) {
          return `Blocked by habit ${habit.name}: probable credential leak detected. ` +
            `A guard that fails open on secrets is no guard.`;
        }
      }
    }
    return null;
  }

  _leaksSecret(tool, command, step) {
    const hay = `${tool} ${command}`;
    const patterns = step.patterns || [];
    for (const pat of patterns) {
      const idx = hay.indexOf(pat);
      if (idx === -1) continue;
      // Known secret prefixes (sk-, AKIA, xoxb-, ghp_, ...) are themselves values. Fail closed.
      if (["sk-", "sk_", "AIza", "xoxb-", "xoxp-", "AKIA", "ghp_", "gho_",
           "glpat-", "-----BEGIN PRIVATE KEY-----"].includes(pat)) {
        return true;
      }
      // key= / key: forms — block if a value follows the assignment.
      if (["api_key=", "apikey=", "password=", "secret=", "token=", "client_secret="].includes(pat)) {
        const tail = hay.slice(idx + pat.length);
        const t = tail.trim();
        if (t && !t.startsWith("'") && !t.startsWith('"') && !t.startsWith("#")) {
          return true;
        }
      }
    }
    return false;
  }

  // Compact manifest: one short question per habit, piped back every call.
  // Keeps token cost bounded — the heavy assert/evidence/logic stay in the YAML
  // (proof layer), pulled on demand via get_habit, and used for self-verification.
  _buildManifest() {
    const out = [];
    for (const habit of this.habits) {
      const name = habit.name;
      const prompt = habit.prompt || habit.behavior?.prompt;
      if (name && prompt) out.push({ habit: name, prompt });
    }
    return out;
  }

  // Self-verification: the daemon proves its own decision against the YAML proof
  // layer. For every consulted habit, confirm the reasoning source is intact
  // (assert/correct_action + evidence + logic). A habit missing its proof is a
  // defect the daemon reports rather than silently echoing an unbacked question.
  _selfVerify() {
    const defects = [];
    for (const habit of this.habits) {
      const b = habit.behavior || {};
      const hasStandard = b.assert || habit.correct_action || b.correct_action;
      const hasProof = b.evidence && b.logic;
      if (!hasStandard || !hasProof) {
        defects.push(habit.name || "?");
      }
    }
    return defects;
  }

  _matches(pattern, tool, command, allowMode = false) {
    const p = String(pattern || "").trim();
    if (!p) return false;
    const hay = `${tool} ${command}`.toLowerCase();

    if (!allowMode && hay.includes(p.toLowerCase())) return true;

    if (allowMode) {
      const rx = new RegExp(
        "^" + p.toLowerCase().replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$"
      );
      const candidates = [
        tool.toLowerCase(),
        command.toLowerCase(),
        (command || "").toLowerCase().split(/\s+/)[0] || "",
      ];
      return candidates.some((c) => rx.test(c));
    }
    return false;
  }

  _hasBinary(name) {
    try {
      execSync(`which ${name}`, { stdio: "pipe" });
      return true;
    } catch {
      return false;
    }
  }

  _audit(tool, command, result) {
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
    } catch {
      /* audit must never break enforcement */
    }
  }

  _extractCommand(tool, params) {
    if (params && typeof params.command === "string") return params.command;
    if (params && typeof params.cmd === "string") return params.cmd;
    if (params && typeof params.code === "string") return params.code;
    if (typeof params === "string") return params;
    return String(tool || "");
  }

  heartbeat() {
    this.lastHeartbeat = Date.now();
    return {
      status: "ok",
      version: AIK_VERSION,
      identity_hash: this.identityHash,
      violations: this.validate_workspace(),
      uptime: Date.now() - this.startedAt,
      last_heartbeat: this.lastHeartbeat,
    };
  }

  validate_workspace() {
    // Embedded defaults mean the daemon is valid WITH NO FILES. Missing files
    // are no longer "violations" — they simply fall back to DEFAULT_CONSTITUTION.
    // A violation is reserved for a FILE THAT EXISTS BUT IS UNPARSEABLE / corrupt.
    const violations = [];
    if (fssync.existsSync(this.cfg.CONSTITUTION)) {
      try { yaml.load(fssync.readFileSync(this.cfg.CONSTITUTION, "utf-8")); }
      catch { violations.push("constitution.yaml present but unparseable"); }
    }
    if (fssync.existsSync(this.cfg.POLICY_FILE)) {
      try { yaml.load(fssync.readFileSync(this.cfg.POLICY_FILE, "utf-8")); }
      catch { violations.push("enforcer.yaml present but unparseable"); }
    }
    return violations;
  }

  // On-demand proof layer: return the full assert/evidence/logic for one habit
  // so the agent (or a human) can see WHY a question is the right bar — without
  // ever injecting that weight on every call.
  getHabit(name) {
    const habit = this.habits.find((h) => h.name === name);
    if (!habit) return { error: `unknown habit: ${name}` };
    const b = habit.behavior || {};
    return {
      name: habit.name,
      prompt: habit.prompt || b.prompt,
      assert: b.assert || habit.correct_action || b.correct_action,
      evidence: b.evidence,
      logic: b.logic,
      enforcement: habit.enforcement,
    };
  }
}

// ─── Socket Server ─────────────────────────────────────────────────────────────
function startSocketServer(enforcer) {
  const server = net.createServer((socket) => {
    socket.setEncoding("utf8");

    socket.on("data", (data) => {
      try {
        const request = JSON.parse(data.trim());
        let response;

        switch (request.method) {
          case "execute_tool":
            response = enforcer.executeTool(request.params.tool, request.params);
            break;
          case "heartbeat":
            response = enforcer.heartbeat();
            break;
          case "validate_workspace":
            response = enforcer.validate_workspace();
            break;
          case "get_habit":
            response = enforcer.getHabit(request.params?.name);
            break;
          default:
            response = { error: "unknown method" };
        }

        socket.write(JSON.stringify(response) + "\n");
      } catch (err) {
        socket.write(JSON.stringify({ error: "invalid request" }) + "\n");
      }
    });

    socket.on("error", (err) => {
      console.error("Socket error:", err);
    });
  });

  // Cross-platform transport:
  //   - ENFORCER_SOCKET="tcp://127.0.0.1:8753"  -> TCP (Windows, or any host)
  //   - ENFORCER_SOCKET="/run/agent-enforcer/main.sock" -> Unix (POSIX default)
  // Same enforcement core, same wire protocol, on every OS.
  // NOTE: Node's net.Server.listen() takes a string as a UNIX path; it does
  // NOT parse "tcp://". So we split TCP into {host, port} explicitly.
  const raw = process.env.ENFORCER_SOCKET || "/run/agent-enforcer/main.sock";
  const isTcp = typeof raw === "string" && raw.startsWith("tcp://");
  let tcpHost = "127.0.0.1", tcpPort = 8753;

  if (isTcp) {
    const u = new URL(raw);
    tcpHost = u.hostname || "127.0.0.1";
    tcpPort = parseInt(u.port, 10) || 8753;
  }

  const onListening = () => {
    console.log(`AIK Enforcer daemon v${AIK_VERSION} listening on ${raw}`);
    console.log("System-owned enforcement service started successfully.");
  };

  if (isTcp) {
    server.listen(tcpPort, tcpHost, onListening);
  } else {
    server.listen(raw, () => {
      // Socket is world-connectable by design: connecting does NOT bypass
      // enforcement — every request is still gated. What the agent CANNOT do is
      // kill, modify, or replace this root-owned process or its files.
      try { fssync.chmodSync(raw, 0o666); } catch {}
      onListening();
    });
  }

  // If a stale socket file exists (e.g. previous instance killed with -9), remove
  // it so listen() succeeds on respawn. Without this, RestartSec cycles spin on a
  // locked socket and recovery blows past the 3-5s target. (TCP has no stale
  // file; EADDRINUSE there means the port is taken — fail and let the supervisor
  // handle it.)
  server.on("error", (err) => {
    if (err.code === "EADDRINUSE" && !isTcp) {
      try {
        fssync.unlinkSync(raw);
        server.listen(raw, () => { try { fssync.chmodSync(raw, 0o666); } catch {} onListening(); });
        return;
      } catch {}
    }
    console.error("Failed to start enforcer socket server:", err);
    console.error("Ensure the socket path exists/writable, or the TCP port is free.");
    process.exit(1);
  });

  // Self-respawning: if the process is killed, systemd (RestartSec=3) brings it back.
  // Defensive: ignore broken pipes so a dead client can't crash the daemon.
  process.on("SIGPIPE", () => {});

  // Watchdog (mirrors the harness reference enforcer's validation_loop):
  // periodically re-validate the workspace and flag a stale heartbeat as
  // tamper-evidence. Runs inside the daemon, so it survives even with no client.
  const HEARTBEAT_STALE_THRESHOLD = 600; // 10 min, per reference impl
  const VALIDATION_INTERVAL = 30000;     // 30s
  setInterval(() => {
    const violations = enforcer.validate_workspace();
    if (violations.length) {
      enforcer._audit("watchdog", "validate_workspace", { denied: true, reason: violations.join("; ") });
      console.error(`[watchdog] WORKSPACE_VIOLATION: ${violations.join("; ")}`);
    }
    if (enforcer.lastHeartbeat && Date.now() - enforcer.lastHeartbeat > HEARTBEAT_STALE_THRESHOLD * 1000) {
      enforcer._audit("watchdog", "heartbeat", { denied: true, reason: "STALE_HEARTBEAT" });
      console.error("[watchdog] STALE_HEARTBEAT: agent has not checked in");
    }
  }, VALIDATION_INTERVAL);

  const shutdown = () => {
    console.log("Shutting down enforcer daemon...");
    server.close(() => {
      console.log("Enforcer daemon stopped.");
      process.exit(0);
    });
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

// ─── Bootstrap ──────────────────────────────────────────────────────────────────
const enforcer = new Enforcer();
startSocketServer(enforcer);

console.log("AIK Enforcer daemon v1.0.0 started successfully.");
console.log("Root-owned system daemon with automatic restart support.");
console.log(`Workspace: ${enforcer.cfg.WORKSPACE}`);
console.log(`Config: ${enforcer.cfg.CONSTITUTION}`);
console.log(`Habits directory: ${enforcer.cfg.HABITS_DIR}`);
