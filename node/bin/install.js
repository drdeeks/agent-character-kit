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
import os from "os";
import path from "path";
import readline from "readline";
import { spawn, spawnSync } from "child_process";
import { fileURLToPath, pathToFileURL } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, "..", ".."); // package root
const DAEMON = path.join(REPO, "node", "enforcer", "agent_enforcer_daemon.js");
const MONITOR = path.join(REPO, "deploy", "ack_monitor.py");
const WATCHDOG = path.join(REPO, "deploy", "ack_watchdog.py");

// ─── arg parsing (non-interactive) ────────────────────────────────────────────
function parseArgs(argv) {
  const out = { workspace: null, socket: null, harness: null, root: null, yes: false, monitor: true, watchdog: true, companion: true, createHabit: false, habitName: null, habitPrompt: null, habitLogic: null, all: false, hookCommand: null, python: null };
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
    else if (a === "--yes" || a === "-y") out.yes = true;
    else if (a === "--all") out.all = true;
    else if (a === "--hook-command") out.hookCommand = argv[++i];
    else if (a === "--python") out.python = true;
    else if (a === "--no-python") out.python = false;
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
  const m = spawn("/usr/bin/env", ["python3", MONITOR], {
    env: { ...process.env, ...vars }, detached: true, stdio: ["ignore", "ignore", "ignore"],
  });
  m.unref();
  const w = spawn("/usr/bin/env", ["python3", WATCHDOG], {
    env: { ...process.env, ...vars }, detached: true, stdio: ["ignore", "ignore", "ignore"],
  });
  w.unref();
  return { monitorPid: m.pid, watchdogPid: w.pid };
}

function createHabitDirect(ws, rawName, prompt, logic) {
  const name = normalizeHabitName(rawName);
  if (!name) throw new Error("habit name required");
  if (!prompt || !prompt.trim()) throw new Error("prompt required");
  if (!logic || !logic.trim()) throw new Error("reasoning required");
  const habitsDir = path.join(ws, ".agent", "habits");
  fs.mkdirSync(habitsDir, { recursive: true });
  const file = path.join(habitsDir, `${name}.yaml`);
  if (fs.existsSync(file)) {
    throw new Error(`habit '${name}' already exists at ${file}`);
  }
  const yaml = [
    `# Habit: ${name}`,
    `# Source question: ${prompt.trim()}`,
    `# Logic: ${logic.trim()}`,
    `name: "${name}"`,
    `prompt: ${JSON.stringify(prompt.trim())}`,
    `enforcement:`,
    `  level: "reminder"`,
    `behavior:`,
    `  kind: "standard"`,
    `  assert: ${JSON.stringify(logic.trim())}`,
    `  evidence: "The agent applies this habit consistently and can state WHY when held."`,
    `  logic: ${JSON.stringify(logic.trim())}`,
    "",
  ].join("\n");
  fs.writeFileSync(file, yaml);
  return name;
}

function normalizeHabitName(raw) {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function createHabit(rl, ws) {
  console.log("\n--- Create a new habit ---");
  console.log("A habit is a principle you hold yourself to. The character kit");
  console.log("enforces it on every hold. Created habits are indexed immediately");
  console.log("into the habit database (the workspace habits dir) and take effect");
  console.log("on the next triggering cycle.\n");

  return ask(rl, "Habit name (becomes the file name, e.g. always-verify-before-ship)")
    .then((rawName) => {
      const name = normalizeHabitName(rawName);
      if (!name) throw new Error("habit name required");

      console.log("\nThe PROMPT is typically a question you ask YOURSELF to trigger");
      console.log("recognition of the logic behind this habit (e.g. \"Did I verify");
      console.log("this actually runs before claiming done?\"). It is what the");
      console.log("enforcer shows you when this habit is up for acknowledgment.\n");

      return ask(rl, "Prompt (the self-question that triggers recognition)").then((prompt) => {
        if (!prompt.trim()) throw new Error("prompt required");
        return ask(rl, "Reasoning / logic behind this habit (why it governs your actions)").then((logic) => {
          if (!logic.trim()) throw new Error("reasoning required");

          const habitsDir = path.join(ws, ".agent", "habits");
          fs.mkdirSync(habitsDir, { recursive: true });
          const file = path.join(habitsDir, `${name}.yaml`);
          if (fs.existsSync(file)) {
            console.log(`\nHabit '${name}' already exists at ${file} — not overwriting.`);
            return name;
          }
          const yaml = [
            `# Habit: ${name}`,
            `# Source question: ${prompt.trim()}`,
            `# Logic: ${logic.trim()}`,
            `name: "${name}"`,
            `prompt: ${JSON.stringify(prompt.trim())}`,
            `enforcement:`,
            `  level: "reminder"`,
            `behavior:`,
            `  kind: "standard"`,
            `  assert: ${JSON.stringify(logic.trim())}`,
            `  evidence: "The agent applies this habit consistently and can state WHY when held."`,
            `  logic: ${JSON.stringify(logic.trim())}`,
            "",
          ].join("\n");
          fs.writeFileSync(file, yaml);
          console.log(`\nCreated habit: ${file}`);
          console.log("Indexed into the habit database. It will be offered on the next");
          console.log("acknowledgment cycle (the daemon loads habits from this dir).");
          return name;
        });
      });
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
    if (!opts.habitName || !opts.habitPrompt || !opts.habitLogic) {
      console.error("ERROR: --create-habit needs --habit-name, --habit-prompt, --habit-logic");
      process.exit(1);
    }
    try {
      const name = createHabitDirect(absWs, opts.habitName, opts.habitPrompt, opts.habitLogic);
      console.log(`Created habit: ${name}`);
      rl.close();
      return;
    } catch (e) {
      console.error("Habit creation failed:", e.message);
      process.exit(1);
    }
  }

  let ws, socketMode, harness, asRoot, doMonitor, doWatchdog, doCompanion, doPython;

  // --all: root mode, all components, non-interactive
  if (opts.all) {
    opts.yes = true;
    ws = opts.workspace || path.join(os.homedir(), ".agent-character-kit", "workspace");
    socketMode = opts.socket || "unix";
    harness = opts.harness || "generic";
    asRoot = true;
    doMonitor = true;
    doWatchdog = true;
    doCompanion = true;
    doPython = opts.python !== false;
  } else if (opts.yes) {
    ws = opts.workspace || path.join(os.homedir(), ".agent-character-kit", "workspace");
    socketMode = opts.socket || "unix";
    harness = opts.harness || "generic";
    asRoot = opts.root ?? false;
    doMonitor = opts.monitor;
    doWatchdog = opts.watchdog;
    doCompanion = opts.companion;
    doPython = opts.python ?? false;
  } else {
    console.log("\n=== Agent Character Kit — interactive install ===\n");
    console.log("This sets up the enforcement daemon, your harness companion,");
    console.log("and the acknowledgment monitor/watchdog. Every step is optional");
    console.log("to skip; press Enter to accept the default.\n");

    console.log("The workspace holds this install's habits, socket, and constitution.");
    console.log("Use one per project if you want isolated character/config per repo.");
    ws = await ask(rl, "Where should the agent workspace live?",
      path.join(os.homedir(), ".agent-character-kit", "workspace"));
    const absWs = path.resolve(ws);

    console.log("\nunix = local socket file (default, fastest, same-host only).");
    console.log("tcp  = network socket (needed on Windows, or if the agent runs");
    console.log("       in a different container/host than the daemon).");
    socketMode = await ask(rl, "Socket mode? [unix | tcp]", "unix");

    console.log("\nThe harness is which agent tool will call the companion hook.");
    harness = (await ask(rl, "Which harness? [claude | cursor | gemini | opencode | hermes | generic]", "generic")).toLowerCase();

    console.log("\n⚠ SECURITY-RELEVANT — read before answering:");
    console.log("  no  (user-mode): daemon runs as YOUR user, same as the agent.");
    console.log("      The agent's own shell/exec tools CAN kill this daemon or");
    console.log("      edit its config directly (same-UID = same permissions).");
    console.log("      This is a reminder/deterrent, not a hard boundary.");
    console.log("  yes (root-mode): daemon + monitor + watchdog run as root via");
    console.log("      systemd. The agent's tools run as a non-root user with no");
    console.log("      permission to touch a root-owned process — this is the");
    console.log("      only mode where the enforcement is actually outside the");
    console.log("      agent's reach. Requires sudo now and answers 'y' below.");
    console.log("  Full comparison: AGENTS.md § User-mode vs Root-mode.");
    asRoot = await yesNo(rl, "Install as ROOT (system-wide, self-respawning)?", false);

    console.log("\nThe companion is the hook config your harness calls on every");
    console.log("tool use — without it, the daemon runs but nothing asks it anything.");
    doCompanion = await yesNo(rl, "Set up the harness companion (thin client hook config)?", true);

    console.log("\nThe monitor credits habit acknowledgments from the ack log so the");
    console.log("periodic hold can lift. Skipping it means holds never clear.");
    doMonitor = await yesNo(rl, "Set up the acknowledgment monitor (credits daemon from ack log)?", true);

    console.log("\nThe watchdog restarts the monitor if it dies — recommended whenever");
    console.log("you're running the monitor at all.");
    doWatchdog = await yesNo(rl, "Set up the monitor watchdog (revives monitor if it dies)?", true);

    console.log("\nOnly needed if a companion you use is Python-based (e.g. the Hermes");
    console.log("plugin). Node-only companions (aik hook) don't need this.");
    doPython = await yesNo(rl, "Install Python ACK bindings (optional pip package)?", false);

    // Habit creator — create as many as wanted, then continue the install.
    while (await yesNo(rl, "Create a habit now (interactive)?", false)) {
      try {
        await createHabit(rl, absWs);
      } catch (e) {
        console.log("Habit not created:", e.message);
      }
    }
  }

  rl.close();

  const absWs = path.resolve(ws);
  const sock = resolveSocket(socketMode, absWs);
  const ackLog = path.join(absWs, ".agent", "ack.jsonl");
  const vars = {
    AGENT_WORKSPACE: absWs,
    ENFORCER_SOCKET: sock,
    ACK_ACK_LOG: ackLog,
    ACK_MONITOR_PID: path.join(absWs, ".agent", "ack-monitor.pid"),
    ACK_MONITOR_STATE: path.join(absWs, ".agent", "ack-monitor.pos"),
    ACK_WATCHDOG_PID: path.join(absWs, ".agent", "ack-watchdog.pid"),
    ACK_MONITOR_BIN: MONITOR,
  };

  // 1. workspace scaffold
  fs.mkdirSync(path.join(absWs, ".agent", "habits"), { recursive: true });
  seedHabits(absWs);
  writeConstitution(absWs);

  // 2. single .env every component reads
  const repoEnv = path.join(REPO, ".env");
  const wsEnv = path.join(absWs, ".env");
  // Generate a shared auth token so only the client holding it can talk to the
  // daemon socket. crypto.randomUUID is available on Node >= 14.17.
  const crypto = await import("crypto");
  const ackToken = crypto.randomUUID();
  const envLines = {
    AGENT_WORKSPACE: absWs,
    ENFORCER_SOCKET: sock,
    ACK_ACK_LOG: ackLog,
    ACK_AUTH_TOKEN: ackToken,
    ACK_MONITOR_PID: vars.ACK_MONITOR_PID,
    ACK_MONITOR_STATE: vars.ACK_MONITOR_STATE,
    ACK_WATCHDOG_PID: vars.ACK_WATCHDOG_PID,
    ACK_MONITOR_BIN: MONITOR,
  };
  writeEnvFile(repoEnv, envLines);
  writeEnvFile(wsEnv, envLines);

  // 3. daemon
  const daemonPid = await launchDaemon(vars);

  // 4. companion (thin client hook config for any harness)
  let companionMsg = "skipped";
  if (doCompanion) {
    const { generateConfig } = await import("../src/index.js");
    const hookCmd = opts.hookCommand || "npx aik hook";
    const config = generateConfig(harness, hookCmd);
    companionMsg = `Hook config for ${harness}:\n${JSON.stringify(config, null, 2)}`;
  }

  // 5. monitor + watchdog
  let monitorMsg = "skipped";
  const procs = {};
  if (doMonitor) {
    const m = spawn("/usr/bin/env", ["python3", MONITOR], {
      env: { ...process.env, ...vars }, detached: true, stdio: ["ignore", "ignore", "ignore"],
    });
    m.unref();
    procs.monitorPid = m.pid;
  }
  if (doWatchdog) {
    const w = spawn("/usr/bin/env", ["python3", WATCHDOG], {
      env: { ...process.env, ...vars }, detached: true, stdio: ["ignore", "ignore", "ignore"],
    });
    w.unref();
    procs.watchdogPid = w.pid;
  }
  if (procs.monitorPid || procs.watchdogPid) {
    monitorMsg = Object.entries(procs).map(([k, v]) => `${k} ${v}`).join(", ");
  }

  // 6. summary (informative, no force-close)
  console.log("\n=== Install summary ===");
  console.log("Mode:          ", asRoot
    ? "ROOT — enforcement is outside the agent's reach (real boundary)"
    : "USER — agent has same-UID access; this is a reminder, NOT a hard boundary");
  console.log("Workspace:     ", absWs);
  console.log("Socket:        ", sock);
  console.log("Ack log:       ", ackLog);
  console.log("Habits seeded: ", path.join(absWs, ".agent", "habits"));
  console.log(".env written:  ", `${repoEnv} + ${wsEnv}`);
  console.log("Daemon pid:    ", daemonPid);
  console.log("Companion:     ", companionMsg);
  console.log("Monitor/Watch: ", monitorMsg);
  console.log("\nDone. Add the companion hook config to your harness to activate enforcement.");
  console.log("The daemon holds every 5th call until you acknowledge 2 habits");
  console.log("with a real, situation-tied reason. No filler, no reuse.");
  if (!asRoot) {
    console.log("\nNote: this is a USER-mode install (see 'Mode' above). For an");
    console.log("actual privilege boundary the agent can't cross, re-run with the");
    console.log("root path: sudo bash deploy/deploy-agent-enforcer.sh && sudo bash");
    console.log("deploy/deploy-ack-services.sh — see AGENTS.md § User-mode vs Root-mode.");
  }
  console.log("");

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
  if (doPython) {
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

export { parseArgs, resolveSocket, main, launchDaemon, seedHabits, writeConstitution };