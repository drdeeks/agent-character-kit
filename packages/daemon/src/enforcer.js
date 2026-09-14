/**
 * Enforcer core: config, embedded defaults, policy gate.
 */

import fs from "fs";
import fssync from "fs";
import path from "path";
import { execSync } from "child_process";
import yaml from "js-yaml";
import { evaluatePolicy, matchConstraint } from "../../core/src/policy/engine.js";
import { EventEmitter, EVENT_TYPE, createEventSink, resolveEventSinkMode } from "../../events/src/index.js";
import { VERSION as ACK_VERSION } from "../../../node/src/version.js";

export function resolveConfig() {
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
export function loadYaml(file) {
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
// Structural half of the "<habit> <connector> <real work attribution>"
// acknowledgment grammar (see submitAck below): the reason must point at
// something concrete -- a file/code reference, a past-tense action actually
// taken, or a stated future effect -- not a generic truth-claim about why
// the habit matters in the abstract.
const WORK_ATTRIBUTION_RE =
  /\.[a-zA-Z0-9]{1,10}\b|\/[\w.\-]+\/[\w.\-]+|`[^`]+`|\b(wrote|fixed|changed|edited|added|removed|renamed|moved|committed|refactored|deleted|created|updated|broke|caught|found|touched|reverted)\b|\bwill\s+(affect|prevent|break|help|catch|stop|avoid)\b|\bnext\s+(time|turn|session)\b|\bthis\s+(commit|change|session|turn|edit|file|function|test)\b/i;

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
const PEM_PRIVATE_HEADER = "-----BEGIN " + "PRIVATE KEY-----";
const SECRET_PREFIX_MARKERS = [
  "sk-", "sk_", "AIza", "xoxb-", "xoxp-", "AKIA",
  "ghp_", "gho_", "glpat-", PEM_PRIVATE_HEADER,
];
const SECRET_ASSIGN_MARKERS = [
  "api_key" + "=",
  "apikey" + "=",
  "password" + "=",
  "secret" + "=",
  "token" + "=",
  "client_secret" + "=",
];

const DEFAULT_HABITS = [{
  name: "no_credential_leak",
  prompt: "Did I expose any credential in this call?",
  enforcement: { level: "hard" },
  behavior: {
    kind: "guard",
    correct_action: "BLOCK the tool call; return a deny naming the matched pattern.",
    evidence: [
      "Command/params contain a known secret prefix (sk-, AIza, xoxb-, AKIA, ghp_, glpat-, PEM private-key header).",
      "An assignment of a secret-shaped value to a public surface (key/password/token assignment with non-empty RHS).",
    ],
    logic: "A leaked credential is irreversible. Fail-closed: if unsure, block. Blocking a false positive costs one retry; leaking costs a rotation + breach.",
    steps: [{
      check: "block_secret_leak",
      patterns: [...SECRET_PREFIX_MARKERS, ...SECRET_ASSIGN_MARKERS],
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
    // Max remembered ack reasons for reuse guard (rolling window). Kept
    // equal to maxHabitNameHistory below on purpose -- these two dedup
    // windows used to disagree (8 vs a hardcoded 2), which is exactly the
    // kind of drift a single agreed-upon number prevents.
    this.maxAckReasonHistory = _num("ACK_MAX_ACK_REASON_HISTORY", "max_ack_reason_history", 10);
    // How many distinct habit NAMES must be cited before any one can repeat
    // (rolling window, not just "not the immediately previous one"). Was
    // hardcoded to 2 (st.lastTwo, .slice(-2)) -- found live, 2026-08-07:
    // a window of 2 means alternating between exactly two habits never
    // trips the guard, which is exactly what happened across this session.
    this.maxHabitNameHistory = _num("ACK_MAX_HABIT_NAME_HISTORY", "max_habit_name_history", 10);
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

    // 1. Deny: constitution hard_constraints + policy.deny via packages/core.
    const denyVerdict = evaluatePolicy(
      { tool, command, params },
      {
        hardConstraints: this.constitution.hard_constraints || [],
        denyList: this.policy.deny || [],
      }
    );
    if (denyVerdict.effect === "deny") {
      const p = denyVerdict.matched_by || "deny";
      const result = {
        denied: true,
        reason: `Violates hard constraint: ${p}`,
        reflection: "This isn't a rule to work around — it's who we are. " +
          "A constraint exists because the cost of the failure is worse than the convenience.",
      };
      this._audit(tool, command, result);
      return result;
    }

    // 1b. `git commit` is the sanctioned discipline — never blocked by
    // the allow-list or habit gates. Hard-constraints (secret-leak etc.)
    // above still apply, so a commit that leaks a secret is still denied.
    const isCommit = /\bgit\s+.*\bcommit\b/.test(command) && !/\b(--no-commit|rebase|cherry-pick)\b/.test(command);
    if (isCommit) {
      this._audit(tool, command, { denied: false, commit_intent: true });
      return { denied: false };
    }

    // 2. Allow-list: same matcher, still after the commit bypass.
    if (Array.isArray(this.policy.allow) && this.policy.allow.length) {
      const allowVerdict = evaluatePolicy(
        { tool, command, params },
        { allowList: this.policy.allow }
      );
      if (allowVerdict.effect === "deny") {
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
      if (SECRET_PREFIX_MARKERS.includes(pat)) {
        return true;
      }
      // key= / key: forms — block if a value follows the assignment.
      if (SECRET_ASSIGN_MARKERS.includes(pat)) {
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
    return matchConstraint(pattern, tool, command, allowMode);
  }

  _hasBinary(name) {
    try {
      execSync(`which ${name}`, { stdio: "pipe" });
      return true;
    } catch {
      return false;
    }
  }

  _audit(tool, command, result, kind = "execute_tool", extra = {}) {
    try {
      const dir = path.join(this.cfg.AGENT_DIR, "logs");
      fssync.mkdirSync(dir, { recursive: true });
      const entry = {
        ts: new Date().toISOString(),
        character_hash: this.characterHash,
        kind,
        tool,
        command: (command || "").slice(0, this.auditMaxCommandChars),
        decision: result.denied ? "deny" : "allow",
        reason: result.reason || null,
        ...extra,
      };
      fssync.appendFileSync(path.join(dir, "enforcer-audit.jsonl"), JSON.stringify(entry) + "\n");
    } catch {
      /* audit must never break enforcement */
    }
    let eventType;
    if (kind === "execute_tool") {
      eventType = result.denied ? EVENT_TYPE.TOOL_DENIED : EVENT_TYPE.TOOL_ALLOWED;
    } else if (kind === "tool_tick" && result.denied) {
      eventType = EVENT_TYPE.TOOL_HELD;
    } else if (kind === "submit_ack") {
      eventType = result.denied ? EVENT_TYPE.ACK_REJECTED : EVENT_TYPE.ACK_ACCEPTED;
    }
    if (eventType) {
      this._emit(eventType, {
        sessionId: extra.session || "default",
        payload: {
          kind,
          tool,
          denied: !!result.denied,
          reason: result.reason || null,
        },
      });
    }
  }

  _emit(eventType, fields) {
    try {
      const dir = path.join(this.cfg.AGENT_DIR, "logs", "events");
      const env = process.env;
      const service = env.ACK_EVENT_SERVICE || "daemon";
      const mode = resolveEventSinkMode({ service, env });
      const remote = env.ACK_EVENT_URL || "";
      const key = `${dir}|${service}|${mode}|${remote}`;
      if (!this.events || this._eventsKey !== key) {
        this._eventsKey = key;
        this.events = new EventEmitter({
          sink: createEventSink({
            service,
            env,
            localDir: dir,
            remoteUrl: remote,
            headers: env.ACK_EVENT_AUTHORIZATION
              ? { authorization: env.ACK_EVENT_AUTHORIZATION }
              : undefined,
          }),
          source: "character-kit-daemon",
        });
      }
      const p = this.events.emit(eventType, fields);
      if (p && typeof p.catch === "function") p.catch(() => {});
    } catch {
      /* telemetry must never break enforcement */
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

  // Picks a rotating 2-3 habit subset for this session's next turn.
  // Prompt text only — never the habit name, never logic/evidence (those
  // stay in the YAML; injection must stay cheap).
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

    const prompts = picked.map((h) => {
      const b = h.behavior || {};
      return { prompt: h.prompt || b.prompt || "" };
    }).filter((p) => p.prompt);
    this._emit(EVENT_TYPE.HABIT_INJECTED, {
      sessionId: session || "default",
      payload: { count: prompts.length },
    });
    return { prompts };
  }

  // ─── Daemon-owned acknowledgment HOLD ──────────────────────────────────────
  // The agent cannot bypass: state lives here (root-owned), not in the plugin.
  _holdState(session) {
    if (!this.HOLD_STATE.has(session)) {
      this.HOLD_STATE.set(session, {
        count: 0, acked: 0, usedHabitNames: [], reasons: [],
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
          const result = {
            hold: true,
            reason: "TOOL ACCESS HELD — commit discipline not satisfied: " + commit.reason
              + ` (${filesTouchedCount}/${this.fileChangeThreshold} files touched, `
              + `${st.cyclesSinceCommit}/${this.commitEveryNCycles} cycles since last commit)`,
            commit_required: true,
            commit_min_chars: this.commitMinChars,
          };
          this._audit(tool, session, { denied: true, reason: result.reason }, "tool_tick",
            { session, tick_count: st.count });
          return result;
        }
        // Commit discipline satisfied — reset both trackers for the next window.
        st.filesTouched = new Set();
        st.cyclesSinceCommit = 0;
        st.lastCommitCheckMs = Date.now();
      }
      const result = {
        hold: true,
        reason: "state two habit names, and how they apply to the work you've been doing.",
      };
      this._audit(tool, session, { denied: true, reason: result.reason }, "tool_tick",
        { session, tick_count: st.count });
      return result;
    }
    this._audit(tool, session, { denied: false }, "tool_tick", { session, tick_count: st.count });
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
      this._audit("submit_ack", statement, { denied: true, reason: "no statement" }, "submit_ack", { session });
      return { ok: false, error: "no statement" };
    }
    // Grammar: <habit> <connector> <real work attribution>. Deliberately
    // dropped "resonates true" (2026-08-07) — that closer framed the
    // statement as an abstract truth-claim ("this is true because...")
    // when the point was never truth, it was attribution: tie the habit to
    // the actual work just done or its concrete future effect. The
    // remaining connectors just link name to reason; WORK_ATTRIBUTION_RE
    // below is what actually enforces the attribution requirement.
    const m = statement.match(
      /^habit:\s*(\S+)\s*(?:why:|because|matters\s+because|applies\s+because)\s*[-–:]?\s*(.+)$/i
    );
    if (!m) {
      this._audit("submit_ack", statement, { denied: true, reason: "bad format" }, "submit_ack", { session });
      return { ok: false, error: "bad format — use: Habit: <name> <connector: why: | because | matters because | applies because> <how it applies to work you did or will affect>" };
    }
    const name = m[1];
    const reason = m[2].trim();
    const norm = this._normName(name);
    if (!this._habitNamesNorm().has(norm)) {
      this._audit("submit_ack", statement, { denied: true, reason: `unknown habit: ${name}` }, "submit_ack", { session, habit: name });
      return { ok: false, error: `unknown habit: ${name}` };
    }
    // Require a substantive, engaged reason — not filler.
    if (reason.length < this.minAckReasonChars) {
      this._audit("submit_ack", statement, { denied: true, reason: "reason too short" }, "submit_ack", { session, habit: name });
      return { ok: false, error: "reason too short — state WHY this habit governs this action (specific, situation-tied)" };
    }
    // Require the reason to attribute to REAL work — a concrete file/code
    // reference, a past-tense action actually taken, or a stated future
    // effect — not a generic truth-claim about the habit ("it's important
    // because it prevents bugs" passes the length check but attributes to
    // nothing real). This is the structural half of "habit connector real
    // work attribution": regex can't verify the claim is true, but it can
    // reject reasons that don't even attempt to point at concrete work.
    if (!WORK_ATTRIBUTION_RE.test(reason)) {
      this._audit("submit_ack", statement, { denied: true, reason: "no real work attribution" }, "submit_ack", { session, habit: name });
      return {
        ok: false,
        error: "reason doesn't attribute to real work — reference the actual file/change/action from this session, or state how it will affect future work (not just why the habit is generically true)",
      };
    }
    const st = this._holdState(session);
    // No reuse of any of the last N distinct habits (rolling window, N =
    // maxHabitNameHistory, default 10, configurable via
    // ACK_MAX_HABIT_NAME_HISTORY / max_habit_name_history). Was a
    // hardcoded window of 2 -- found live, 2026-08-07: alternating between
    // exactly two habits never tripped a window that short. A real fix,
    // not a patch, means the window itself has to be wide enough that
    // genuinely cycling through the habit pool is the only way through,
    // not something two names can satisfy forever.
    if (st.usedHabitNames.includes(norm)) {
      this._audit("submit_ack", statement, { denied: true, reason: "habit reused within window" }, "submit_ack", { session, habit: name });
      return { ok: false, error: `already acknowledged recently — cite a habit not in your last ${this.maxHabitNameHistory} distinct acknowledgments` };
    }
    // No reuse of a prior ack's exact reason for this session (forces real engagement).
    if (st.reasons.includes(reason.toLowerCase())) {
      this._audit("submit_ack", statement, { denied: true, reason: "reason reused" }, "submit_ack", { session, habit: name });
      return { ok: false, error: "reason reused — state a genuinely different reason, not one you already gave" };
    }
    // Every accepted acknowledgment shifts the rolling window — including ones
    // that arrive after the hold is already satisfied — so the agent can never
    // freeze a short list and keep reusing everything else.
    st.usedHabitNames = [...st.usedHabitNames, norm].slice(-this.maxHabitNameHistory);
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
      this._audit("submit_ack", statement, { denied: false }, "submit_ack", { session, habit: name, cycle_complete: true });
      return { ok: true, cycle_complete: true };
    }
    this._audit("submit_ack", statement, { denied: false }, "submit_ack", { session, habit: name, cycle_complete: false });
    return { ok: true, acked: st.acked };
  }
}

export class EnforcerWithConfig extends Enforcer {
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
