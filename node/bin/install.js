#!/usr/bin/env node
/**
 * @character-kit interactive installer.
 *
 * One command deploys the WHOLE kit and wires every component:
 *   - the enforcement daemon (CORE, out-of-process)
 *   - the harness companion (thin client: hook config for any framework)
 *   - the acknowledgment monitor (credits the daemon from the ack log)
 *   - the monitor watchdog (revives the monitor)
 *
 * Everything resolves via env (AGENT_WORKSPACE / ENFORCER_SOCKET / ACK_ACK_LOG)
 * written to a single .env. No hardcoded paths, no stalls, no force-closes:
 * prompts wait for a response, child processes are spawned detached+unref so
 * the installer always exits cleanly.
 *
 * Usage:
 *   node bin/install.js                 # interactive, asks about each component
 *   node bin/install.js --yes           # non-interactive, all components on
 *   node bin/install.js --all           # everything, root mode, generic harness
 *   node bin/install.js --workspace X --socket unix --harness claude --user --yes
 */

import fs from "fs";
import net from "net";
import os from "os";
import path from "path";
import readline from "readline";
import { spawn, spawnSync } from "child_process";
import { fileURLToPath, pathToFileURL } from "url";
import { normalizeHabitName, buildHabitYaml, VALID_LEVELS } from "../src/habits/build.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, "..", ".."); // package root
const DAEMON = path.join(REPO, "node", "enforcer", "agent_enforcer_daemon.js");
// Node-native monitor + watchdog -- the daemon/monitor/watchdog trio is
// Node-only by default. Python (deploy/ack_monitor.py, ack_watchdog.py)
// stays available only for a Python-based deployment; it is never required
// just to get the self-healing trio running, only for the Hermes companion.
const MONITOR = path.join(REPO, "deploy", "ack_monitor.js");
const WATCHDOG = path.join(REPO, "deploy", "ack_watchdog.js");
const ACK_BIN = path.join(REPO, "node", "bin", "ack.js");

// ─── arg parsing (non-interactive) ────────────────────────────────────────────
function parseArgs(argv) {
  const out = { workspace: null, socket: null, harness: null, root: null, yes: false, monitor: true, watchdog: true, companion: true, createHabit: false, habitName: null, habitPrompt: null, habitLogic: null, habitEvidence: null, habitLevel: null, all: false, hookCommand: null, python: null, start: true, writeClaudeConfig: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--workspace") out.workspace = argv[++i];
    else if (a === "--socket") out.socket = argv[++i];
    else if (a === "--harness") out.harness = argv[++i];
    else if (a === "--root") out.root = true;
    else if (a === "--user") out.root = false;
    else if (a === "--no-monitor") out.monitor = false;
    else if (a === "--no-watchdog") out.watchdog = false;
    else if (a === "--no-companion") out.companion = false;
    else if (a === "--create-habit") out.createHabit = true;
    else if (a === "--habit-name") out.habitName = argv[++i];
    else if (a === "--habit-prompt") out.habitPrompt = argv[++i];
    else if (a === "--habit-logic") out.habitLogic = argv[++i];
    else if (a === "--habit-evidence") out.habitEvidence = argv[++i];
    else if (a === "--habit-level") out.habitLevel = argv[++i];
    else if (a === "--yes" || a === "-y") out.yes = true;
    else if (a === "--all") out.all = true;
    else if (a === "--hook-command") out.hookCommand = argv[++i];
    else if (a === "--python") out.python = true;
    else if (a === "--no-python") out.python = false;
    else if (a === "--start") out.start = true;
    else if (a === "--no-start") out.start = false;
    else if (a === "--claude-config") out.writeClaudeConfig = true;
    else if (a === "--no-claude-config") out.writeClaudeConfig = false;
  }
  return out;
}

// ─── prompt helper (safe: always resolves; never hangs) ───────────────────────
function ask(rl, q, def) {
  const suffix = def !== undefined ? ` (default: ${def})` : "";
  return new Promise((resolve) => {
    rl.question(`${q}${suffix}\n> `, (ans) => {
      const v = (ans || "").trim();
      resolve(v === "" && def !== undefined ? def : v);
    });
  });
}
function yesNo(rl, q, def = true) {
  return ask(rl, `${q} [y/n]`, def ? "y" : "n").then((a) => /^(y|yes)$/i.test(a || (def ? "y" : "n")));
}

// ─── existing-workspace discovery (SOUL.md / .agent/constitution.yaml) ────────
// Bounded, explicit-root-only walk (never scans the whole filesystem, never
// runs without a root the user gave us) -- looks for the two markers that
// identify an established agent workspace anywhere in this ecosystem: a
// SOUL.md (crew-hierarchy style identity file) or .agent/constitution.yaml
// (ACK's own marker). Skips VCS/dependency/build dirs so a scan of a real
// projects/ tree finishes in well under a second, not minutes.
const SCAN_SKIP_DIRS = new Set([
  "node_modules", ".git", ".hg", ".svn", "__pycache__", ".venv", "venv",
  "dist", "build", ".next", ".cache", ".trash",
]);
const SCAN_MAX_DEPTH = 6;

function discoverAgentWorkspaces(rootDir, maxDepth = SCAN_MAX_DEPTH) {
  const found = [];
  const root = path.resolve(rootDir);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    return found;
  }
  const walk = (dir, depth) => {
    if (depth > maxDepth) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // permission denied etc. -- skip silently, this is a best-effort scan
    }
    const hasSoul = entries.some((e) => e.isFile() && e.name === "SOUL.md");
    const hasConstitution = entries.some((e) => e.isDirectory() && e.name === ".agent") &&
      fs.existsSync(path.join(dir, ".agent", "constitution.yaml"));
    if (hasSoul || hasConstitution) {
      found.push({
        dir,
        marker: hasSoul ? "SOUL.md" : ".agent/constitution.yaml",
      });
      return; // don't descend into an already-identified workspace
    }
    for (const e of entries) {
      if (!e.isDirectory() || SCAN_SKIP_DIRS.has(e.name) || e.name.startsWith(".")) continue;
      walk(path.join(dir, e.name), depth + 1);
    }
  };
  walk(root, 0);
  return found;
}

// ─── socket resolution (shared by daemon, companion, monitor, watchdog) ───────
function resolveSocket(mode, ws) {
  const s = String(mode || "unix").toLowerCase();
  if (s === "tcp" || s === "2") return "tcp://127.0.0.1:8753";
  if (s.startsWith("tcp://")) return s;            // literal tcp url
  if (s === "unix" || s === "1" || s === "") return path.join(ws, ".agent", "enforcer.sock");
  return s;                                          // literal unix path
}

// ─── component setup ───────────────────────────────────────────────────────────
function writeEnvFile(envPath, vars) {
  const lines = Object.entries(vars).map(([k, v]) => `${k}=${v}`);
  fs.writeFileSync(envPath, lines.join("\n") + "\n");
  // Contains ACK_AUTH_TOKEN -- the hook command below sources this file to
  // reach the daemon, so it must not be world/group readable.
  try { fs.chmodSync(envPath, 0o600); } catch { /* best-effort on non-POSIX fs */ }
}

function shellQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

// Claude Code spawns hook commands with whatever env IT was started with --
// not the env this installer resolved (workspace/socket/auth token). Without
// this, the hook silently runs against defaults or an unreachable socket and
// never touches this install. Wrapping the command in a shell that sources
// the workspace .env first makes the hook self-contained regardless of the
// parent shell's environment.
function buildSelfContainedHookCommand(rawCmd, envFilePath) {
  return `bash -lc 'set -a; source ${shellQuote(envFilePath)} 2>/dev/null; set +a; ${rawCmd}'`;
}

export function claudeSettingsPath() {
  return path.join(os.homedir(), ".claude", "settings.json");
}

// Single source of truth for harness auto-detection -- was duplicated
// between install.js's --yes path (which had none, silently defaulting to
// "generic") and postinstall.js's own copy (used only for the pointer
// message, never reaching install.js after MOD-005/CL-0007 removed
// postinstall's auto-configure branch). Exported so both call sites use
// exactly one implementation.
export function detectHarnesses() {
  const home = os.homedir();
  const candidates = [
    { harness: "claude", marker: path.join(home, ".claude", "settings.json") },
    { harness: "hermes", marker: path.join(home, ".hermes") },
    { harness: "opencode", marker: path.join(home, ".config", "opencode") },
  ];
  const found = candidates.filter((c) => fs.existsSync(c.marker)).map((c) => c.harness);
  return found.length ? found : ["generic"];
}

// Merge (not clobber) our PreToolUse + UserPromptSubmit entries into the
// user's real settings.json. Re-running install replaces our own prior
// entries (matched by the "bin/ack.js" marker) instead of appending
// duplicates every time. Exported for direct testing, same convention as
// resolveSocket/discoverAgentWorkspaces below.
export function writeClaudeHookConfig(cmdString) {
  // MOD-003: both PreToolUse (the gate) and UserPromptSubmit (the habit
  // injection channel) must be wired, or the injection half of the
  // enforcement loop never reaches a live session even though the daemon
  // and character.js's pickHabitPrompts()/generateConfig() logic for it
  // already exist and work (blueprint.md KD-07). Both hook types use the
  // exact same command string -- ack.js routes on hook_event_name at
  // runtime (ack.js:680) -- so this writes one string into two arrays.
  const p = claudeSettingsPath();
  let settings = {};
  if (fs.existsSync(p)) {
    try { settings = JSON.parse(fs.readFileSync(p, "utf8")); } catch { settings = {}; }
  }
  settings.hooks = settings.hooks || {};

  const stripAckEntries = (arr) => (arr || []).filter(
    (entry) => !(entry && Array.isArray(entry.hooks) &&
      entry.hooks.some((h) => h && typeof h.command === "string" && h.command.includes("bin/ack.js")))
  );

  settings.hooks.PreToolUse = stripAckEntries(settings.hooks.PreToolUse);
  settings.hooks.PreToolUse.push({
    matcher: "*",
    hooks: [{ type: "command", command: cmdString }],
  });

  settings.hooks.UserPromptSubmit = stripAckEntries(settings.hooks.UserPromptSubmit);
  settings.hooks.UserPromptSubmit.push({
    hooks: [{ type: "command", command: cmdString }],
  });

  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(settings, null, 2) + "\n");
  return p;
}

function seedHabits(ws) {
  const src = path.join(REPO, "python", "example_workspace", ".agent", "habits");
  const dst = path.join(ws, ".agent", "habits");
  fs.mkdirSync(dst, { recursive: true });
  if (fs.existsSync(src)) {
    for (const f of fs.readdirSync(src)) {
      if (f.endsWith(".yaml") && !fs.existsSync(path.join(dst, f))) {
        fs.copyFileSync(path.join(src, f), path.join(dst, f));
      }
    }
  }
}

function writeConstitution(ws) {
  const dst = path.join(ws, ".agent", "constitution.yaml");
  if (!fs.existsSync(dst)) {
    fs.writeFileSync(dst, [
      "# Agent Character Kit — constitution (hard constraints).",
      "# The daemon embeds safe defaults; this file OVERRIDES/extends them.",
      "hard_constraints:",
      "  - no_credential_leak: block any tool call that would expose a secret",
      "  - no_destructive_without_confirm: block rm -rf /, mkfs, dd on disks, etc. unless confirmed",
    ].join("\n") + "\n");
  }
}

// MOD-007: `spawn()` not throwing means the OS accepted the fork request,
// not that the process is still running or responding to RPC a moment
// later. A minimal, self-contained status ping -- deliberately not routed
// through EnforcerClient (client.js), since that reads its token from
// process.env.ACK_AUTH_TOKEN globally, and mutating the installer's own
// process-wide env for a single liveness check is worse than a small
// self-contained call, matching the same self-containment reasoning
// ack_monitor.js's own header comment gives for not importing the repo's
// shared client.
export function pingDaemonStatus(sock, token) {
  return new Promise((resolve) => {
    if (!fs.existsSync(sock)) { resolve({ error: "socket not found" }); return; }
    const socket = net.createConnection(sock);
    let data = "";
    const timeout = setTimeout(() => { socket.destroy(); resolve({ error: "timeout" }); }, 4000);
    socket.on("connect", () => {
      socket.write(JSON.stringify({ method: "status", params: {}, token }) + "\n");
    });
    socket.on("data", (chunk) => {
      data += chunk.toString();
      if (data.includes("\n")) {
        clearTimeout(timeout);
        socket.destroy();
        try { resolve(JSON.parse(data.trim())); } catch { resolve({ error: "invalid response" }); }
      }
    });
    socket.on("error", (err) => { clearTimeout(timeout); resolve({ error: err.message }); });
  });
}

export function isPidAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

// Design targets stated in blueprint.md Part I/1.3: 200ms interval, up to 5
// attempts (1 second total) -- well inside client.js's own 5000ms RPC
// timeout, so a genuine liveness failure is never masked by a slower,
// unrelated timeout firing first.
export async function verifyLiveness({ sock, token, daemonPid, monitorPid, watchdogPid }) {
  const result = { daemon: false, monitor: monitorPid == null, watchdog: watchdogPid == null, statusOk: false };
  for (let attempt = 0; attempt < 5; attempt++) {
    result.daemon = isPidAlive(daemonPid);
    if (monitorPid != null) result.monitor = isPidAlive(monitorPid);
    if (watchdogPid != null) result.watchdog = isPidAlive(watchdogPid);
    if (result.daemon) {
      const status = await pingDaemonStatus(sock, token);
      result.statusOk = status.ok === true;
    }
    if (result.daemon && result.statusOk && result.monitor && result.watchdog) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  result.allAlive = result.daemon && result.statusOk && result.monitor && result.watchdog;
  return result;
}

function launchDaemon(vars) {
  const child = spawn(process.execPath, [DAEMON], {
    env: { ...process.env, ...vars },
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.unref();

  let settled = false;
  return new Promise((resolve, reject) => {
    let timer;
    // child.unref() only unrefs the child process handle -- the piped
    // stdout/stderr streams it creates in THIS process are separate handles
    // that keep the event loop alive on their own. Without unref'ing them
    // too, the installer process never exits after a successful install
    // (it just hangs forever, however far past the summary it got).
    const finish = () => {
      clearTimeout(timer);
      child.stdout.unref();
      child.stderr.unref();
    };
    const done = (fn, val) => { if (!settled) { settled = true; finish(); fn(val); } };
    child.stdout.on('data', (data) => {
      if (data.toString().includes('listening on')) {
        done(resolve, child.pid);
      }
    });
    child.on('error', (err) => done(reject, err));
    child.on('exit', (code) => {
      if (!settled) done(reject, new Error(`Daemon exited with code ${code}`));
    });
    timer = setTimeout(() => done(reject, new Error('Daemon startup timeout')), 10000);
  });
}

function launchMonitorWatchdog(vars, asRoot) {
  // Launch monitor + watchdog as detached background processes (user-mode).
  // For root mode they are typically started via systemd by deploy-agent-enforcer.sh.
  const m = spawn("node", [MONITOR], {
    env: { ...process.env, ...vars }, detached: true, stdio: ["ignore", "ignore", "ignore"],
  });
  m.unref();
  const w = spawn("node", [WATCHDOG], {
    env: { ...process.env, ...vars }, detached: true, stdio: ["ignore", "ignore", "ignore"],
  });
  w.unref();
  return { monitorPid: m.pid, watchdogPid: w.pid };
}

// MOD-009: non-interactive path (--create-habit). All five fields are
// required CLI values -- no interactive fallback here, since this whole
// mode exists specifically for scripted/unattended use where prompting
// would hang forever against a closed stdin.
function createHabitDirect(ws, rawName, prompt, logic, evidence, level) {
  const name = normalizeHabitName(rawName);
  const habitsDir = path.join(ws, ".agent", "habits");
  fs.mkdirSync(habitsDir, { recursive: true });
  const file = path.join(habitsDir, `${name}.yaml`);
  if (fs.existsSync(file)) {
    throw new Error(`habit '${name}' already exists at ${file}`);
  }
  const yaml = buildHabitYaml({ name, prompt, logic, evidence, level });
  fs.writeFileSync(file, yaml);
  return name;
}

function createHabit(rl, ws) {
  console.log("\n--- Create a new habit ---");
  console.log("A habit is a principle you hold yourself to. The character kit");
  console.log("enforces it on every hold. Created habits are indexed immediately");
  console.log("into the habit database (the workspace habits dir) and take effect");
  console.log("on the next triggering cycle.\n");

  const askRequired = (question) => ask(rl, question).then((v) => {
    if (!v || !v.trim()) throw new Error(`${question} -- this can't be empty`);
    return v.trim();
  });

  const askLevel = () => ask(rl, `Enforcement level (${VALID_LEVELS.join("/")})`).then((v) => {
    const level = (v || "").trim().toLowerCase();
    if (!VALID_LEVELS.includes(level)) {
      throw new Error(`Invalid level "${v}" -- must be one of: ${VALID_LEVELS.join(", ")}`);
    }
    return level;
  });

  return ask(rl, "Habit name (becomes the file name, e.g. always-verify-before-ship)")
    .then((rawName) => {
      const name = normalizeHabitName(rawName);
      if (!name) throw new Error("habit name required");

      console.log("\nThe PROMPT is typically a question you ask YOURSELF to trigger");
      console.log("recognition of the logic behind this habit (e.g. \"Did I verify");
      console.log("this actually runs before claiming done?\"). It is what the");
      console.log("enforcer shows you when this habit is up for acknowledgment.\n");

      return askRequired("Prompt (the self-question that triggers recognition)").then((prompt) =>
        askRequired("Reasoning / logic behind this habit (why it governs your actions)").then((logic) =>
          askRequired("Evidence (how to verify THIS habit was actually applied, not generic)").then((evidence) =>
            askLevel().then((level) => {
              const habitsDir = path.join(ws, ".agent", "habits");
              fs.mkdirSync(habitsDir, { recursive: true });
              const file = path.join(habitsDir, `${name}.yaml`);
              if (fs.existsSync(file)) {
                console.log(`\nHabit '${name}' already exists at ${file} — not overwriting.`);
                return name;
              }
              const yaml = buildHabitYaml({ name, prompt, logic, evidence, level });
              fs.writeFileSync(file, yaml);
              console.log(`\nCreated habit: ${file}`);
              console.log("Indexed into the habit database. It will be offered on the next");
              console.log("acknowledgment cycle (the daemon loads habits from this dir).");
              return name;
            })
          )
        )
      );
    });
}

// ─── main flow ─────────────────────────────────────────────────────────────────
async function main(callerOpts) {
  const opts = callerOpts || parseArgs(process.argv.slice(2));
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  // Non-interactive habit creation: write the file and exit (no daemon needed).
  if (opts.createHabit) {
    const ws = opts.workspace || path.join(os.homedir(), ".agent-character-kit", "workspace");
    const absWs = path.resolve(ws);
    if (!opts.habitName || !opts.habitPrompt || !opts.habitLogic || !opts.habitEvidence || !opts.habitLevel) {
      console.error("ERROR: --create-habit needs --habit-name, --habit-prompt, --habit-logic, --habit-evidence, --habit-level");
      process.exit(1);
    }
    if (!VALID_LEVELS.includes(opts.habitLevel)) {
      console.error(`ERROR: --habit-level must be one of: ${VALID_LEVELS.join(", ")} (got "${opts.habitLevel}")`);
      process.exit(1);
    }
    try {
      const name = createHabitDirect(absWs, opts.habitName, opts.habitPrompt, opts.habitLogic, opts.habitEvidence, opts.habitLevel);
      console.log(`Created habit: ${name}`);
      rl.close();
      return;
    } catch (e) {
      console.error("Habit creation failed:", e.message);
      process.exit(1);
    }
  }

  let ws, socketMode, harness, asRoot, doMonitor, doWatchdog, doCompanion, doPython, doStartNow, doWireClaudeConfig;
  // Each entry: { ws, socketMode, harness, asRoot, rootSocket, doMonitor,
  // doWatchdog, doCompanion, doPython, doStartNow, doWireClaudeConfig }.
  // One entry per harness in interactive multi-harness mode; exactly one
  // entry for --yes/--all (unchanged behavior from before).
  const plannedInstalls = [];
  let rootSocketGlobal = null;

  // --all: root mode, all components, non-interactive
  if (opts.all) {
    opts.yes = true;
    harness = opts.harness || "generic";
    plannedInstalls.push({
      ws: opts.workspace || path.join(os.homedir(), ".agent-character-kit", "workspace"),
      socketMode: opts.socket || "unix",
      harness,
      asRoot: true,
      rootSocket: null,
      doMonitor: true,
      doWatchdog: true,
      doCompanion: true,
      doPython: opts.python !== false,
      doStartNow: opts.start !== false,
      doWireClaudeConfig: harness === "claude" && opts.writeClaudeConfig !== false,
    });
  } else if (opts.yes) {
    // opts.harnesses (array) lets non-interactive callers set up several
    // harnesses in one main() call, sharing the seenWorkspaces de-dupe
    // below when they resolve to the same workspace -- one
    // daemon/monitor/watchdog, not one per harness. Plain opts.harness
    // (single string) still works unchanged for the existing --harness CLI
    // flag. Neither given (the common `ack configure --yes` case): auto-detect
    // what's actually present instead of silently defaulting to "generic" --
    // this was a real regression once postinstall.js stopped forwarding a
    // pre-detected array (CL-0007 removed that whole code path).
    const harnessList = (opts.harnesses && opts.harnesses.length)
      ? opts.harnesses
      : (opts.harness ? [opts.harness] : detectHarnesses());
    for (const h of harnessList) {
      plannedInstalls.push({
        ws: opts.workspace || path.join(os.homedir(), ".agent-character-kit", "workspace"),
        socketMode: opts.socket || "unix",
        harness: h,
        asRoot: opts.root ?? false,
        rootSocket: null,
        doMonitor: opts.monitor,
        doWatchdog: opts.watchdog,
        doCompanion: opts.companion,
        doPython: opts.python ?? false,
        doStartNow: opts.start !== false,
        doWireClaudeConfig: h === "claude" && opts.writeClaudeConfig !== false,
      });
    }
  } else {
    console.log("\n=== Agent Character Kit — interactive install ===\n");
    console.log("This sets up the enforcement daemon, your harness companion(s),");
    console.log("and the acknowledgment monitor/watchdog. Every step is optional");
    console.log("to skip; press Enter to accept the default.\n");

    console.log("\n⚠ SECURITY-RELEVANT — read before answering. Three real options,");
    console.log("  not two — pick the privilege boundary for the daemon/monitor/watchdog:");
    console.log("");
    console.log("  [1] System service (root, via systemd)  — RECOMMENDED");
    console.log("      Daemon + monitor + watchdog run as root. Strongest boundary: the");
    console.log("      agent's own shell/exec tools cannot kill, edit, or replace them at");
    console.log("      all. ONE shared instance for the whole machine.");
    console.log("");
    console.log("  [2] Dedicated service user (non-root, via systemd)  — recommended if");
    console.log("      you'd rather not grant root");
    console.log("      Same real boundary as [1] (the agent's uid still can't touch a");
    console.log("      different uid's process) without needing full root. Creates a new");
    console.log("      unprivileged system user (default: ack-enforcer) just for this.");
    console.log("");
    console.log("  [3] Trust the agent (user-mode, same uid as the agent)  — HIGHLY NOT");
    console.log("      RECOMMENDED");
    console.log("      Daemon runs as YOUR user, same as the agent. The agent's own tools");
    console.log("      CAN kill this daemon or edit its config directly — same-uid means");
    console.log("      same permissions. This is a reminder/deterrent, not a boundary.");
    console.log("");
    console.log("  Options [1] and [2] both actually run");
    console.log(`    sudo bash ${path.join(REPO, "deploy", "deploy-agent-enforcer.sh")}`);
    console.log("  right now if chosen — prompts for your sudo password itself, no");
    console.log("  separate manual step afterward. Full comparison: AGENTS.md § User-mode");
    console.log("  vs Root-mode.");
    const privilegeChoice = await ask(rl, "\nPrivilege mode [1/2/3]", "1");

    let asRootGlobal = false;
    let serviceUser = null;
    if (privilegeChoice === "1" || privilegeChoice === "2") {
      asRootGlobal = true;
      const deployEnv = { ...process.env };
      if (privilegeChoice === "2") {
        serviceUser = (await ask(rl, "Dedicated service user name", "ack-enforcer")).trim() || "ack-enforcer";
        deployEnv.ACK_SERVICE_USER = serviceUser;
        deployEnv.ACK_AGENT_USER = os.userInfo().username;
      }
      const deployScript = path.join(REPO, "deploy", "deploy-agent-enforcer.sh");
      console.log(`\nRunning: sudo bash ${deployScript}${serviceUser ? ` (ACK_SERVICE_USER=${serviceUser})` : ""}`);
      console.log("(you'll be prompted for your sudo password now if needed)\n");
      const result = spawnSync("sudo", ["-E", "bash", deployScript], { stdio: "inherit", env: deployEnv });
      if (result.error || result.status !== 0) {
        console.error(
          "\nDeploy failed" + (result.status != null ? ` (exit ${result.status})` : "") +
          ". Aborting — fix the error above and re-run `ack install`."
        );
        rl.close();
        process.exit(1);
      }
      rootSocketGlobal = process.env.ENFORCER_SOCKET || "/run/agent-enforcer/main.sock";
      console.log(`\nDaemon installed and running${serviceUser ? ` as '${serviceUser}'` : " as root"}. Shared socket: ${rootSocketGlobal}\n`);
      if (serviceUser) {
        console.log("NOTE: group membership for the client group only applies to NEW login");
        console.log("sessions — you may need to log out/in (or `newgrp ack-clients`) before");
        console.log("the agent can actually reach the socket.\n");
      }
    } else {
      console.log("\nProceeding in user-mode (same uid as the agent) — highly not");
      console.log("recommended, per the warning above, but this is your call.\n");
    }

    console.log("Which harness(es) do you use on this machine? You'll confirm a");
    console.log("workspace for each one next (skipped in root mode — they all share");
    console.log("the one root daemon above). Leave blank when you've added them all.");
    const harnesses = [];
    while (true) {
      const prompt = harnesses.length
        ? "Another harness? [claude | cursor | gemini | opencode | hermes | generic] (blank = done)"
        : "First harness [claude | cursor | gemini | opencode | hermes | generic]";
      const h = (await ask(rl, prompt, harnesses.length ? "" : "claude")).toLowerCase().trim();
      if (!h) break;
      harnesses.push(h);
    }
    if (harnesses.length === 0) harnesses.push("generic");

    let doMonitorGlobal = false, doWatchdogGlobal = false;
    if (!asRootGlobal) {
      console.log("\nThe monitor credits habit acknowledgments from the ack log so the");
      console.log("periodic hold can lift. Skipping it means holds never clear.");
      doMonitorGlobal = await yesNo(rl, "Set up the acknowledgment monitor (credits daemon from ack log)?", true);

      console.log("\nThe watchdog restarts the monitor if it dies — recommended whenever");
      console.log("you're running the monitor at all.");
      doWatchdogGlobal = await yesNo(rl, "Set up the monitor watchdog (revives monitor if it dies)?", true);
    } else {
      console.log("\n(monitor + watchdog already running as root via systemd, from the");
      console.log("deploy step above — not asking again.)");
    }

    console.log("\nOnly needed if a companion you use is Python-based (e.g. the Hermes");
    console.log("plugin). Node-only companions (ack hook) don't need this.");
    const doPythonGlobal = await yesNo(rl, "Install Python ACK bindings (optional pip package)?", false);

    let doStartNowGlobal = false;
    if (!asRootGlobal) {
      console.log("\nThis actually launches the daemon (and monitor/watchdog if selected)");
      console.log("as background processes right now. Say no to only write config/env");
      console.log("files and start everything yourself later.");
      doStartNowGlobal = await yesNo(rl, "Start the daemon/monitor/watchdog now?", true);
    }

    let firstNonRootWs = null;
    for (const h of harnesses) {
      let hWs = null;
      if (!asRootGlobal) {
        console.log(`\n--- Workspace for '${h}' ---`);
        console.log("Point this at an EXISTING agent workspace (I can scan a directory");
        console.log("for SOUL.md / .agent/constitution.yaml and let you pick one), or");
        console.log("enter/create a path manually.");
        const mode = (await ask(rl, "Scan for an existing workspace, or enter manually? [scan|manual]", "manual")).toLowerCase();
        if (mode.startsWith("s")) {
          const scanRoot = await ask(rl, "Directory to scan", os.homedir());
          const found = discoverAgentWorkspaces(scanRoot);
          if (found.length === 0) {
            console.log(`No SOUL.md / .agent/constitution.yaml found under ${scanRoot}.`);
            hWs = await ask(rl, "Workspace path", path.join(os.homedir(), ".agent-character-kit", h));
          } else {
            console.log("Found:");
            found.forEach((f, i) => console.log(`  ${i + 1}) ${f.dir}  (${f.marker})`));
            const pick = await ask(rl, "Pick a number, or type a different path", "1");
            const idx = parseInt(pick, 10);
            hWs = (!Number.isNaN(idx) && found[idx - 1]) ? found[idx - 1].dir : pick;
          }
        } else {
          hWs = await ask(rl, "Workspace path", path.join(os.homedir(), ".agent-character-kit", h));
        }
        hWs = path.resolve(hWs);
        if (!firstNonRootWs) firstNonRootWs = hWs;
      }

      let hWireClaude = false;
      if (h === "claude") {
        console.log("\nWithout this, the hook config is only printed — Claude Code never");
        console.log("actually calls it. Writing it in wires enforcement for real (merges");
        console.log("with your existing hooks, doesn't touch anything else).");
        hWireClaude = await yesNo(rl, `Write the PreToolUse hook into ${claudeSettingsPath()} now?`, true);
      }

      plannedInstalls.push({
        ws: hWs,
        socketMode: "unix",
        harness: h,
        asRoot: asRootGlobal,
        rootSocket: rootSocketGlobal,
        doMonitor: doMonitorGlobal,
        doWatchdog: doWatchdogGlobal,
        doCompanion: true,
        doPython: doPythonGlobal,
        doStartNow: doStartNowGlobal,
        doWireClaudeConfig: hWireClaude,
      });
    }

    // Habit creator — ask once, applies to the first user-mode workspace
    // (root mode's constitution/habits live in the shared root workspace,
    // already seeded by deploy-agent-enforcer.sh).
    if (firstNonRootWs) {
      while (await yesNo(rl, "Create a habit now (interactive)?", false)) {
        try {
          await createHabit(rl, firstNonRootWs);
        } catch (e) {
          console.log("Habit not created:", e.message);
        }
      }
    }
  }

  rl.close();

  // Multiple harnesses can share one workspace (always true in root mode --
  // there's exactly one shared root workspace). The daemon/env/habits/
  // monitor/watchdog for a workspace only need provisioning ONCE per run;
  // every harness after the first one sharing that workspace just wires its
  // own companion against what's already there.
  const seenWorkspaces = new Map(); // absWs -> { sock, wsEnv, daemonPid, ackLog }
  const summaries = [];
  let anyPython = false;

  for (const inst of plannedInstalls) {
    ({ harness, asRoot, doMonitor, doWatchdog, doCompanion, doPython, doStartNow, doWireClaudeConfig, socketMode } = inst);
    if (doPython) anyPython = true;

    const absWs = asRoot
      ? (process.env.AGENT_WORKSPACE || "/var/lib/agent-character-kit/workspace")
      : path.resolve(inst.ws);
    const sock = asRoot
      ? (inst.rootSocket || process.env.ENFORCER_SOCKET || "/run/agent-enforcer/main.sock")
      : resolveSocket(socketMode, absWs);
    const ackLog = path.join(absWs, ".agent", "ack.jsonl");
    const wsEnv = path.join(absWs, ".env");

    let daemonPid = null;
    let liveness = null;
    let monitorMsg;
    let alreadyProvisioned = seenWorkspaces.has(absWs);

    if (asRoot) {
      monitorMsg = "root mode: daemon + monitor + watchdog already running via systemd";
      alreadyProvisioned = true; // root workspace is provisioned by deploy-agent-enforcer.sh, not here
    } else if (alreadyProvisioned) {
      monitorMsg = `already running for this workspace (shared with an earlier harness in this run: ${seenWorkspaces.get(absWs).harnesses.join(", ")})`;
      daemonPid = seenWorkspaces.get(absWs).daemonPid;
    } else {
      // MOD-006: ACK_AUTH_TOKEN belongs in `vars` too, not just the client's
      // .env file. This is the officially-sanctioned "LAUNCH env" pathway
      // the daemon's own SECURITY comment describes (agent_enforcer_daemon.js:29-34)
      // -- explicit spawn-time env injection is correct and expected; only
      // the daemon PASSIVELY AUTO-LOADING the token from a .env file is the
      // thing that comment forbids (that would self-gate the daemon against
      // any client/test-harness that doesn't share the exact same .env).
      // Before this fix, `vars` never carried the token at all, so it never
      // reached the daemon/monitor/watchdog's actual process.env in
      // user-mode installs -- the auth gate existed but had nothing to check
      // against, i.e. it silently checked ACK_AUTH_TOKEN === undefined.
      const crypto = await import("crypto");
      // Reuse the workspace's existing token across re-runs instead of
      // rotating it every time. Two real problems otherwise, both found
      // live: (1) the daemon-reuse liveness check below would ping the
      // already-running daemon with a BRAND NEW token that doesn't match
      // what it was actually launched with, auth-fail, and silently fall
      // through to spawning a second daemon -- defeating the whole
      // idempotency fix; (2) anything that cached the old token (a running
      // hook process, a manually-tested client) would start getting
      // rejected on every re-run for no visible reason.
      let ackToken;
      try {
        const existingEnv = fs.readFileSync(wsEnv, "utf8");
        const m = existingEnv.match(/^ACK_AUTH_TOKEN=(.+)$/m);
        if (m) ackToken = m[1].trim();
      } catch { /* no existing .env yet -- first run for this workspace */ }
      if (!ackToken) ackToken = crypto.randomUUID();
      const vars = {
        AGENT_WORKSPACE: absWs,
        ENFORCER_SOCKET: sock,
        ACK_ACK_LOG: ackLog,
        ACK_AUTH_TOKEN: ackToken,
        ACK_MONITOR_PID: path.join(absWs, ".agent", "ack-monitor.pid"),
        ACK_MONITOR_STATE: path.join(absWs, ".agent", "ack-monitor.pos"),
        ACK_WATCHDOG_PID: path.join(absWs, ".agent", "ack-watchdog.pid"),
        ACK_MONITOR_BIN: MONITOR,
      };

      // 1. workspace scaffold
      fs.mkdirSync(path.join(absWs, ".agent", "habits"), { recursive: true });
      seedHabits(absWs);
      writeConstitution(absWs);

      // 2. single .env every component reads — workspace-scoped only. A
      // shared repo-root .env was tried before and silently clobbered
      // whichever agent installed most recently (its real ACK_AUTH_TOKEN
      // overwriting the prior agent's, with no warning) since every `ack
      // install` in the same checkout wrote to the same path. Per-workspace
      // .env is what every component actually reads (see
      // buildSelfContainedHookCommand below); no reason to also write a
      // collision-prone shared copy.
      writeEnvFile(wsEnv, {
        AGENT_WORKSPACE: absWs,
        ENFORCER_SOCKET: sock,
        ACK_ACK_LOG: ackLog,
        ACK_AUTH_TOKEN: ackToken,
        ACK_MONITOR_PID: vars.ACK_MONITOR_PID,
        ACK_MONITOR_STATE: vars.ACK_MONITOR_STATE,
        ACK_WATCHDOG_PID: vars.ACK_WATCHDOG_PID,
        ACK_MONITOR_BIN: MONITOR,
      });

      // 3. daemon -- idempotency check first. launchDaemon() always spawns a
      // fresh process with no liveness check of its own, and the daemon's
      // own unix-socket bind unlinks whatever's already at that path before
      // listening -- so re-running `ack configure --yes` against a workspace
      // that already has a live daemon used to spawn a SECOND daemon that
      // silently stole the socket out from under the first, leaving the
      // original orphaned (still running, no longer reachable) and racing
      // the acknowledgment/audit state between two competing processes.
      // Found live during Phase 2 re-run testing (2026-08-07). Reuse the
      // existing daemon when it's genuinely alive; only launch a fresh one
      // when it isn't.
      if (doStartNow) {
        const existing = await pingDaemonStatus(sock, ackToken);
        if (!existing.error) {
          console.log(`  Daemon already running on this socket -- reusing it, not spawning a second one.`);
          daemonPid = existing.pid || null;
        } else {
          daemonPid = await launchDaemon(vars);
        }
      }

      // 5. monitor + watchdog
      const procs = {};
      if (doStartNow) {
        if (doMonitor) {
          const m = spawn("node", [MONITOR], { env: { ...process.env, ...vars }, detached: true, stdio: ["ignore", "ignore", "ignore"] });
          m.unref();
          procs.monitorPid = m.pid;
        }
        if (doWatchdog) {
          const w = spawn("node", [WATCHDOG], { env: { ...process.env, ...vars }, detached: true, stdio: ["ignore", "ignore", "ignore"] });
          w.unref();
          procs.watchdogPid = w.pid;
        }
        monitorMsg = (procs.monitorPid || procs.watchdogPid)
          ? Object.entries(procs).map(([k, v]) => `${k} ${v}`).join(", ")
          : "skipped (not requested)";
      } else {
        monitorMsg = (doMonitor || doWatchdog) ? "configured, not started (see manual start commands below)" : "skipped";
      }

      // MOD-007: confirm daemon/monitor/watchdog are actually alive (RPC +
      // PID check) BEFORE reporting success -- spawn() not throwing only
      // means the OS accepted the fork, not that anything is still running
      // a moment later.
      if (doStartNow) {
        liveness = await verifyLiveness({
          sock, token: ackToken, daemonPid,
          monitorPid: doMonitor ? procs.monitorPid : null,
          watchdogPid: doWatchdog ? procs.watchdogPid : null,
        });
        if (!liveness.allAlive) {
          const missing = [];
          if (!liveness.daemon) missing.push("daemon (process not running)");
          else if (!liveness.statusOk) missing.push("daemon (running but not answering status RPC)");
          if (doMonitor && !liveness.monitor) missing.push("monitor (acknowledgments will not be credited)");
          if (doWatchdog && !liveness.watchdog) missing.push("watchdog (monitor will not self-heal if it dies)");
          monitorMsg += ` — LIVENESS CHECK FAILED: ${missing.join("; ")}`;
        }
      }
    }

    seenWorkspaces.set(absWs, {
      sock, wsEnv, daemonPid,
      harnesses: [...(seenWorkspaces.get(absWs)?.harnesses || []), harness],
    });

    // 4. companion (thin client hook config for any harness) — always
    // per-harness, even when the workspace/daemon is shared with another
    // harness from this same run.
    let companionMsg = "skipped";
    if (doCompanion) {
      const { generateConfig } = await import("../src/index.js");
      // Absolute path to this install's own bin, never "npx ack hook" -- if
      // the package isn't yet globally installed/linked (true for every
      // fresh install, since we wire the hook BEFORE the npm-install
      // prompt), npx silently falls back to fetching an unrelated public
      // package instead of running this CLI. Verified live: exactly this
      // happened in testing.
      const hookCmd = opts.hookCommand || `node ${shellQuote(ACK_BIN)} hook`;
      const config = generateConfig(harness, hookCmd);
      if (harness === "claude") {
        const rawCmd = config.hooks.PreToolUse[0].hooks[0].command;
        config.hooks.PreToolUse[0].hooks[0].command = asRoot
          // Root mode: no per-workspace .env / auth token (deploy-agent-enforcer.sh
          // doesn't set one, and the daemon only enforces one if present) --
          // just point directly at the shared root socket.
          ? `env ENFORCER_SOCKET=${shellQuote(sock)} ${rawCmd}`
          : buildSelfContainedHookCommand(rawCmd, wsEnv);
      }
      companionMsg = `Hook config for ${harness}:\n${JSON.stringify(config, null, 2)}`;
      if (harness === "claude") {
        if (doWireClaudeConfig) {
          const wrapped = config.hooks.PreToolUse[0].hooks[0].command;
          const settingsPath = writeClaudeHookConfig(wrapped);
          companionMsg += `\n\nWired into ${settingsPath} (PreToolUse + UserPromptSubmit hooks, merged with existing config).`;
        } else {
          companionMsg += `\n\nNot wired automatically (declined) -- add the above to ${claudeSettingsPath()} yourself, or re-run install.`;
        }
      }
    }

    summaries.push({ harness, absWs, sock, ackLog, daemonPid, companionMsg, monitorMsg, asRoot, alreadyProvisioned, doStartNow, doMonitor, doWatchdog, doWireClaudeConfig, liveness });
  }

  // 6. summary (informative, no force-close) — one block per harness
  for (const s of summaries) {
    console.log(`\n=== Install summary: ${s.harness} ===`);
    console.log("Mode:          ", s.asRoot
      ? "ROOT — enforcement is outside the agent's reach (real boundary)"
      : "USER — agent has same-UID access; this is a reminder, NOT a hard boundary");
    console.log("Workspace:     ", s.absWs);
    console.log("Socket:        ", s.sock);
    console.log("Ack log:       ", s.ackLog);
    console.log("Daemon pid:    ", s.daemonPid ?? "(not started)");
    console.log("Companion:     ", s.companionMsg);
    console.log("Monitor/Watch: ", s.monitorMsg);
    if (s.liveness) {
      console.log("Liveness:      ", s.liveness.allAlive
        ? "CONFIRMED — daemon answered status RPC, monitor + watchdog processes alive"
        : "FAILED — see LIVENESS CHECK FAILED detail above");
    }
    if (s.harness === "claude") {
      console.log(s.doWireClaudeConfig
        ? "Done. Claude Code enforcement is live — every tool call now goes through the daemon."
        : "Done. Config generated but NOT wired — Claude Code will not call the daemon until you add it.");
    } else {
      console.log("Done. Add the companion hook config to your harness to activate enforcement.");
    }
    if (!s.asRoot && !s.doStartNow) {
      console.log("Nothing was started for this workspace (declined). Start manually with:");
      console.log(`  env AGENT_WORKSPACE=${shellQuote(s.absWs)} ENFORCER_SOCKET=${shellQuote(s.sock)} ACK_ACK_LOG=${shellQuote(s.ackLog)} node ${DAEMON}`);
      console.log("  (or just source the workspace .env before running the command)");
    }
  }
  console.log("\nThe daemon holds every 5th call until you acknowledge 2 habits");
  console.log("with a real, situation-tied reason. No filler, no reuse.");
  console.log("");

  // MOD-007 / FEAT-001 Rules: "a liveness check failure must be reported as
  // a failure, never silently downgraded to a warning." The per-harness
  // detail is already printed above (Liveness: FAILED, with which specific
  // component); throwing here is what stops postinstall.js's catch-free
  // success path (and `ack install`'s own CLI wrapper) from reporting
  // overall success when it demonstrably isn't true.
  const failedLiveness = summaries.filter((s) => s.liveness && !s.liveness.allAlive);
  if (failedLiveness.length) {
    throw new Error(
      `Liveness check failed for: ${failedLiveness.map((s) => s.harness).join(", ")} ` +
      `-- see the "LIVENESS CHECK FAILED" detail printed above for exactly which component`
    );
  }

  // 7. ACK install prompt (do NOT auto-run npm/pip — visibility first)
  // The user installs the package explicitly; we surface the exact
  // command rather than running post-install scripts silently.
  console.log("\n─── Install Agent Character Kit (ACK) ───");
  console.log("  The CLI is installed locally. To make `ack` available");
  console.log("  system-wide (or in another project), install the package:");
  console.log("");
  console.log("    npm install -g @drdeeks/character-kit");
  console.log("    # or, from this repo root:");
  console.log("    npm install");
  console.log("");
  if (anyPython) {
    const pyDir = path.join(REPO, "python");
    if (fs.existsSync(path.join(pyDir, "pyproject.toml"))) {
      console.log("  Python bindings (optional, for Python-plugin companions):");
      console.log("    pip3 install " + pyDir);
      console.log("    # or, if Debian-guarded (PEP 668): pip3 install --break-system-packages " + pyDir);
    }
  }
  console.log("");
  console.log("  Run `ack --help` to see all commands once installed.");
}

const __isCLI = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (__isCLI) {
  main().catch((e) => {
    console.error("Install failed:", e.message);
    process.exit(1);
  });
}

export { parseArgs, resolveSocket, main, launchDaemon, seedHabits, writeConstitution, discoverAgentWorkspaces };