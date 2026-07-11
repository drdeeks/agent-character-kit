#!/usr/bin/env node
/**
 * @character-kit interactive installer.
 *
 * One command deploys the WHOLE kit and wires every component:
 *   - the enforcement daemon (CORE, out-of-process)
 *   - the harness companion (thin client: Hermes plugin OR aik hook)
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
 *   node bin/install.js --workspace X --socket unix --harness hermes --user --yes
 */

import fs from "fs";
import os from "os";
import path from "path";
import readline from "readline";
import { spawn } from "child_process";
import { fileURLToPath, pathToFileURL } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, "..", ".."); // package root
const DAEMON = path.join(REPO, "node", "enforcer", "agent_enforcer_daemon.js");
const MONITOR = path.join(REPO, "deploy", "ack_monitor.py");
const WATCHDOG = path.join(REPO, "deploy", "ack_watchdog.py");
const HERMES_PLUGIN = path.join(REPO, "python", "hermes_plugin");
const PY_CLIENT = path.join(REPO, "python", "agent_character_kit");

// ─── arg parsing (non-interactive) ────────────────────────────────────────────
function parseArgs(argv) {
  const out = { workspace: null, socket: null, harness: null, root: null, yes: false, monitor: true, watchdog: true, companion: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--workspace") out.workspace = argv[++i];
    else if (a === "--socket") out.socket = argv[++i];
    else if (a === "--harness") out.harness = argv[++i];
    else if (a === "--agent-dir") out.agentDir = argv[++i];
    else if (a === "--root") out.root = true;
    else if (a === "--user") out.root = false;
    else if (a === "--no-monitor") out.monitor = false;
    else if (a === "--no-watchdog") out.watchdog = false;
    else if (a === "--no-companion") out.companion = false;
    else if (a === "--yes" || a === "-y") out.yes = true;
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

function setupHermesCompanion(agentDir) {
  const dest = path.join(agentDir, "plugins", "agent-character-kit");
  fs.mkdirSync(dest, { recursive: true });
  for (const f of fs.readdirSync(HERMES_PLUGIN)) {
    const fp = path.join(HERMES_PLUGIN, f);
    if (fs.statSync(fp).isFile()) fs.copyFileSync(fp, path.join(dest, f));
  }
  return dest;
}

function launchDaemon(vars) {
  const child = spawn(process.execPath, [DAEMON], {
    env: { ...process.env, ...vars },
    detached: !vars.__root,
    stdio: "ignore",
  });
  child.unref();
  return child.pid;
}

function launchMonitorWatchdog(vars, asRoot) {
  // Launch monitor + watchdog as detached background processes (user-mode).
  // For root mode they are typically started via systemd by deploy-agent-enforcer.sh.
  const m = spawn("/usr/bin/env", ["python3", MONITOR], {
    env: { ...process.env, ...vars }, detached: true, stdio: "ignore",
  });
  m.unref();
  const w = spawn("/usr/bin/env", ["python3", WATCHDOG], {
    env: { ...process.env, ...vars }, detached: true, stdio: "ignore",
  });
  w.unref();
  return { monitorPid: m.pid, watchdogPid: w.pid };
}

// ─── main flow ─────────────────────────────────────────────────────────────────
async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  let ws, socketMode, harness, agentDir, asRoot, doMonitor, doWatchdog, doCompanion;

  if (opts.yes) {
    ws = opts.workspace || path.join(os.homedir(), ".agent-character-kit", "workspace");
    socketMode = opts.socket || "unix";
    harness = opts.harness || "hermes";
    agentDir = opts.agentDir || path.join(os.homedir(), ".hermes");
    asRoot = opts.root ?? false;
    doMonitor = opts.monitor;
    doWatchdog = opts.watchdog;
    doCompanion = opts.companion;
  } else {
    console.log("\n=== Agent Character Kit — interactive install ===\n");
    console.log("This sets up the enforcement daemon, your harness companion,");
    console.log("and the acknowledgment monitor/watchdog. Every step is optional");
    console.log("to skip; press Enter to accept the default.\n");

    ws = await ask(rl, "Where should the agent workspace live? (habits, socket, constitution)",
      path.join(os.homedir(), ".agent-character-kit", "workspace"));
    socketMode = await ask(rl, "Socket mode? [unix | tcp]", "unix");
    harness = (await ask(rl, "Which harness? [hermes | claude | cursor | opencode | generic]", "hermes")).toLowerCase();
    agentDir = await ask(rl, "Where is your agent's config/home directory? (companion gets dropped here)",
      harness === "hermes" ? path.join(os.homedir(), ".hermes") : path.join(os.homedir()));
    asRoot = await yesNo(rl, "Install as ROOT (system-wide, self-respawning)?", false);
    doCompanion = await yesNo(rl, "Set up the harness companion (thin client)?", true);
    doMonitor = await yesNo(rl, "Set up the acknowledgment monitor (credits daemon from ack log)?", true);
    doWatchdog = await yesNo(rl, "Set up the monitor watchdog (revives monitor if it dies)?", true);
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
    __root: asRoot,
  };

  // 1. workspace scaffold
  fs.mkdirSync(path.join(absWs, ".agent", "habits"), { recursive: true });
  seedHabits(absWs);
  writeConstitution(absWs);

  // 2. single .env every component reads
  const repoEnv = path.join(REPO, ".env");
  const wsEnv = path.join(absWs, ".env");
  const envLines = {
    AGENT_WORKSPACE: absWs,
    ENFORCER_SOCKET: sock,
    ACK_ACK_LOG: ackLog,
    ACK_MONITOR_PID: vars.ACK_MONITOR_PID,
    ACK_MONITOR_STATE: vars.ACK_MONITOR_STATE,
    ACK_WATCHDOG_PID: vars.ACK_WATCHDOG_PID,
    ACK_MONITOR_BIN: MONITOR,
  };
  writeEnvFile(repoEnv, envLines);
  writeEnvFile(wsEnv, envLines);

  // 3. daemon
  const daemonPid = launchDaemon(vars);

  // 4. companion
  let companionMsg = "skipped";
  if (doCompanion) {
    if (harness === "hermes") {
      const dest = setupHermesCompanion(agentDir);
      companionMsg = `Hermes plugin -> ${dest} (restart Hermes to load it)`;
    } else {
      companionMsg = `Use: node node/bin/aik.js hook --framework ${harness} --config`;
    }
  }

  // 5. monitor + watchdog
  let monitorMsg = "skipped";
  if (doMonitor || doWatchdog) {
    const procs = launchMonitorWatchdog(vars, asRoot);
    monitorMsg = `monitor pid ${procs.monitorPid}, watchdog pid ${procs.watchdogPid}`;
  }

  // 6. summary (informative, no force-close)
  console.log("\n=== Install summary ===");
  console.log("Workspace:     ", absWs);
  console.log("Socket:        ", sock);
  console.log("Ack log:       ", ackLog);
  console.log("Habits seeded: ", path.join(absWs, ".agent", "habits"));
  console.log(".env written:  ", `${repoEnv} + ${wsEnv}`);
  console.log("Daemon pid:    ", daemonPid);
  console.log("Companion:     ", companionMsg);
  console.log("Monitor/Watch: ", monitorMsg);
  console.log("\nDone. Reference your harness's companion to activate enforcement.");
  console.log("The daemon holds every 5th call until you acknowledge 2 habits");
  console.log("with a real, situation-tied reason. No filler, no reuse.\n");
}

const __isCLI = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (__isCLI) {
  main().catch((e) => {
    console.error("Install failed:", e.message);
    process.exit(1);
  });
}

export { parseArgs, resolveSocket };
