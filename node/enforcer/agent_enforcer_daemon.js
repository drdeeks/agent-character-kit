#!/usr/bin/env node
/**
 * Agent Character Kit Enforcer Daemon
 *
 * Root-owned, system-level enforcement service for ACK.
 * Runs as daemon under systemd with automatic restart (RestartSec=3, self-respawning).
 * Socket-based communication with agent client.
 *
 * SECURITY MODEL (FOREVER-SYSTEM.md §2/§5):
 *  - This process is meant to run as root, owned by the SYSTEM, not the agent user.
 *  - The agent user cannot kill/modify it without privilege escalation.
 *  - The socket lives in a root-owned dir; only root + the enforced client may connect.
 */

// install.js's launchDaemon() pipes stdout/stderr into the short-lived
// installer process so it can detect the "listening on" startup line, then
// unrefs its end once seen -- but that only stops the pipe from keeping the
// INSTALLER alive; it does not detach the DAEMON's end. Once the installer
// process exits, this daemon's next console.log/error write hits a closed
// pipe and throws EPIPE, which is an unhandled 'error' event by default and
// crashes the whole daemon -- exactly the kind of self-healing failure this
// process exists to prevent. Swallow it; logging is not essential to
// enforcement, staying alive is.
process.stdout.on("error", (err) => { if (err.code !== "EPIPE") throw err; });
process.stderr.on("error", (err) => { if (err.code !== "EPIPE") throw err; });

// Minimal .env autoload (no external dep). Package root = ../../ from node/enforcer/.
// install.js writes one .env here; every component reads it. Env vars win over .env.
// SECURITY: do NOT inject ACK_AUTH_TOKEN into the daemon's own process.env.
// The token is a shared secret between daemon + client; the client reads it
// from .env itself, and the supervisor/systemd passes it to the daemon's
// LAUNCH env. Auto-loading it here would make the daemon self-gate
// against any client that doesn't also inherit this repo's .env (e.g. the
// test harness, or a companion launched without it) — breaking legit calls.
import { fileURLToPath } from "url";
const __daemonDir = path.dirname(fileURLToPath(import.meta.url));
const __pkgRoot = path.resolve(__daemonDir, "..", "..");

// .env resolution: workspace-specific > CWD > repo root (existing fallback).
// Only loads vars NOT already in process.env (env vars always win).
function _loadEnvFile(envPath) {
  try {
    if (!fs.existsSync(envPath)) return;
    for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && m[1] !== "ACK_AUTH_TOKEN" && !(m[1] in process.env)) process.env[m[1]] = m[2];
    }
  } catch { /* best-effort */ }
}

// 1. Check workspace-specific .env (set by install.js per-workspace)
const __wsEnv = process.env.AGENT_WORKSPACE && path.join(process.env.AGENT_WORKSPACE, ".agent", ".env");
if (__wsEnv) _loadEnvFile(__wsEnv);
// 2. Check CWD .env (for manual daemon launches from a project)
_loadEnvFile(path.join(process.cwd(), ".env"));
// 3. Check repo root .env (existing fallback for dev/test)
_loadEnvFile(path.join(__pkgRoot, ".env"));

import net from "net";
import fs from "fs";
import fssync from "fs";
import path from "path";
import { execSync } from "child_process";
import yaml from "js-yaml";
import { VERSION } from "../src/version.js";

// Version — single source of truth is node/src/version.js (kept in sync
// with /VERSION at repo root). Re-exported under this name for the RPC
// wire format / existing call sites in this file.
export const ACK_VERSION = VERSION;

// ─── Self-resolving paths (root-owned defaults) ──────────────────────────────────
function resolveConfig() {
  const HOME = process.env.HOME || "/root";
  const WORKSPACE = process.env.AGENT_WORKSPACE || path.join(HOME, ".agent-character-kit", "workspace");
  const SOCKET = process.env.ENFORCER_SOCKET
    || (WORKSPACE && path.join(WORKSPACE, ".agent", "enforcer.sock"))
    || "/run/agent-enforcer/main.sock";
  const AGENT_DIR = path.join(WORKSPACE, ".agent");
  const CONSTITUTION = path.join(AGENT_DIR, "constitution.yaml");
  // Habits dir: ACK_HABITS_DIR overrides (so the plugin + daemon agree on the
  // exact same dir regardless of where the repo lives); else WORKSPACE/.agent/habits.
  const HABITS_DIR = process.env.ACK_HABITS_DIR || path.join(AGENT_DIR, "habits");
  const POLICY_FILE = process.env.ENFORCER_POLICY || path.join(AGENT_DIR, "enforcer.yaml");

  // Ensure directories exist (root-owned). The socket dir is derived from the
  // resolved SOCKET path itself — never from HOME — so a POSIX /run path stays
  // a /run path and a user %t path stays a user path (self-resolving, portable).
  const ensure = (p) => { try { fssync.mkdirSync(p, { recursive: true }); } catch {} };
  if (!SOCKET.startsWith("tcp://")) {
    const sockDir = path.dirname(SOCKET);
    if (sockDir) ensure(sockDir);
  }
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
  agent: { id: "ack-enforcer", name: "Agent Character Kit Enforcer" },
  core_values: [
    "Character is exercised on every action, not checked once.",
    "Fail closed — when unsure, deny.",
    "Do not bypass, patch, or disable the enforcer.",
  ],
  operational_standards: [
    "Every tool call passes through the gatekeeper FIRST.",
  ],
  // Minimal safety floor ONLY. Opinionated rules (sudo, git push --force,
  // chmod 777, chown -R, su) are NOT baked in here — they live as HABIT prompts
  // so they guide rather than hard-block, and stay editable without touching
  // the daemon. rm -rf / is the one non-negotiable floor: a catastrophic delete
  // must never rely on a reminder. The constructive alternative (mv to .trash/)
  // is carried by the safe_deletion_via_trash habit.
  hard_constraints: [
    "rm -rf /",
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
    this.characterHash = this._hash(JSON.stringify({
      c: this.constitution,
      h: this.habits,
      p: this.policy,
    }));
    this.startedAt = Date.now();
    this.lastHeartbeat = Date.now();
    // ─── Configurable values (env var > enforcer.yaml > embedded default) ───
    const _num = (envKey, policyKey, def) => parseInt(
      process.env[envKey] ||
      (typeof this.policy[policyKey] === "number" ? this.policy[policyKey] : ""),
      10
    ) || def;

    // Commit discipline: min chars for git commit messages during hold cycles.
    this.commitMinChars = _num("ACK_COMMIT_MIN_CHARS", "commit_min_chars", 150);
    // How many non-search tool calls between holds (default: every 5th).
    this.holdEveryNCalls = _num("ACK_HOLD_EVERY_N_CALLS", "hold_every_n_calls", 5);
    // How many habit acknowledgments required to release a hold.
    this.requiredAcks = _num("ACK_REQUIRED_ACKS", "required_acks", 2);
    // Minimum character length for ack reasons (prevents filler).
    this.minAckReasonChars = _num("ACK_MIN_ACK_REASON_CHARS", "min_ack_reason_chars", 12);
    // Max remembered ack reasons for reuse guard (rolling window).
    this.maxAckReasonHistory = _num("ACK_MAX_ACK_REASON_HISTORY", "max_ack_reason_history", 8);
    // Heartbeat staleness threshold in seconds (watchdog).
    this.heartbeatStaleSeconds = _num("ACK_HEARTBEAT_STALE_SECONDS", "heartbeat_stale_seconds", 600);
    // Watchdog validation interval in milliseconds.
    this.validationIntervalMs = _num("ACK_VALIDATION_INTERVAL_MS", "validation_interval_ms", 30000);
    // Audit log command truncation length.
    this.auditMaxCommandChars = _num("ACK_AUDIT_MAX_COMMAND_CHARS", "audit_max_command_chars", 500);
    // Commit becomes mandatory once EITHER threshold is crossed, whichever
    // first: this many DISTINCT files touched (not edit count — 27 edits to
    // one file is one file)...
    this.fileChangeThreshold = _num("ACK_FILE_CHANGE_THRESHOLD", "file_change_threshold", 5);
    // ...or this many hold-cycles have passed since the last satisfied
    // commit (default 4 cycles * hold_every_n_calls=5 = ~20 tool calls).
    this.commitEveryNCycles = _num("ACK_COMMIT_EVERY_N_CYCLES", "commit_every_n_cycles", 4);
    // Tools exempt from hold counting (agent can always search/read during hold).
    const defaultSearchTools = "search_files,read_file,web_search,web_extract,glob,grep,read";
    const rawSearchTools = process.env.ACK_SEARCH_TOOLS || (typeof this.policy.search_tools === "string" ? this.policy.search_tools : "");
    this.searchTools = new Set(
      (rawSearchTools || defaultSearchTools).split(",").map((s) => s.trim()).filter(Boolean)
    );

    // Daemon-owned hold ledger (per session). The agent cannot reset or
    // bypass this — it lives in the root-owned daemon, not the plugin.
    this.HOLD_STATE = new Map();

    // Daemon-owned habit-prompt rotation state (per session). Companions
    // invoked as a fresh CLI process per call (Claude/Cursor/Gemini via
    // `ack hook`) have no process memory of their own between calls — the
    // rotation MUST live here, not in the companion, or "rotating" habits
    // would just replay the same first pick every single turn. Long-lived
    // in-process companions (Hermes/OpenCode) could track this locally too,
    // but routing everyone through the daemon keeps one source of truth.
    this.PROMPT_CYCLE = new Map();
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
    this.characterHash = this._hash(JSON.stringify({
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

    // 1b. `git commit` is the sanctioned discipline — never blocked by
    // the allow-list or habit gates. Hard-constraints (secret-leak etc.)
    // above still apply, so a commit that leaks a secret is still denied.
    const isCommit = /\bgit\s+.*\bcommit\b/.test(command) && !/\b(--no-commit|rebase|cherry-pick)\b/.test(command);
    if (isCommit) {
      this._audit(tool, command, { denied: false, commit_intent: true });
      return { denied: false };
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

    // 4. Allowed — but still recorded, so every action carries the character trail
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
        character_hash: this.characterHash,
        tool,
        command: (command || "").slice(0, this.auditMaxCommandChars),
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
      version: ACK_VERSION,
      character_hash: this.characterHash,
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

  // ─── Daemon-owned habit-prompt rotation (pre-LLM injection) ────────────────
  // Deterministic PRNG seeded from a string — no external dep, good enough
  // for rotation (not security-sensitive).
  _seededRandom(seed) {
    let h = 0;
    for (let i = 0; i < seed.length; i++) h = (Math.imul(31, h) + seed.charCodeAt(i)) | 0;
    return function () {
      h |= 0; h = (h + 0x6D2B79F5) | 0;
      let t = Math.imul(h ^ (h >>> 15), 1 | h);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // Picks a rotating 2-3 habit subset for this session's next turn. Returns
  // {prompt, reasons} — prompt text only, NEVER the habit name (mirrors
  // python/hermes_plugin's _on_pre_llm_call: the agent must search/read the
  // habit files to discover which habit a prompt belongs to).
  pickPrompt(session) {
    if (!this.habits.length) return { prompts: [] };
    let state = this.PROMPT_CYCLE.get(session);
    if (!state || state.order.length !== this.habits.length) {
      const order = this.habits.map((_, i) => i);
      const shuffleRand = this._seededRandom(session + String(this.habits.length));
      for (let i = order.length - 1; i > 0; i--) {
        const j = Math.floor(shuffleRand() * (i + 1));
        [order[i], order[j]] = [order[j], order[i]];
      }
      state = { order, pos: 0 };
    }
    const countRand = this._seededRandom(session + String(state.pos));
    const count = 2 + Math.floor(countRand() * 2); // 2 or 3
    const picked = [];
    for (let i = 0; i < count; i++) {
      picked.push(this.habits[state.order[state.pos % this.habits.length]]);
      state.pos = (state.pos + 1) % this.habits.length;
    }
    this.PROMPT_CYCLE.set(session, state);

    return {
      prompts: picked.map((h) => {
        const b = h.behavior || {};
        return { prompt: h.prompt || b.prompt, logic: b.logic || "", evidence: b.evidence || "" };
      }),
    };
  }

  // ─── Daemon-owned acknowledgment HOLD ──────────────────────────────────────
  // The agent cannot bypass: state lives here (root-owned), not in the plugin.
  _holdState(session) {
    if (!this.HOLD_STATE.has(session)) {
      this.HOLD_STATE.set(session, {
        count: 0, acked: 0, lastTwo: [], reasons: [],
        // Distinct files touched since the last satisfied commit gate (a
        // Set, not a counter — 27 edits to one file is one file).
        filesTouched: new Set(),
        // Hold-cycles passed since the last satisfied commit gate.
        cyclesSinceCommit: 0,
      });
    }
    return this.HOLD_STATE.get(session);
  }

  _habitNames() {
    return this.habits.map((h) => h.name).filter(Boolean);
  }

  // Verifies a real `git commit` happened in the workspace since `sinceMs`
  // (the previous hold release), with a message >= commitMinChars chars.
  // Returns { ok, reason } — ok:true means the discipline is satisfied.
  _verifyCommitSince(sinceMs) {
    const ws = this.cfg.WORKSPACE;
    if (!ws) return { ok: false, reason: "no workspace configured" };
    let out;
    try {
      // %ct = committer epoch (secs); separator is a NUL byte (safe: git
      // subjects/bodies don't contain it). Split on "\0".
      out = execSync(
        "git -C " + JSON.stringify(ws) + " log -1 --format=%ct%n%B",
        { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }
      ).trim();
    } catch {
      return { ok: false, reason: "no git commit found in workspace" };
    }
    if (!out) return { ok: false, reason: "no git commit found in workspace" };
    const nl = out.indexOf("\n");
    const tsStr = (nl === -1 ? out : out.slice(0, nl)).trim();
    const msg = (nl === -1 ? "" : out.slice(nl + 1)).trim();
    const ts = parseInt(tsStr, 10) * 1000;
    if (!Number.isFinite(ts)) return { ok: false, reason: "unreadable commit" };
    if (sinceMs && ts < sinceMs) {
      return { ok: false, reason: "commit is older than the last hold (need a fresh commit)" };
    }
    if (msg.length < this.commitMinChars) {
      return {
        ok: false,
        reason: `commit message is ${msg.length} chars; need >= ${this.commitMinChars}`,
      };
    }
    return { ok: true, chars: msg.length };
  }

  // Canonicalize a habit identifier so filename style (hyphens) and YAML name YAML name
  // style (underscores) match: lowercase, non-alphanumerics collapsed to "-".
  _normName(n) {
    return String(n || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  }

  _habitNamesNorm() {
    return new Set(this._habitNames().map((n) => this._normName(n)));
  }

  // Called by the plugin on every (non-search) tool call. Returns hold decision.
  // filePath (optional): best-effort file path from the tool's params, used
  // ONLY for the distinct-file-count commit trigger below — never required.
  toolTick(session, tool, filePath) {
    if (this.searchTools.has(tool)) {
      return { hold: false }; // search/read always allowed during a hold
    }
    const st = this._holdState(session);
    st.count += 1;
    if (filePath) st.filesTouched.add(filePath);
    // NOTE: no permanent "already satisfied this session" bypass here —
    // submitAck() resets st.acked to 0 as soon as a cycle completes, so the
    // hold repeats at every future hold_every_n_calls boundary instead of
    // firing once per session.
    if (st.count % this.holdEveryNCalls === 0) {
      // Commit discipline is NOT required on every hold-cycle — only once
      // EITHER threshold is crossed: enough distinct files touched, or
      // enough cycles have passed since the last satisfied commit. Whichever
      // comes first. Both configurable (ACK_FILE_CHANGE_THRESHOLD /
      // ACK_COMMIT_EVERY_N_CYCLES), same env-var-first pattern as everything
      // else here.
      st.cyclesSinceCommit += 1;
      const filesTouchedCount = st.filesTouched.size;
      const commitDue = filesTouchedCount >= this.fileChangeThreshold
        || st.cyclesSinceCommit >= this.commitEveryNCycles;

      if (commitDue) {
        const since = st.lastCommitCheckMs || 0;
        const commit = this._verifyCommitSince(since);
        if (!commit.ok) {
          return {
            hold: true,
            reason: "TOOL ACCESS HELD — commit discipline not satisfied: " + commit.reason
              + ` (${filesTouchedCount}/${this.fileChangeThreshold} files touched, `
              + `${st.cyclesSinceCommit}/${this.commitEveryNCycles} cycles since last commit)`,
            commit_required: true,
            commit_min_chars: this.commitMinChars,
          };
        }
        // Commit discipline satisfied — reset both trackers for the next window.
        st.filesTouched = new Set();
        st.cyclesSinceCommit = 0;
        st.lastCommitCheckMs = Date.now();
      }
      return {
        hold: true,
        reason: "state two habit names, and how they apply to the work you've been doing.",
      };
    }
    return { hold: false };
  }

  // Called by the monitor (root-owned) after it validates an acknowledgment
  // statement the agent made. Credits the ledger (max 2 per hold cycle).
  //
  // Reuse guard: the two MOST RECENT acknowledged habit names are remembered
  // (rolling window). The next acknowledgment that names either of them is
  // rejected — so the agent cannot satisfy the hold by repeating the same two
  // habits it just used. It must pick from the rest of the set.
  submitAck(session, statement) {
    if (!statement || typeof statement !== "string") {
      return { ok: false, error: "no statement" };
    }
    // Variable closer — NOT hardwired to "resonates true". Accepted closers:
    //   resonates true | why: | because | matters because | applies because
    // (case-insensitive; tolerant of em-dash/hyphen around the closer).
    const m = statement.match(
      /^habit:\s*(\S+)\s*(?:resonates\s+true|why:|because|matters\s+because|applies\s+because)\s*[-–:]?\s*(.+)$/i
    );
    if (!m) return { ok: false, error: "bad format — use: Habit: <name> <closer: resonates true | why: | because | …> <engaged reason>" };
    const name = m[1];
    const reason = m[2].trim();
    const norm = this._normName(name);
    if (!this._habitNamesNorm().has(norm)) {
      return { ok: false, error: `unknown habit: ${name}` };
    }
    // Require a substantive, engaged reason — not filler.
    if (reason.length < this.minAckReasonChars) return { ok: false, error: "reason too short — state WHY this habit governs this action (specific, situation-tied)" };
    const st = this._holdState(session);
    // No reuse of either of the two most-recent habits (rolling window).
    if (st.lastTwo.includes(norm)) {
      return { ok: false, error: "already acknowledged recently — state a DIFFERENT habit (not one of the previous two)" };
    }
    // No reuse of a prior ack's exact reason for this session (forces real engagement).
    if (st.reasons.includes(reason.toLowerCase())) {
      return { ok: false, error: "reason reused — state a genuinely different reason, not one you already gave" };
    }
    // Every accepted acknowledgment shifts the rolling window — including ones
    // that arrive after the hold is already satisfied — so the agent can never
    // freeze the "previous two" and keep reusing everything else.
    st.lastTwo = [...st.lastTwo, norm].slice(-2);
    st.reasons.push(reason.toLowerCase());
    if (st.reasons.length > this.maxAckReasonHistory) st.reasons.shift();
    st.acked += 1;
    // Once this cycle's required acks are in, reset the counter immediately
    // rather than permanently disabling future holds for the session. Habits
    // are "the default lens... over time" (HABIT_POLICY.md §1), not a
    // one-time ritual — the daemon should hold again at the next
    // hold_every_n_calls boundary and require 2 fresh acknowledgments, same
    // as the first cycle.
    if (st.acked >= this.requiredAcks) {
      st.acked = 0;
      return { ok: true, cycle_complete: true };
    }
    return { ok: true, acked: st.acked };
  }
}

// ─── Socket Server ─────────────────────────────────────────────────────────────
function startSocketServer(enforcer) {
  const server = net.createServer((socket) => {
    socket.setEncoding("utf8");
    let buf = "";
    socket.on("data", (data) => {
      buf += data;
      let idx;
      // Process complete newline-delimited requests; buffer partial ones.
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        try {
          const request = JSON.parse(line);
          console.error("[daemon] parsed:", JSON.stringify(request));

          // Auth gate: if ACK_AUTH_TOKEN is set in the daemon's env, every
          // request MUST carry a matching `token`. A local process that can't
          // read the daemon's env (i.e. any other uid) is rejected with 403.
          const expected = process.env.ACK_AUTH_TOKEN;
          if (expected && request.token !== expected) {
            socket.write(JSON.stringify({ error: "unauthorized" }) + "\n");
            continue;
          }

          let response;
          switch (request.method) {
          case "status":
            response = { ok: true, pid: process.pid, version: ACK_VERSION, workspace: enforcer.cfg.WORKSPACE, socket: enforcer.cfg.SOCKET, habits: enforcer.habits.length, sessions: enforcer.HOLD_STATE.size };
            break;
          case "execute_tool":
            response = enforcer.executeTool(request.params.tool, request.params);
            break;
          case "heartbeat":
            response = enforcer.heartbeat();
            break;
          case "validate_workspace":
            response = enforcer.validate_workspace();
            break;
          case "reload":
            enforcer.reload();
            response = { ok: true, character_hash: enforcer.characterHash };
            break;
          case "get_habit":
            response = enforcer.getHabit(request.params?.name);
            break;
          case "pick_prompt":
            response = enforcer.pickPrompt(request.params?.session_id || "default");
            break;
          case "tool_tick":
            response = enforcer.toolTick(
              request.params?.session_id || "default",
              request.params?.tool || "",
              request.params?.file_path
            );
            break;
          case "submit_ack":
            response = enforcer.submitAck(
              request.params?.session_id || "default",
              request.params?.statement || ""
            );
            break;
          default:
            response = { error: "unknown method" };
        }

        socket.write(JSON.stringify(response) + "\n");
      } catch (err) {
        socket.write(JSON.stringify({ error: "invalid request" }) + "\n");
      }
    }
  });

    socket.on("error", (err) => {
      console.error("Socket error:", err);
    });
  });

  // Cross-platform transport:
  //   - ENFORCER_SOCKET="tcp://127.0.0.1:8753"  -> TCP (Windows, or any host)
  //   - ENFORCER_SOCKET unset -> Unix socket under AGENT_WORKSPACE/.agent/
  //     (portable: works on Linux, macOS, Windows-Subsystem, no /run needed)
  // Same enforcement core, same wire protocol, on every OS.
  // NOTE: Node's net.Server.listen() takes a string as a UNIX path; it does
  // NOT parse "tcp://". So we split TCP into {host, port} explicitly.
  const raw = process.env.ENFORCER_SOCKET
    || (enforcer.cfg.WORKSPACE && path.join(enforcer.cfg.WORKSPACE, ".agent", "enforcer.sock"))
    || "/run/agent-enforcer/main.sock";
  const isTcp = typeof raw === "string" && raw.startsWith("tcp://");
  let tcpHost = "127.0.0.1", tcpPort = 8753;

  if (isTcp) {
    const u = new URL(raw);
    tcpHost = u.hostname || "127.0.0.1";
    tcpPort = parseInt(u.port, 10) || 8753;
  }

  const onListening = () => {
    console.log(`ACK Enforcer daemon v${ACK_VERSION} listening on ${raw}`);
    console.log("System-owned enforcement service started successfully.");
  };

  if (isTcp) {
    server.listen(tcpPort, tcpHost, onListening);
  } else {
    // Secure the socket: group-restricted, not owner-only and not world.
    // 0600/0700 (owner-only) was the prior hardening, but it silently broke
    // root-mode and any future service-user mode: the daemon (root, or a
    // dedicated service user) and the AGENT client are different uids by
    // design in those modes, so an owner-only socket makes it physically
    // impossible for the agent to ever connect at all -- found live,
    // 2026-08-07, tracing why root-mode's stated "agent can use it but not
    // tamper with it" design couldn't actually work as coded.
    // 0660 + 0750 (setgid dir, set by the deploy script/installer so files
    // created here inherit the group) lets members of the shared client
    // group (root-mode/service-user-mode: daemon user + agent user; plain
    // user-mode: same uid either way, this is a no-op) open a connection --
    // but a raw connection alone does nothing. ACK_AUTH_TOKEN (MOD-006) is
    // the actual authorization boundary for every RPC method; group access
    // to the socket is deliberately weaker than that on purpose (defense in
    // depth, not the primary gate). World-666 (rejected before, still
    // rejected) let ANY process on the host both connect AND -- without a
    // token check -- would have been a real hole; group-scoped connect +
    // mandatory token auth is not the same risk.
    const sockDir = path.dirname(raw);
    try { fssync.mkdirSync(sockDir, { recursive: true, mode: 0o750 }); } catch {}
    try { fssync.chmodSync(sockDir, 0o750); } catch {}
    server.listen(raw, () => {
      try { fssync.chmodSync(raw, 0o660); } catch {}
      onListening();
    });
  }

  // If a stale socket file exists (e.g. previous instance killed with -9),
  // remove it so listen() succeeds on respawn. Without this, RestartSec
  // cycles spin on a locked socket and recovery blows past the 3-5s target.
  // (TCP has no stale file; EADDRINUSE there means the port is taken —
  // fail and let the supervisor handle it.)
  server.on("error", (err) => {
    if (err.code === "EADDRINUSE" && !isTcp) {
      try {
        fssync.unlinkSync(raw);
        server.listen(raw, () => { try { fssync.chmodSync(raw, 0o660); } catch {} onListening(); });
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
  setInterval(() => {
    const violations = enforcer.validate_workspace();
    if (violations.length) {
      enforcer._audit("watchdog", "validate_workspace", { denied: true, reason: violations.join("; ") });
      console.error(`[watchdog] WORKSPACE_VIOLATION: ${violations.join("; ")}`);
    }
    if (enforcer.lastHeartbeat && Date.now() - enforcer.lastHeartbeat > enforcer.heartbeatStaleSeconds * 1000) {
      enforcer._audit("watchdog", "heartbeat", { denied: true, reason: "STALE_HEARTBEAT" });
      console.error("[watchdog] STALE_HEARTBEAT: agent has not checked in");
    }
  }, enforcer.validationIntervalMs);

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

// ─── Multi-workspace support ───────────────────────────────────────────────────
// One daemon process can serve multiple workspaces simultaneously. Each workspace
// gets its own Enforcer instance, socket, and hold state. The workspace list is
// read from AGENT_WORKSPACES (comma-separated paths) or a registry file.
//
// The primary workspace (AGENT_WORKSPACE) is always included. Additional
// workspaces are spawned as separate socket servers on the same process.

function resolveWorkspaces() {
  const primary = process.env.AGENT_WORKSPACE
    || path.join(process.env.HOME || "/root", ".agent-character-kit", "workspace");
  const workspaces = new Set([primary]);

  // AGENT_WORKSPACES = comma-separated additional workspace paths
  const extra = process.env.AGENT_WORKSPACES;
  if (extra) {
    for (const ws of extra.split(",").map((s) => s.trim()).filter(Boolean)) {
      workspaces.add(path.resolve(ws));
    }
  }

  // Registry file: ~/.agent-character-kit/workspaces.json (JSON array of paths)
  const registryPath = path.join(process.env.HOME || "/root", ".agent-character-kit", "workspaces.json");
  try {
    if (fs.existsSync(registryPath)) {
      const list = JSON.parse(fs.readFileSync(registryPath, "utf8"));
      if (Array.isArray(list)) {
        for (const ws of list) {
          if (typeof ws === "string" && ws.trim()) workspaces.add(path.resolve(ws.trim()));
        }
      }
    }
  } catch { /* best-effort */ }

  return [...workspaces];
}

function startMultiWorkspaceDaemon(workspaces) {
  const servers = [];
  const enforcers = new Map(); // workspace path -> Enforcer instance

  for (const ws of workspaces) {
    const envOverrides = { ...process.env, AGENT_WORKSPACE: ws };
    // Each workspace gets its own socket under its .agent/ dir
    const sock = process.env.ENFORCER_SOCKET && workspaces.length === 1
      ? process.env.ENFORCER_SOCKET
      : path.join(ws, ".agent", "enforcer.sock");

    // Create a temporary Enforcer to read its config values
    const tmpEnforcer = new Enforcer();
    const enforcerCfg = tmpEnforcer.cfg;
    // Override workspace-specific values
    enforcerCfg.WORKSPACE = ws;
    enforcerCfg.SOCKET = sock;
    enforcerCfg.AGENT_DIR = path.join(ws, ".agent");
    enforcerCfg.CONSTITUTION = path.join(enforcerCfg.AGENT_DIR, "constitution.yaml");
    enforcerCfg.HABITS_DIR = process.env.ACK_HABITS_DIR || path.join(enforcerCfg.AGENT_DIR, "habits");
    enforcerCfg.POLICY_FILE = process.env.ENFORCER_POLICY || path.join(enforcerCfg.AGENT_DIR, "enforcer.yaml");

    // Re-create the Enforcer with the correct workspace config
    const enforcer = new EnforcerWithConfig(enforcerCfg);
    enforcers.set(ws, enforcer);

    // Create a socket server for this workspace
    const server = net.createServer((socket) => {
      socket.setEncoding("utf8");
      let buf = "";
      socket.on("data", (data) => {
        buf += data;
        let idx;
        while ((idx = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, idx).trim();
          buf = buf.slice(idx + 1);
          if (!line) continue;
          try {
            const request = JSON.parse(line);

            // Auth gate
            const expected = process.env.ACK_AUTH_TOKEN;
            if (expected && request.token !== expected) {
              socket.write(JSON.stringify({ error: "unauthorized" }) + "\n");
              continue;
            }

            let response;
            switch (request.method) {
            case "status":
              response = { ok: true, version: ACK_VERSION, workspace: ws, socket: sock, habits: enforcer.habits.length, sessions: enforcer.HOLD_STATE.size };
              break;
            case "execute_tool":
              response = enforcer.executeTool(request.params.tool, request.params);
              break;
            case "heartbeat":
              response = enforcer.heartbeat();
              break;
            case "validate_workspace":
              response = enforcer.validate_workspace();
              break;
            case "reload":
              enforcer.reload();
              response = { ok: true, character_hash: enforcer.characterHash };
              break;
            case "get_habit":
              response = enforcer.getHabit(request.params?.name);
              break;
            case "pick_prompt":
              response = enforcer.pickPrompt(request.params?.session_id || "default");
              break;
            case "tool_tick":
              response = enforcer.toolTick(
                request.params?.session_id || "default",
                request.params?.tool || "",
                request.params?.file_path
              );
              break;
            case "submit_ack":
              response = enforcer.submitAck(
                request.params?.session_id || "default",
                request.params?.statement || ""
              );
              break;
            case "register_workspace":
              // Register a new workspace at runtime
              response = _registerWorkspace(request.params?.workspace);
              break;
            default:
              response = { error: "unknown method" };
            }

            socket.write(JSON.stringify(response) + "\n");
          } catch (err) {
            socket.write(JSON.stringify({ error: "invalid request" }) + "\n");
          }
        }
      });
      socket.on("error", (err) => {
        console.error("Socket error:", err);
      });
    });

    // Listen on the socket
    const isTcp = typeof sock === "string" && sock.startsWith("tcp://");
    if (isTcp) {
      const u = new URL(sock);
      server.listen(parseInt(u.port, 10) || 8753, u.hostname || "127.0.0.1", () => {
        console.log(`ACK Enforcer daemon v${ACK_VERSION} listening on ${sock} [workspace: ${ws}]`);
      });
    } else {
      // Same fix as startSocketServer() above: group-restricted (0660/0750),
      // not owner-only (0600/0700) -- these two functions independently
      // implement the same socket-security logic and had drifted apart in
      // permission-hardening history exactly as duplicated code predicts
      // (KD-16, blueprint.md). Not collapsed into one shared helper tonight
      // -- too invasive a refactor to risk this late in the session -- but
      // both copies must carry the same real fix.
      const sockDir = path.dirname(sock);
      try { fssync.mkdirSync(sockDir, { recursive: true, mode: 0o750 }); } catch {}
      try { fssync.chmodSync(sockDir, 0o750); } catch {}
      server.listen(sock, () => {
        try { fssync.chmodSync(sock, 0o660); } catch {}
        console.log(`ACK Enforcer daemon v${ACK_VERSION} listening on ${sock} [workspace: ${ws}]`);
      });
    }

    server.on("error", (err) => {
      if (err.code === "EADDRINUSE" && !isTcp) {
        try {
          fssync.unlinkSync(sock);
          server.listen(sock, () => {
            try { fssync.chmodSync(sock, 0o660); } catch {}
            console.log(`ACK Enforcer daemon v${ACK_VERSION} listening on ${sock} [workspace: ${ws}]`);
          });
          return;
        } catch {}
      }
      console.error(`Failed to start enforcer socket for workspace ${ws}:`, err);
    });

    servers.push(server);
  }

  // Watchdog for all workspaces
  setInterval(() => {
    for (const [ws, enforcer] of enforcers) {
      const violations = enforcer.validate_workspace();
      if (violations.length) {
        enforcer._audit("watchdog", "validate_workspace", { denied: true, reason: violations.join("; ") });
        console.error(`[watchdog] WORKSPACE_VIOLATION (${ws}): ${violations.join("; ")}`);
      }
      if (enforcer.lastHeartbeat && Date.now() - enforcer.lastHeartbeat > enforcer.heartbeatStaleSeconds * 1000) {
        enforcer._audit("watchdog", "heartbeat", { denied: true, reason: "STALE_HEARTBEAT" });
        console.error(`[watchdog] STALE_HEARTBEAT (${ws}): agent has not checked in`);
      }
    }
  }, 30000);

  // Graceful shutdown
  const shutdown = () => {
    console.log("Shutting down enforcer daemon...");
    for (const server of servers) {
      server.close();
    }
    console.log("Enforcer daemon stopped.");
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  return { servers, enforcers };
}

// Register a new workspace at runtime (called via register_workspace RPC)
function _registerWorkspace(wsPath) {
  if (!wsPath || typeof wsPath !== "string") return { ok: false, error: "workspace path required" };
  const absWs = path.resolve(wsPath);
  const agentDir = path.join(absWs, ".agent");
  try { fssync.mkdirSync(path.join(agentDir, "habits"), { recursive: true }); } catch {}

  // Add to registry file
  const registryPath = path.join(process.env.HOME || "/root", ".agent-character-kit", "workspaces.json");
  try {
    let list = [];
    if (fs.existsSync(registryPath)) {
      list = JSON.parse(fs.readFileSync(registryPath, "utf8"));
      if (!Array.isArray(list)) list = [];
    }
    if (!list.includes(absWs)) {
      list.push(absWs);
      fssync.mkdirSync(path.dirname(registryPath), { recursive: true });
      fs.writeFileSync(registryPath, JSON.stringify(list, null, 2) + "\n");
    }
  } catch { /* best-effort */ }

  return { ok: true, workspace: absWs, message: "workspace registered — restart daemon to serve it" };
}

// Enforcer variant that accepts an explicit config (for multi-workspace mode)
class EnforcerWithConfig extends Enforcer {
  constructor(cfg) {
    // Skip the parent constructor's resolveConfig() by setting this.cfg first
    super();
    // Override with the provided config
    this.cfg = cfg;
    const fileConstitution = loadYaml(cfg.CONSTITUTION);
    this.constitution = Object.assign({}, DEFAULT_CONSTITUTION, fileConstitution);
    const fileHabits = this._loadHabits();
    const byName = new Map();
    for (const h of [...DEFAULT_HABITS, ...fileHabits]) byName.set(h.name, h);
    this.habits = [...byName.values()];
    const filePolicy = loadYaml(cfg.POLICY_FILE);
    this.policy = Object.assign({}, filePolicy);
    this.characterHash = this._hash(JSON.stringify({
      c: this.constitution,
      h: this.habits,
      p: this.policy,
    }));
  }
}

// ─── Bootstrap ──────────────────────────────────────────────────────────────────
const workspaces = resolveWorkspaces();
if (workspaces.length > 1 || process.env.AGENT_WORKSPACES) {
  // Multi-workspace mode
  startMultiWorkspaceDaemon(workspaces);
  console.log(`ACK Enforcer daemon v${ACK_VERSION} started in multi-workspace mode.`);
  console.log(`Serving ${workspaces.length} workspaces: ${workspaces.join(", ")}`);
} else {
  // Single workspace mode (backward compatible)
  const enforcer = new Enforcer();
  startSocketServer(enforcer);
  console.log(`ACK Enforcer daemon v${ACK_VERSION} started successfully.`);
  console.log("Root-owned system daemon with automatic restart support.");
  console.log(`Workspace: ${enforcer.cfg.WORKSPACE}`);
  console.log(`Config: ${enforcer.cfg.CONSTITUTION}`);
  console.log(`Habits directory: ${enforcer.cfg.HABITS_DIR}`);
}
