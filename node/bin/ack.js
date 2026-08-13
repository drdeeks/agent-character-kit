#!/usr/bin/env node
/**
 * ack — Agent Character Kit CLI
 *
 * Single binary: enforcer daemon + companion hook + config + diagnostics + repair
 *
 * Commands:
 *   hook <framework>           Generate hook config for any agent framework
 *   config [show|verify|set|write-env]  Manage configuration
 *   status                     Quick socket + daemon health overview
 *   doctor                     Deep structured diagnostics (read-only)
 *   repair [target]            Fix problems (auto-fix, no dry-run gate)
 *   install                    Deploy the kit (delegates to install.js)
 *   habit create <name>        Create a habit
 *   habit list                 List all habits
 */

import { Command } from "commander";
import { generateConfig, processToolCall, processPromptSubmit, VERSION } from "../src/index.js";
import { EnforcerClient } from "../src/enforcer/client.js";
import fs from "fs";
import os from "os";
import path from "path";
import { spawn, spawnSync } from "child_process";
import { fileURLToPath } from "url";
import { normalizeHabitName, buildHabitYaml, VALID_LEVELS } from "../src/habits/build.js";
import { buildAgentList, parseMainMenuChoice, parseAgentMenuChoice } from "../src/manage-menu.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..");
// Absolute path to this exact file -- never "npx ack hook" as a default.
// If the package isn't globally installed/linked, npx silently fetches an
// unrelated public package instead of running this CLI (verified live).
const SELF = fileURLToPath(import.meta.url);

// ═══════════════════════════════════════════════════════════════════════════════
//  Path resolution helpers
// ═══════════════════════════════════════════════════════════════════════════════

function resolveWorkspace() {
  return process.env.AGENT_WORKSPACE ||
    path.join(os.homedir(), ".agent-character-kit", "workspace");
}

function resolveSocket() {
  return process.env.ENFORCER_SOCKET ||
    (process.env.AGENT_WORKSPACE
      ? path.join(process.env.AGENT_WORKSPACE, ".agent", "enforcer.sock")
      : path.join(os.homedir(), ".agent-character-kit", "workspace", ".agent", "enforcer.sock"));
}

// Best-effort "has this machine ever been through `ack configure`" check --
// NOT a hard gate, just what decides whether to print a first-run nudge.
// No npm lifecycle script is involved anywhere in this: it only ever runs
// because the user themselves typed `ack` or `ack status`. A false
// positive (custom/discovered workspace path this doesn't know about) just
// means an unnecessary but harmless reminder -- `ack configure` is safe to
// re-run against an already-configured workspace.
function looksNeverConfigured() {
  const rootSocketExists = fs.existsSync("/run/agent-enforcer/main.sock");
  const defaultWs = path.join(os.homedir(), ".agent-character-kit", "workspace");
  const defaultWsConfigured = fs.existsSync(path.join(defaultWs, ".agent", "constitution.yaml"));
  const envWsConfigured = process.env.AGENT_WORKSPACE &&
    fs.existsSync(path.join(process.env.AGENT_WORKSPACE, ".agent", "constitution.yaml"));
  return !rootSocketExists && !defaultWsConfigured && !envWsConfigured;
}

const FIRST_RUN_NUDGE =
  "No Agent Character Kit setup found on this machine yet.\n" +
  "Run `ack configure` for a guided, interactive setup (asks about root vs\n" +
  "user mode, which harness(es) you use, and confirms before touching\n" +
  "anything -- nothing runs without you saying yes at each step).\n" +
  "Or `ack configure --yes` for a fast, non-interactive default (user-mode,\n" +
  "generic harness, no daemon auto-started).\n";

function resolveAckLog() {
  return process.env.ACK_ACK_LOG ||
    path.join(resolveWorkspace(), ".agent", "ack.jsonl");
}

// ═══════════════════════════════════════════════════════════════════════════════
//  Daemon check helpers
// ═══════════════════════════════════════════════════════════════════════════════

async function checkDaemon(socketPath = resolveSocket()) {
  return new Promise((resolve) => {
    const client = new EnforcerClient(socketPath);
    let attempts = 0;
    const tryCall = () => {
      client.call("status", {}).then(res => {
        if (!res || res.error) {
          if (res?.error === "invalid request" && attempts < 1) {
            attempts++;
            setTimeout(tryCall, 50);
            return;
          }
          resolve({ alive: false, error: res?.error });
        } else {
          resolve({ alive: true, ...res });
        }
      }).catch(err => resolve({ alive: false, error: err.message }));
    };
    tryCall();
    setTimeout(() => resolve({ alive: false, error: "timeout" }), 3000);
  });
}

// Same registry-path priority as agent_enforcer_daemon.js's own
// resolveWorkspaces() -- checked here too so `ack status`/doctor/repair
// report the SAME agents the daemon itself would actually serve, not a
// separately-guessed list that can drift out of sync with it.
function readWorkspacesRegistry() {
  const candidates = [
    process.env.ACK_WORKSPACES_REGISTRY,
    "/var/lib/agent-character-kit/workspaces.json",
    path.join(os.homedir(), ".agent-character-kit", "workspaces.json"),
  ].filter(Boolean);
  for (const rp of candidates) {
    try {
      if (fs.existsSync(rp)) {
        const list = JSON.parse(fs.readFileSync(rp, "utf8"));
        if (Array.isArray(list) && list.length) return { registryPath: rp, agents: list };
      }
    } catch { /* best-effort */ }
  }
  return { registryPath: null, agents: [] };
}

// Looks up one registered agent by name (its workspace dir's own basename,
// same as what resolveAgentName() in agent-identity.js assigned it at
// deploy time) and returns its resolved paths -- used by `ack config
// show/verify/write-env --agent <name>` to target a specific agent instead
// of the single default workspace.
function resolveAgentByName(name) {
  const { agents } = readWorkspacesRegistry();
  const match = agents.find((ws) => path.basename(ws) === name);
  if (!match) return null;
  return {
    ws: match,
    sock: path.join(match, ".agent", `${name}.sock`),
    ackLog: path.join(match, ".agent", "ack.jsonl"),
  };
}

async function checkAllSockets() {
  const results = {};
  const candidates = [
    { name: "user workspace", path: path.join(resolveWorkspace(), ".agent", "enforcer.sock") },
    { name: "env ENFORCER_SOCKET", path: resolveSocket() },
  ];

  // One enforcer, N agents -- check each REGISTERED agent's own socket
  // individually, not one opaque "root (systemd)" blob that can't tell you
  // which of potentially many agents is actually up (drdeek, 2026-08-07:
  // "how do you know if you have 12 agents running at the same time on one
  // sock which one is doing what?").
  const { registryPath, agents } = readWorkspacesRegistry();
  if (agents.length) {
    for (const ws of agents) {
      const name = path.basename(ws);
      candidates.push({ name: `agent: ${name}`, path: path.join(ws, ".agent", `${name}.sock`), ws });
    }
  } else {
    // No registry found at all -- either a pre-registry deploy, or nothing
    // ever configured. Keep the old generic root-mode check as a fallback
    // so status/doctor/repair still say SOMETHING useful in that case.
    candidates.unshift({ name: "root (systemd)", path: "/run/agent-enforcer/main.sock" });
  }

  for (const c of candidates) {
    if (!c.path) {
      results[c.name] = { checked: false, reason: "not configured" };
      continue;
    }
    const r = await checkDaemon(c.path);
    results[c.name] = { path: c.path, checked: true, ws: c.ws, ...r };
  }
  return { results, registryPath };
}

// Shared by `ack config verify` and `ack manage`'s per-agent status view --
// one real implementation instead of two that can drift.
async function verifyAgentReport(ws, sock, ackLogPath, label) {
  if (label) console.log(`\n=== ${label} ===`);
  const habitsDir = path.join(ws, ".agent", "habits");
  const constitution = path.join(ws, ".agent", "constitution.yaml");
  console.log("Workspace:", ws, fs.existsSync(ws) ? "✓" : "✗");
  console.log("  habits:", fs.existsSync(habitsDir) ? "✓" : "✗");
  console.log("  constitution:", fs.existsSync(constitution) ? "✓" : "✗");
  console.log("Socket:", sock);
  const daemon = await checkDaemon(sock);
  console.log("  daemon:", daemon.alive ? "✓ reachable" : `✗ ${daemon.error || "unreachable"}`);
  console.log("Ack log:", ackLogPath, fs.existsSync(ackLogPath) ? "✓" : "✗");
  return { daemonAlive: daemon.alive };
}

// ═══════════════════════════════════════════════════════════════════════════════
//  Utility
// ═══════════════════════════════════════════════════════════════════════════════

const PASS = "PASS";
const FAIL = "FAIL";
const WARN = "WARN";

function section(title) {
  console.log(`\n─── ${title} ───`);
}

function check(label, ok, detail = "") {
  const icon = ok ? "✓" : "✗";
  const tag = ok ? PASS : FAIL;
  console.log(`  ${icon} [${tag}] ${label}${detail ? " — " + detail : ""}`);
}

function warn(label, detail = "") {
  console.log(`  △ [${WARN}] ${label}${detail ? " — " + detail : ""}`);
}

// ═══════════════════════════════════════════════════════════════════════════════
//  Stale resource detection & cleanup / auto-activate
// ═══════════════════════════════════════════════════════════════════════════════

const DAEMON_BIN = path.join(REPO_ROOT, "node", "enforcer", "agent_enforcer_daemon.js");

// Scan /proc for running agent_enforcer_daemon.js processes.
// Returns [{ pid, cwd, workspace, socket, orphan }]
//   orphan = the workspace dir no longer exists (leftover from a test run)
function findEnforcerDaemons() {
  const out = [];
  try {
    for (const pid of fs.readdirSync("/proc").filter(p => /^\d+$/.test(p))) {
      let cmdline = "";
      try { cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8"); } catch { continue; }
      if (!cmdline.includes("agent_enforcer_daemon.js")) continue;
      let cwd = "";
      try { cwd = fs.readlinkSync(`/proc/${pid}/cwd`); } catch { /* gone */ }
      let workspace = "", socket = "";
      try {
        const env = fs.readFileSync(`/proc/${pid}/environ`, "utf8").split("\0");
        for (const line of env) {
          if (line.startsWith("AGENT_WORKSPACE=")) workspace = line.slice("AGENT_WORKSPACE=".length);
          else if (line.startsWith("ENFORCER_SOCKET=")) socket = line.slice("ENFORCER_SOCKET=".length);
        }
      } catch { /* ignore */ }
      const orphan = workspace && !fs.existsSync(workspace);
      out.push({ pid: parseInt(pid, 10), cwd, workspace, socket, orphan });
    }
  } catch { /* /proc unavailable */ }
  return out;
}

// Find dead socket files: a .sock path that exists but no daemon owns it.
function findDeadSockets() {
  const dead = [];
  const cands = [
    path.join(resolveWorkspace(), ".agent", "enforcer.sock"),
    path.join(os.homedir(), ".agent-character-kit", "workspace", ".agent", "enforcer.sock"),
  ].concat(process.env.ENFORCER_SOCKET && !process.env.ENFORCER_SOCKET.startsWith("tcp://") ? [process.env.ENFORCER_SOCKET] : []);
  const liveSockets = new Set(findEnforcerDaemons().map(d => d.socket).filter(Boolean));
  for (const s of cands) {
    if (s && fs.existsSync(s) && !liveSockets.has(s)) dead.push(s);
  }
  return dead;
}

// Kill a daemon by pid (force). Returns true if killed or already gone.
function killDaemonPid(pid) {
  try { process.kill(pid, "SIGKILL"); return true; }
  catch { return false; }
}

// Revive the daemon for a workspace (detached + unref so it survives the CLI).
// Used by repair --auto-activate once an agent's workspace is active again.
function reviveDaemon(workspace) {
  const sock = path.join(workspace, ".agent", "enforcer.sock");
  const child = spawn(process.execPath, [DAEMON_BIN], {
    env: { ...process.env, AGENT_WORKSPACE: workspace, ENFORCER_SOCKET: sock },
    stdio: "ignore",
    detached: true,
  });
  child.unref();
  return child.pid;
}

// Clean stale resources: kill orphan daemons + remove dead sockets.
// Returns { killed: number, removedSockets: number, kept: number, daemons: [] }
function cleanupStaleResources({ killOrphans = true, removeSockets = true } = {}) {
  const daemons = findEnforcerDaemons();
  let killed = 0, kept = 0;
  for (const d of daemons) {
    if (d.orphan) {
      if (killOrphans) { if (killDaemonPid(d.pid)) killed++; }
      else kept++;
    } else {
      kept++; // live, attached to an existing workspace — never touch
    }
  }
  let removedSockets = 0;
  if (removeSockets) {
    for (const s of findDeadSockets()) {
      try { fs.unlinkSync(s); removedSockets++; } catch { /* ignore */ }
    }
  }
  return { killed, kept, removedSockets, daemons };
}

// Is a workspace "active" (an agent would use it)? Has habits seeded.
function isWorkspaceActive(workspace) {
  const habitsDir = path.join(workspace, ".agent", "habits");
  if (!fs.existsSync(habitsDir)) return false;
  return fs.readdirSync(habitsDir).some(f => f.endsWith(".yaml"));
}

// ═══════════════════════════════════════════════════════════════════════════════
//  `ack manage` -- daemon control helpers
// ═══════════════════════════════════════════════════════════════════════════════
//
// User-mode agents each run their own daemon process -- start/stop is a
// direct spawn/kill (reviveDaemon/killDaemonPid above), same as `ack
// repair --auto-activate`. Root-mode agents share ONE systemd-managed
// daemon (agent-enforcer.service, deploy-agent-enforcer.sh) serving every
// registered agent through the registry -- there is no per-agent process to
// start/stop there, so "start/stop/restart" for a root-mode agent is a
// systemctl call that affects EVERY root-mode agent at once. The menu says
// so before running it rather than implying it's scoped to just the one
// selected agent.

function daemonPidForWorkspace(ws) {
  const match = findEnforcerDaemons().find((d) => d.workspace === ws);
  return match ? match.pid : null;
}

function stopUserDaemon(ws) {
  const pid = daemonPidForWorkspace(ws);
  if (!pid) return false;
  return killDaemonPid(pid);
}

function systemctlDaemon(action) {
  console.log(`\nRunning: sudo systemctl ${action} agent-enforcer.service`);
  console.log("(shared by every root-mode agent -- you may be prompted for your sudo password)\n");
  const result = spawnSync("sudo", ["systemctl", action, "agent-enforcer.service"], { stdio: "inherit" });
  return !result.error && result.status === 0;
}

// Polls the socket instead of trusting a spawned pid or a systemctl exit
// code -- both can report "started" while the process dies moments later
// (missing constitution.yaml, port conflict, etc). 5 attempts / 250ms each,
// well inside the client's own request timeout, so a genuine failure isn't
// masked by a slower unrelated timeout firing first (same shape as
// install.js's verifyLiveness()).
async function reportDaemonLiveness(sock) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const result = await checkDaemon(sock);
    if (result.alive) {
      console.log("Confirmed alive.");
      return true;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  const final = await checkDaemon(sock);
  console.log(`Did NOT come up: ${final.error || "still unreachable"} -- check the workspace has a constitution.yaml (ack doctor / ack repair).`);
  return false;
}

// Removes a workspace from the registry file (user-mode registries under
// $HOME are directly writable; root-mode ones under /var/lib need sudo --
// EACCES is reported back rather than crashed on). Mirrors
// _registerWorkspace()'s own registry-file shape in
// agent_enforcer_daemon.js so both directions of the same operation agree
// on format. The daemon holds its workspace list in memory from when it
// started, so this alone doesn't stop it serving the removed agent until
// it's restarted -- callers are expected to say so.
function removeAgentFromRegistry(registryPath, ws) {
  try {
    const list = JSON.parse(fs.readFileSync(registryPath, "utf8"));
    const next = Array.isArray(list) ? list.filter((w) => w !== ws) : [];
    fs.writeFileSync(registryPath, JSON.stringify(next, null, 2) + "\n");
    return { ok: true, remaining: next.length };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
//  `ack manage` -- interactive menu
// ═══════════════════════════════════════════════════════════════════════════════

async function runManage() {
  while (true) {
    const { registryPath, agents: registryAgents } = readWorkspacesRegistry();
    const agents = buildAgentList({
      registryPath,
      registryAgents,
      defaultWs: resolveWorkspace(),
      defaultSock: resolveSocket(),
      defaultAckLog: resolveAckLog(),
    });

    console.log("\n=== Agent Character Kit — Manage ===\n");
    for (let i = 0; i < agents.length; i++) {
      const a = agents[i];
      const daemon = await checkDaemon(a.sock);
      const state = daemon.alive ? "🟢 alive" : "🔴 dead";
      console.log(`  ${i + 1}) ${a.name.padEnd(20)} ${state}   ${a.ws}`);
    }
    console.log(`  A) Add new agent (runs 'ack configure')`);
    console.log(`  R) Refresh`);
    console.log(`  Q) Quit`);

    const raw = await ask("\nChoice: ");
    const choice = parseMainMenuChoice(raw, agents.length);

    if (choice.action === "quit") return;
    if (choice.action === "refresh") continue;
    if (choice.action === "invalid") {
      console.log(`"${choice.raw}" isn't a valid choice.`);
      continue;
    }
    if (choice.action === "add") {
      spawnSync(process.execPath, [SELF, "configure"], { stdio: "inherit" });
      continue;
    }
    // select
    await runAgentMenu(agents[choice.index]);
  }
}

async function runAgentMenu(agent) {
  while (true) {
    console.log(`\n=== agent: ${agent.name} ${agent.rootMode ? "(root-mode, shared daemon)" : "(user-mode)"} ===`);
    console.log("Workspace:", agent.ws);
    console.log("Socket:", agent.sock);
    const daemon = await checkDaemon(agent.sock);
    console.log("Daemon:", daemon.alive ? "🟢 alive" : "🔴 dead");
    const habits = listHabitsForWorkspace(agent.ws, { print: false });
    console.log("Habits:", habits.length);

    console.log("");
    console.log("  1) Full status report");
    console.log("  2) List habits");
    console.log("  3) Create habit");
    console.log("  4) Delete habit");
    console.log(`  5) Start daemon${daemon.alive ? "  (already running)" : ""}`);
    console.log(`  6) Stop daemon${!daemon.alive ? "   (not running)" : ""}`);
    console.log("  7) Restart daemon");
    console.log("  8) Re-run configure for this agent");
    console.log(`  9) Remove agent from registry${agent.rootMode === false && agent.name === "default" ? "  (n/a -- not registry-backed)" : ""}`);
    console.log("  B) Back");
    console.log("  Q) Quit");

    const raw = await ask("\nChoice: ");
    const choice = parseAgentMenuChoice(raw);

    if (choice.action === "invalid") {
      console.log(`"${choice.raw}" isn't a valid choice.`);
      continue;
    }
    if (choice.action === "back") return;
    if (choice.action === "quit") process.exit(0);

    if (choice.action === "status") {
      await verifyAgentReport(agent.ws, agent.sock, agent.ackLog, null);
    } else if (choice.action === "habits") {
      listHabitsForWorkspace(agent.ws);
    } else if (choice.action === "habit-create") {
      await createHabitInteractive(agent.ws, undefined, {});
    } else if (choice.action === "habit-delete") {
      const rows = listHabitsForWorkspace(agent.ws);
      if (rows.length === 0) continue;
      const pick = (await ask("Habit name to delete (blank to cancel): ")).trim();
      if (!pick) continue;
      const fileName = normalizeHabitName(pick);
      const file = path.join(agent.ws, ".agent", "habits", `${fileName}.yaml`);
      if (!fs.existsSync(file)) {
        console.log("No such habit:", file);
        continue;
      }
      const confirmed = (await ask(`Delete ${file}? [y/N] `)).trim().toLowerCase();
      if (confirmed === "y" || confirmed === "yes") {
        fs.unlinkSync(file);
        console.log("Deleted:", file);
      } else {
        console.log("Cancelled.");
      }
    } else if (choice.action === "daemon-start") {
      if (daemon.alive) {
        console.log("Already running.");
      } else if (agent.rootMode) {
        systemctlDaemon("start");
        await reportDaemonLiveness(agent.sock);
      } else {
        const pid = reviveDaemon(agent.ws);
        console.log(`Spawned daemon (pid ${pid}) -- checking it actually came up...`);
        await reportDaemonLiveness(agent.sock);
      }
    } else if (choice.action === "daemon-stop") {
      if (!daemon.alive) {
        console.log("Not running.");
      } else if (agent.rootMode) {
        systemctlDaemon("stop");
      } else {
        console.log(stopUserDaemon(agent.ws) ? "Stopped." : "Could not find/stop the daemon process.");
      }
    } else if (choice.action === "daemon-restart") {
      if (agent.rootMode) {
        systemctlDaemon("restart");
        await reportDaemonLiveness(agent.sock);
      } else {
        if (daemon.alive) stopUserDaemon(agent.ws);
        const pid = reviveDaemon(agent.ws);
        console.log(`Spawned daemon (pid ${pid}) -- checking it actually came up...`);
        await reportDaemonLiveness(agent.sock);
      }
    } else if (choice.action === "reconfigure") {
      console.log(`\nLaunching 'ack configure' -- when it asks for a workspace path, use:\n  ${agent.ws}\n`);
      spawnSync(process.execPath, [SELF, "configure", "--workspace", agent.ws], { stdio: "inherit" });
    } else if (choice.action === "remove") {
      const { registryPath } = readWorkspacesRegistry();
      if (!registryPath) {
        console.log("Not registry-backed -- nothing to remove.");
        continue;
      }
      const confirmed = (await ask(`Remove '${agent.name}' (${agent.ws}) from the registry? [y/N] `)).trim().toLowerCase();
      if (confirmed !== "y" && confirmed !== "yes") {
        console.log("Cancelled.");
        continue;
      }
      const result = removeAgentFromRegistry(registryPath, agent.ws);
      if (!result.ok) {
        console.log(`Could not update registry: ${result.error}`);
        if (agent.rootMode) console.log(`Root-mode registry is likely owned by root -- try: sudo -e ${registryPath}`);
        continue;
      }
      console.log(`Removed. ${result.remaining} agent(s) remain in the registry.`);
      if (daemon.alive) {
        console.log("The daemon still has this workspace loaded from when it started.");
        const restart = (await ask("Restart the daemon now so it stops serving this agent? [y/N] ")).trim().toLowerCase();
        if (restart === "y" || restart === "yes") {
          if (agent.rootMode) systemctlDaemon("restart");
          else { stopUserDaemon(agent.ws); }
        }
      }
      return; // agent no longer exists -- back to the (refreshed) main menu
    }
  }
}



async function runDoctor() {
  const ws = resolveWorkspace();
  const habitsDir = path.join(ws, ".agent", "habits");
  const constitution = path.join(ws, ".agent", "constitution.yaml");
  const ackLogPath = resolveAckLog();
  const sock = resolveSocket();

  let passed = 0;
  let total = 0;

  function c(label, ok, detail) {
    total++;
    if (ok) passed++;
    check(label, ok, detail);
  }

  console.log("\n==========================================");
  console.log("   ACK DOCTOR — Full Diagnostic Report");
  console.log("==========================================");

  // Section 1: Version & Environment
  section("Version & Environment");
  c("Node.js >= 18", parseFloat(process.version.slice(1)) >= 18, process.version);
  c("Platform", true, `${process.platform} ${process.arch}`);

  const envKeys = ["AGENT_WORKSPACE", "ENFORCER_SOCKET", "ACK_ACK_LOG", "ACK_HABITS_DIR"];
  for (const key of envKeys) {
    if (process.env[key]) {
      check(true, `env ${key}=${process.env[key]}`);
    } else {
      warn(`env ${key} (unset — using default resolution)`);
    }
  }

  // Section 2: Workspace Integrity
  section("Workspace Integrity");
  c("Workspace directory exists", fs.existsSync(ws), ws);
  c("Habits directory exists", fs.existsSync(habitsDir), habitsDir);
  c("Constitution file exists", fs.existsSync(constitution), constitution);

  // Check if enforcer.yaml exists
  const enforcerYaml = path.join(ws, ".agent", "enforcer.yaml");
  c("Enforcer config exists", fs.existsSync(enforcerYaml), enforcerYaml);
  if (!fs.existsSync(enforcerYaml)) {
    warn("No enforcer.yaml — daemon uses embedded defaults");
  }

  // Habit count
  if (fs.existsSync(habitsDir)) {
    const habitFiles = fs.readdirSync(habitsDir).filter(f => f.endsWith(".yaml"));
    c("Habits present", habitFiles.length >= 5, `${habitFiles.length} YAML files`);

    // Sample validation — check first 5 for schema
    let validCount = 0;
    let invalidCount = 0;
    for (const f of habitFiles.slice(0, 30)) {
      try {
        const content = fs.readFileSync(path.join(habitsDir, f), "utf8");
        // Quote optional -- see the same fix in `habit list` above. Roughly
        // half the bundled habits use unquoted YAML scalars for these
        // fields; a quote-required check flagged them as invalid.
        const hasName = /^name:\s*"?\S/m.test(content);
        const hasPrompt = /^prompt:\s*"?\S/m.test(content);
        const hasLogic = /\blogic\b/.test(content);
        if (hasName && hasPrompt) validCount++;
        else invalidCount++;
      } catch { invalidCount++; }
    }
    if (invalidCount > 0) {
      warn(`${invalidCount} habit files have missing required fields (name/prompt)`);
    }
  }

  // Section 3: Daemon Connectivity
  section("Daemon Connectivity");

  // Check socket file existence
  if (sock.startsWith("tcp://")) {
    check(true, "TCP transport configured — no local socket file", sock);
  } else {
    c(`Socket file exists`, fs.existsSync(sock), sock);
  }

  const daemon = await checkDaemon(sock);
  if (daemon.alive) {
    c("Daemon reachable", true, sock);
    if (daemon.workspace) check(true, "Daemon reports workspace", daemon.workspace);
    // The daemon's status RPC returns a habit COUNT (enforcer.habits.length),
    // not an array of names -- it deliberately never hands out habit names
    // over the wire (see agent_enforcer_daemon.js toolTick / HABIT_POLICY.md
    // §4). Checking Array.isArray() here always failed and silently skipped
    // this check entirely.
    if (typeof daemon.habits === "number") {
      c(`Daemon has ${daemon.habits} habits indexed`, daemon.habits >= 5);
    }
    if (daemon.version) {
      c(`Daemon version matches CLI`, daemon.version === VERSION,
        `daemon=${daemon.version} cli=${VERSION}`);
    }
  } else {
    c("Daemon reachable", false, `${daemon.error || "unreachable"}`);
    warn("Start daemon: `sudo systemctl start agent-enforcer` (root) or `ack configure --yes` (user)");
  }

  // Check all endpoints
  const { results: endpoints } = await checkAllSockets();
  const aliveCount = Object.values(endpoints).filter(e => e.alive).length;
  if (aliveCount > 0) {
    check(true, `${aliveCount}/${Object.keys(endpoints).length} endpoints alive`);
  } else {
    const anyConfigured = Object.values(endpoints).filter(e => e.checked).length;
    if (anyConfigured > 0) {
      c("Any endpoint alive", false, "No running daemon found on any socket path");
    }
  }

  // Section 3b: Stale Resources (read-only report — repair cleans these)
  section("Stale Resources (cleanup guard)");
  const staleDaemons = findEnforcerDaemons();
  if (staleDaemons.length === 0) {
    check(true, "No orphaned enforcer daemons");
  } else {
    let orphans = 0;
    for (const d of staleDaemons) {
      if (d.orphan) {
        orphans++;
        warn(`Orphan daemon pid ${d.pid}`, `workspace gone: ${d.workspace || "(none)"} — run 'ack repair daemon' to clean`);
      }
    }
    const live = staleDaemons.length - orphans;
    c(`Enforcer daemons running`, live >= 1, `${live} live, ${orphans} orphaned`);
  }
  const deadSocks = findDeadSockets();
  if (deadSocks.length === 0) {
    check("No dead socket files", true);
  } else {
    c("Dead socket files present", false, `${deadSocks.length} — run 'ack repair daemon' to remove`);
    for (const s of deadSocks) warn(`  stale socket: ${s}`);
  }

  // Section 4: Ack Log
  section("Ack Log");
  c("Ack log exists", fs.existsSync(ackLogPath), ackLogPath);
  if (fs.existsSync(ackLogPath)) {
    try {
      const lines = fs.readFileSync(ackLogPath, "utf8").split("\n").filter(Boolean);
      c("Ack log has entries", lines.length > 0, `${lines.length} entries`);
      // Check last entry is valid JSON
      if (lines.length > 0) {
        try {
          JSON.parse(lines[lines.length - 1]);
          check(true, "Last ack log entry valid JSON");
        } catch {
          check(false, "Last ack log entry valid JSON");
        }
      }
    } catch (e) {
      check(false, `Read ack log — ${e.message}`);
    }
  }

  // Section 5: Monitor & Watchdog
  section("Monitor & Watchdog");
  const monitorPidFile = path.join(ws, ".agent", "ack-monitor.pid");
  const watchdogPidFile = path.join(ws, ".agent", "ack-watchdog.pid");

  if (fs.existsSync(monitorPidFile)) {
    const pid = parseInt(fs.readFileSync(monitorPidFile, "utf8").trim());
    try {
      process.kill(pid, 0);
      c("Ack monitor alive", true, `pid ${pid}`);
    } catch {
      c("Ack monitor alive", false, `pid ${pid} not running`);
    }
  } else {
    warn("No monitor pidfile (user-mode may use different tracking)");
  }

  if (fs.existsSync(watchdogPidFile)) {
    const pid = parseInt(fs.readFileSync(watchdogPidFile, "utf8").trim());
    try {
      process.kill(pid, 0);
      c("Watchdog alive", true, `pid ${pid}`);
    } catch {
      c("Watchdog alive", false, `pid ${pid} not running`);
    }
  } else {
    warn("No watchdog pidfile (user-mode may use different tracking)");
  }

  // Section 6: Config Resolution Chain
  section("Config Resolution Chain");
  console.log("  AGENT_WORKSPACE  →", ws);
  console.log("  ENFORCER_SOCKET  →", sock);
  console.log("  ACK_ACK_LOG      →", ackLogPath);
  console.log("  habits dir       →", habitsDir);
  console.log("  constitution     →", constitution);

  // Summary
  const pct = total > 0 ? Math.round((passed / total) * 100) : 0;
  console.log("\n==========================================");
  console.log(`   ${passed}/${total} checks passed (${pct}%)`);
  if (pct < 100) {
    console.log("   Run `ack repair` to auto-fix what can be fixed.");
    console.log("   Run `ack doctor 2>&1 | grep -E \"FAIL|WARN\"` to see only issues.");
  } else {
    console.log("   All systems nominal.");
  }
  console.log("==========================================\n");
}

// ═══════════════════════════════════════════════════════════════════════════════
//  Repair — fix problems (no dry-run gate)
// ═══════════════════════════════════════════════════════════════════════════════

async function runRepair(targets, opts) {
  const ws = resolveWorkspace();
  const habitsDir = path.join(ws, ".agent", "habits");
  const constitution = path.join(ws, ".agent", "constitution.yaml");
  const sock = resolveSocket();

  // Normalise targets — if none specified, fix everything
  if (!targets || targets.length === 0) {
    targets = ["workspace", "habits", "constitution", "daemon"];
  }

  console.log("\n=== ACK Repair ===\n");
  let fixed = 0;

  for (const target of targets) {
    switch (target) {

      case "workspace": {
        console.log(`  Target: workspace`);
        if (!fs.existsSync(ws)) {
          fs.mkdirSync(path.join(ws, ".agent", "habits"), { recursive: true });
          fs.mkdirSync(path.join(ws, ".agent"), { recursive: true });
          console.log("    ✓ Created workspace directories");
          fixed++;
        } else {
          console.log("    ~ Workspace already exists");
        }
        if (!fs.existsSync(habitsDir)) {
          fs.mkdirSync(habitsDir, { recursive: true });
          console.log("    ✓ Created habits directory");
          fixed++;
        } else {
          console.log("    ~ Habits directory already exists");
        }
        // Create .agent meta-dir if missing
        const agentDir = path.join(ws, ".agent");
        if (!fs.existsSync(agentDir)) {
          fs.mkdirSync(agentDir, { recursive: true });
          console.log("    ✓ Created .agent directory");
          fixed++;
        }
        break;
      }

      case "habits": {
        console.log(`  Target: habits`);
        const srcHabits = path.join(REPO_ROOT, "python", "example_workspace", ".agent", "habits");
        if (!fs.existsSync(srcHabits)) {
          console.log("    ✗ Cannot re-seed — source habits not found at", srcHabits);
          break;
        }
        if (opts.reinstall) {
          const srcFiles = fs.readdirSync(srcHabits).filter(f => f.endsWith(".yaml"));
          const willOverwrite = srcFiles.filter(f => fs.existsSync(path.join(habitsDir, f)));
          if (willOverwrite.length > 0 && !opts.yes) {
            console.log(`    ⚠ --reinstall will OVERWRITE ${willOverwrite.length} existing habit file(s),`);
            console.log(`      discarding any local edits to them:`);
            for (const f of willOverwrite) console.log(`        - ${f}`);
            const answer = (await ask("    Proceed? [y/N] ")).trim().toLowerCase();
            if (answer !== "y" && answer !== "yes") {
              console.log("    ✗ Skipped -- habits left untouched. Re-run with --yes to skip this prompt.");
              break;
            }
          }
          let copied = 0;
          for (const f of srcFiles) {
            fs.copyFileSync(path.join(srcHabits, f), path.join(habitsDir, f));
            copied++;
          }
          console.log(`    ✓ Re-seeded ${copied} habit files`);
          fixed++;
        } else {
          // Only seed missing
          fs.mkdirSync(habitsDir, { recursive: true });
          let seeded = 0;
          for (const f of fs.readdirSync(srcHabits)) {
            if (f.endsWith(".yaml") && !fs.existsSync(path.join(habitsDir, f))) {
              fs.copyFileSync(path.join(srcHabits, f), path.join(habitsDir, f));
              seeded++;
            }
          }
          if (seeded > 0) {
            console.log(`    ✓ Seeded ${seeded} missing habit files`);
            fixed++;
          } else {
            console.log(`    ~ All habits already present`);
          }
        }
        break;
      }

      case "constitution": {
        console.log(`  Target: constitution`);
        if (!fs.existsSync(constitution)) {
          fs.mkdirSync(path.join(ws, ".agent"), { recursive: true });
          fs.writeFileSync(constitution, [
            "# Agent Character Kit — constitution (hard constraints).",
            "# The daemon embeds safe defaults; this file OVERRIDES/extends them.",
            "hard_constraints:",
            "  - no_credential_leak: block any tool call that would expose a secret",
            "  - no_destructive_without_confirm: block rm -rf /, mkfs, dd on disks, etc. unless confirmed",
          ].join("\n") + "\n");
          console.log("    ✓ Created default constitution.yaml");
          fixed++;
        } else {
          console.log("    ~ Constitution already exists");
        }
        break;
      }

      case "daemon": {
        console.log(`  Target: daemon`);

        // ── cleanup guard: kill orphaned daemons + remove dead sockets ──
        const cleanup = cleanupStaleResources();
        if (cleanup.killed > 0) {
          console.log(`    ✓ Killed ${cleanup.killed} orphaned daemon(s) (workspace no longer exists)`);
          fixed++;
        }
        if (cleanup.removedSockets > 0) {
          console.log(`    ✓ Removed ${cleanup.removedSockets} dead socket file(s)`);
          fixed++;
        }
        if (cleanup.killed === 0 && cleanup.removedSockets === 0) {
          console.log(`    ~ No stale daemons or sockets to clean`);
        }

        // ── auto-activate: revive the daemon for an active workspace ──
        // Check EVERY known socket location first (root-mode, service-user
        // mode, this workspace, env override) -- not just this workspace's
        // own. Found live, 2026-08-07: checking only `sock` meant `ack
        // repair` couldn't see a perfectly healthy root-mode daemon and
        // auto-started a second, unsupervised user-mode one right next to
        // it -- pure resource duplication, not intended behavior.
        const { results: allSockets } = await checkAllSockets();
        const liveElsewhere = Object.entries(allSockets).find(([, s]) => s.alive);
        if (liveElsewhere) {
          console.log(`    ~ Already served by ${liveElsewhere[0]} (${liveElsewhere[1].path}) -- not starting another`);
          break;
        }
        const wsActive = isWorkspaceActive(ws);
        if (wsActive) {
          const pid = reviveDaemon(ws);
          // give it a moment, then verify
          await new Promise(r => setTimeout(r, 800));
          const revived = await checkDaemon(sock);
          if (revived.alive) {
            console.log(`    ✓ Auto-activated daemon (pid ${pid}) for active workspace ${ws}`);
            fixed++;
          } else {
            console.log(`    ⚠ Revived daemon (pid ${pid}) but socket not yet ready — check 'ack doctor'`);
          }
          break;
        }
        // not active and not running: point the user at install
        if (sock.startsWith("tcp://")) {
          console.log("    ~ TCP transport — start daemon manually: `ack daemon start`");
        } else {
          console.log("    ~ No active workspace. Deploy with:");
          console.log("        sudo systemctl start agent-enforcer           (root)");
          console.log("        ack configure --yes                           (user)");
        }
        break;
      }

      default:
        console.log(`  ? Unknown target: ${target} (use: workspace, habits, constitution, daemon, all)`);
    }
  }

  console.log(`\n  Repairs applied: ${fixed}`);
  if (fixed === 0) {
    console.log("  Nothing needed fixing. Run `ack doctor` for a full health check.");
  }
  console.log("");
}

// ═══════════════════════════════════════════════════════════════════════════════
//  CLI definition
// ═══════════════════════════════════════════════════════════════════════════════

const program = new Command()
  .name("ack")
  .description("Agent Character Kit — character enforcement for any agent")
  .version(VERSION)
  .configureHelp({
    sortSubcommands: true,
    subcommandTerm: (cmd) => {
      const desc = cmd.description().split(" — ")[0];
      const args = cmd.registeredArguments.map(a => a.name()).join(" ");
      return cmd.name() + (args ? ` ${args}` : "") + (desc ? `  ${desc}` : "");
    },
    // subcommandTerm above already bakes the description into the term
    // column -- without this, commander's default formatter ALSO prints
    // cmd.description() in its own separate column, so every command line
    // showed its description twice ("Manage agent configuration [Config]
    // Manage agent configuration [Config]"). Found live: drdeek ran bare
    // `ack` and the doubled, garbled output read as "nothing populates."
    subcommandDescription: () => "",
    helpWidth: 100,
  });

function addHelpCategory(cmd, category) {
  // Append category tag to description for semantic grouping in help
  cmd.description(cmd.description() + ` [${category}]`);
}

// ─── Core commands ─────────────────────────────────────────────────────────

program
  .command("hook")
  .description("Gate a tool call via stdin, or print wiring config with --config [Core]")
  .argument("<framework>", "Framework: claude | cursor | gemini | opencode | hermes | generic")
  .option("--hook-command <cmd>", "Custom hook command", `node '${SELF}' hook`)
  .option("--config", "Print the hook wiring config instead of gating a call")
  .action(async (framework, opts) => {
    if (opts.config) {
      const config = generateConfig(framework, opts.hookCommand);
      console.log(JSON.stringify(config, null, 2));
      return;
    }

    // Real gate: this is what the harness actually invokes on every tool
    // call, piping the tool-call payload as JSON on stdin. No stdin (e.g.
    // a human running `ack hook claude` manually) falls back to printing
    // the wiring config, so the command stays useful without --config too.
    let input = "";
    if (!process.stdin.isTTY) {
      input = await new Promise((resolve) => {
        let data = "";
        process.stdin.on("data", (chunk) => (data += chunk));
        process.stdin.on("end", () => resolve(data));
      });
    }
    if (!input.trim()) {
      const config = generateConfig(framework, opts.hookCommand);
      console.log(JSON.stringify(config, null, 2));
      return;
    }

    const payload = JSON.parse(input);
    // UserPromptSubmit (Claude) / an explicit pre_llm_call-shaped payload ->
    // the injection channel, not the gate. Everything else is a tool-call
    // gate check.
    const isPromptSubmit = payload.hook_event_name === "UserPromptSubmit";
    const result = isPromptSubmit
      ? await processPromptSubmit(payload, { framework })
      : await processToolCall(payload, { framework });
    console.log(JSON.stringify(result.output));
    process.exit(result.exitCode);
  });

program
  .command("configure")
  .alias("install") // backward-compat: v1.2.1 and earlier called this "install"
  .description("Set up daemon + monitor + watchdog + companion [Core]")
  .option("--yes", "Non-interactive, sensible defaults")
  .option("--all", "Everything: root mode + all components + Python bindings, for every detected harness (or just --harness if that's also given)")
  .option("--user", "User-mode (default)")
  .option("--root", "Root mode (systemd)")
  .option("--service-user <name>", "Root-equivalent boundary via a dedicated non-root service user (implies --root); default name if given no value elsewhere: ack-enforcer")
  .option("--workspace <path>", "Workspace path (default: ~/.agent-character-kit/workspace)")
  .option("--socket <mode>", "Socket: unix | tcp (default: unix)")
  .option("--harness <name>", "Harness for hook/companion config: claude | cursor | gemini | opencode | hermes | generic. Only claude/hermes/opencode are auto-detected and get real auto-naming (node/src/agent-identity.js) -- cursor/gemini get hook generation but must be named explicitly here every time, and always fall back to the harness-agnostic 'generic' agent name.")
  .option("--python", "Also install Python ACK bindings (auto with --all)")
  .option("--no-python", "Skip Python ACK bindings")
  .option("--vectors", "Also install the optional 'vectors' extra (numpy + sentence-transformers, semantic search) -- needs --python, root auto-runs pip")
  .option("--no-monitor", "Skip acknowledgment monitor")
  .option("--no-watchdog", "Skip monitor watchdog")
  .option("--no-companion", "Skip companion hook config")
  .option("--hook-command <cmd>", "Custom hook command for the generated companion config")
  .option("--start", "Launch the daemon/monitor/watchdog now (default)")
  .option("--no-start", "Only write config/env files; start everything yourself later")
  .option("--claude-config", "Write the PreToolUse+UserPromptSubmit hooks into ~/.claude/settings.json (default with --harness claude)")
  .option("--no-claude-config", "Print the Claude hook config but don't write it into settings.json")
  .option("--create-habit", "Create a habit non-interactively (needs --habit-name/--habit-prompt/--habit-logic)")
  .option("--habit-name <name>", "Habit name, with --create-habit")
  .option("--habit-prompt <text>", "Habit prompt, with --create-habit")
  .option("--habit-logic <text>", "Habit logic, with --create-habit")
  .action(async (opts) => {
    const { main } = await import("./install.js");
    // Reconstruct raw --flag argv from commander's parsed opts and hand it
    // to install.js's OWN parseArgs (via main() with no argument) rather
    // than passing the commander opts object directly. Commander's
    // camelCase auto-naming doesn't always match the property names
    // install.js's internals expect (e.g. --claude-config -> opts.claudeConfig
    // via commander's convention, but install.js reads opts.writeClaudeConfig) —
    // routing everything through install.js's single parseArgs keeps flag
    // semantics defined in exactly one place instead of two that can drift.
    const kebab = (k) => k.replace(/([A-Z])/g, "-$1").toLowerCase();
    // Options declared ONLY as --no-X (no positive counterpart in
    // parseArgs): only ever emit the negative form, and only when the user
    // actually passed it (v === false). Emitting a bare --monitor etc. would
    // be an unrecognized flag to parseArgs (it only checks for --no-monitor).
    const negationOnly = new Set(["monitor", "watchdog", "companion"]);
    const flags = [];
    for (const [k, v] of Object.entries(opts)) {
      if (k === "python") continue; // handled separately below
      if (v === undefined || v === null) continue;
      if (typeof v === "boolean") {
        if (negationOnly.has(k)) {
          if (v === false) flags.push(`--no-${kebab(k)}`);
          continue;
        }
        flags.push(v ? `--${kebab(k)}` : `--no-${kebab(k)}`);
        continue;
      }
      flags.push(`--${kebab(k)}`, String(v));
    }
    if (opts.python === true) flags.push("--python");
    else if (opts.python === false) flags.push("--no-python");
    // Bug fix: this used to force-append "--yes" unconditionally here,
    // which meant `ack configure` (run with a real TTY, capable of a true
    // interactive wizard) could never actually reach install.js's
    // interactive branch -- every invocation silently ran non-interactive
    // regardless of whether --yes was passed. `flags` already contains
    // "--yes" when opts.yes is true; nothing further to add.
    process.argv = ["node", "install.js", ...flags];
    await main();
  });

program
  .command("manage")
  .description("Interactive menu: view/change every registered agent's config, habits, and daemon [Core]")
  .action(async () => {
    await runManage();
  });

// ─── Configuration ─────────────────────────────────────────────────────────

const configCmd = program
  .command("config")
  .description("Manage agent configuration [Config]");

configCmd
  .command("show")
  .description("Show resolved configuration paths")
  .option("--agent <name>", "Show a specific registered agent's config instead of the default single workspace")
  .action((opts) => {
    if (opts.agent) {
      const agent = resolveAgentByName(opts.agent);
      if (!agent) {
        console.error(`No registered agent named '${opts.agent}'. Run 'ack config show' with no --agent to see the registry.`);
        process.exit(1);
      }
      console.log(`Agent: ${opts.agent}`);
      console.log("AGENT_WORKSPACE:", agent.ws);
      console.log("ENFORCER_SOCKET:", agent.sock);
      console.log("ACK_ACK_LOG:", agent.ackLog);
      return;
    }
    console.log("AGENT_WORKSPACE:", resolveWorkspace());
    console.log("ENFORCER_SOCKET:", resolveSocket());
    console.log("ACK_ACK_LOG:", resolveAckLog());
    console.log("");
    console.log("Environment (where set):");
    for (const key of ["AGENT_WORKSPACE", "ENFORCER_SOCKET", "ACK_ACK_LOG", "ACK_HABITS_DIR"]) {
      console.log(`  ${key}: ${process.env[key] || "(unset — using default)"}`);
    }
    const { registryPath, agents } = readWorkspacesRegistry();
    if (registryPath) {
      console.log("");
      console.log(`Registered agents (${agents.length}, registry: ${registryPath}):`);
      for (const ws of agents) {
        console.log(`  ${path.basename(ws)}  ->  ${ws}`);
      }
      console.log("Use --agent <name> to show that agent's resolved paths specifically.");
    }
  });

configCmd
  .command("verify")
  .description("Verify all paths exist and daemon is reachable")
  .option("--agent <name>", "Verify a specific registered agent instead of every registered agent (or the default single workspace, if none are registered)")
  .action(async (opts) => {
    if (opts.agent) {
      const agent = resolveAgentByName(opts.agent);
      if (!agent) {
        console.error(`No registered agent named '${opts.agent}'.`);
        process.exit(1);
      }
      await verifyAgentReport(agent.ws, agent.sock, agent.ackLog, null);
      return;
    }

    const { registryPath, agents } = readWorkspacesRegistry();
    if (registryPath && agents.length) {
      for (const ws of agents) {
        const name = path.basename(ws);
        await verifyAgentReport(ws, path.join(ws, ".agent", `${name}.sock`), path.join(ws, ".agent", "ack.jsonl"), `agent: ${name}`);
      }
      return;
    }
    // No registry -- original single-workspace behavior, unchanged.
    await verifyAgentReport(resolveWorkspace(), resolveSocket(), resolveAckLog(), null);
  });

configCmd
  .command("set")
  .description("Print export command for a config key")
  .argument("<key>", "Config key (workspace|socket|ack-log)")
  .argument("<value>", "Value to set")
  .action((key, value) => {
    const envMap = {
      workspace: "AGENT_WORKSPACE",
      socket: "ENFORCER_SOCKET",
      "ack-log": "ACK_ACK_LOG",
    };
    const envKey = envMap[key];
    if (!envKey) {
      console.error(`Unknown key: ${key} (use: workspace, socket, ack-log)`);
      process.exit(1);
    }
    console.log(`export ${envKey}=${value}`);
    console.log(`Add the above to your shell profile or .env file.`);
  });

configCmd
  .command("write-env")
  .description("Write resolved .env to file")
  .argument("[file]", "Output file path (default: workspace/.env)")
  .option("--agent <name>", "Write a specific registered agent's .env instead of the default single workspace")
  .action((file, opts) => {
    let ws, sock, ackLogPath;
    if (opts.agent) {
      const agent = resolveAgentByName(opts.agent);
      if (!agent) {
        console.error(`No registered agent named '${opts.agent}'.`);
        process.exit(1);
      }
      ({ ws, sock, ackLog: ackLogPath } = agent);
    } else {
      ws = resolveWorkspace();
      sock = resolveSocket();
      ackLogPath = resolveAckLog();
    }
    const target = file ? path.resolve(file) : path.join(ws, ".env");
    const lines = [
      `AGENT_WORKSPACE=${ws}`,
      `ENFORCER_SOCKET=${sock}`,
      `ACK_ACK_LOG=${ackLogPath}`,
    ];
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, lines.join("\n") + "\n");
    console.log("Wrote .env to:", target);
  });

// ─── Diagnostics & Repair ──────────────────────────────────────────────────

program
  .command("status")
  .description("Quick daemon health overview [Diag]")
  .option("--json", "Output JSON")
  .action(async (opts) => {
    const { results, registryPath } = await checkAllSockets();
    if (opts.json) {
      console.log(JSON.stringify({ results, registryPath }, null, 2));
      return;
    }
    console.log("=== Socket Status ===");
    if (registryPath) {
      const agentCount = Object.keys(results).filter((n) => n.startsWith("agent: ")).length;
      console.log(`  (${agentCount} registered agent(s), registry: ${registryPath})`);
    }
    for (const [name, info] of Object.entries(results)) {
      if (!info.checked) {
        console.log(`  ${name}: — not configured`);
        continue;
      }
      const state = info.alive ? "🟢 ALIVE" : "🔴 DEAD";
      console.log(`  ${name}: ${state}`);
      console.log(`    path: ${info.path}`);
      if (info.error) console.log(`    error: ${info.error}`);
      if (info.workspace) console.log(`    workspace: ${info.workspace}`);
    }
    // postinstall.js already prints this same pointer for anyone who ran a
    // plain `npm install -g` (its stdout write goes straight to /dev/tty,
    // bypassing npm's own unreliable lifecycle-script stdout capture -- see
    // its own comments). This is the fallback for the two cases that
    // misses: --ignore-scripts / an allow-scripts policy that denied it, or
    // no controlling terminal at install time (piped/CI). Not the primary
    // discovery path either now that install.sh exists -- that one hands
    // off straight into this same wizard with its own real TTY.
    if (Object.values(results).every((r) => !r.checked || !r.alive) && looksNeverConfigured()) {
      console.log(`\n${FIRST_RUN_NUDGE}`);
    }
  });

program
  .command("doctor")
  .description("Full structured diagnostic report (read-only) [Diag]")
  .action(runDoctor);

program
  .command("repair")
  .description("Auto-fix problems (workspace, habits, constitution, daemon) [Diag]")
  .argument("[targets...]", "What to fix: workspace, habits, constitution, daemon (omit for all)")
  .option("--reinstall", "Re-seed habits from bundled set -- DESTRUCTIVE: overwrites existing habit files, discarding local edits. Prompts for confirmation naming each file that will be clobbered unless --yes is also given.")
  .option("--yes", "Skip the --reinstall confirmation prompt (for scripted/non-interactive use)")
  .action(runRepair);

// ─── Habit management ──────────────────────────────────────────────────────

const habitCmd = program
  .command("habit")
  .description("Manage enforcement habits [Habits]");

// Shared by `ack habit create` and `ack manage`'s per-agent habit-create
// action. MOD-009: every field is asked, none hardcoded/defaulted -- an
// empty answer is rejected with a reprompt, flag or interactive, same rule
// either way (FEAT-004). YAML text comes from the shared builder
// (node/src/habits/build.js) -- this was the third of three independent,
// near-identical implementations before being collapsed into one.
// nameFlag/opts are optional (undefined -> always prompted); used for the
// CLI's positional <name> + flag options, absent in the manage-menu caller.
async function createHabitInteractive(ws, nameFlag, opts = {}) {
  const habitsDir = path.join(ws, ".agent", "habits");
  fs.mkdirSync(habitsDir, { recursive: true });

  const askRequired = async (flagVal, question) => {
    let v = flagVal;
    while (!v || !v.trim()) {
      if (v !== undefined && !v.trim()) console.error("This can't be empty.");
      v = await ask(question);
    }
    return v.trim();
  };

  const askLevel = async (flagVal) => {
    let v = flagVal;
    while (!v || !VALID_LEVELS.includes(v.trim().toLowerCase())) {
      if (v !== undefined) console.error(`Invalid level "${v}" -- must be one of: ${VALID_LEVELS.join(", ")}`);
      v = await ask(`Enforcement level (${VALID_LEVELS.join("/")}): `);
    }
    return v.trim().toLowerCase();
  };

  let fileName, file;
  while (true) {
    const name = await askRequired(nameFlag, "Habit name (kebab-case): ");
    fileName = normalizeHabitName(name);
    file = path.join(habitsDir, `${fileName}.yaml`);
    if (!fs.existsSync(file)) break;
    console.error("Habit already exists:", file);
    if (nameFlag) process.exit(1); // non-interactive caller passed a fixed name -- can't reprompt around it
    nameFlag = undefined;
  }

  const prompt = await askRequired(opts.prompt, "Prompt (self-question): ");
  const logic = await askRequired(opts.logic, "Logic (why this governs your actions): ");
  const evidence = await askRequired(opts.evidence, "Evidence (how to verify this specific habit was actually applied): ");
  const level = await askLevel(opts.level);

  const yaml = buildHabitYaml({ name: fileName, prompt, logic, evidence, level });
  fs.writeFileSync(file, yaml);
  console.log("Created:", file);
  return file;
}

// Shared by `ack habit list` and `ack manage`'s per-agent status/habits
// view. Returns the parsed {name, prompt, file} rows (empty array if none)
// instead of only printing, so callers can also just count them.
function listHabitsForWorkspace(ws, { print = true } = {}) {
  const habitsDir = path.join(ws, ".agent", "habits");
  if (!fs.existsSync(habitsDir)) {
    if (print) console.log("No habits directory at", habitsDir);
    return [];
  }
  const files = fs.readdirSync(habitsDir).filter(f => f.endsWith(".yaml"));
  if (files.length === 0) {
    if (print) console.log("No habit files found in", habitsDir);
    return [];
  }
  const rows = files.map((f) => {
    const content = fs.readFileSync(path.join(habitsDir, f), "utf8");
    // Quote is OPTIONAL -- YAML allows unquoted plain scalars for both
    // fields, and roughly half the bundled habits actually use that form.
    // A quote-required regex silently showed "(no prompt)" for them.
    const nameMatch = content.match(/^name:\s*"?([^"\n]*)/m);
    const promptMatch = content.match(/^prompt:\s*"?([^"\n]*)/m);
    return { name: nameMatch?.[1]?.trim() || f, prompt: promptMatch?.[1]?.trim() || "(no prompt)", file: f };
  });
  if (print) {
    for (const r of rows) console.log(`  ${r.name}: ${r.prompt}`);
  }
  return rows;
}

habitCmd
  .command("create")
  .description("Create a new habit YAML file")
  .argument("<name>", "Habit name (kebab-case, becomes filename)")
  .option("-p, --prompt <text>", "Self-question prompt")
  .option("-l, --logic <text>", "Reasoning / logic behind the habit")
  .option("-e, --evidence <text>", "How to verify the habit was actually applied, specific to this habit")
  .option("--level <level>", "Enforcement level: reminder | should | must | hard")
  .action(async (name, opts) => {
    if (!name || !name.trim()) {
      console.error("Habit name is required");
      process.exit(1);
    }
    await createHabitInteractive(resolveWorkspace(), name, opts);
  });

habitCmd
  .command("list")
  .description("List all habits with prompts")
  .action(() => {
    listHabitsForWorkspace(resolveWorkspace());
  });

habitCmd
  .command("delete")
  .description("Delete a habit YAML file")
  .argument("<name>", "Habit name (as shown by `ack habit list`, or the filename)")
  .option("-y, --yes", "Skip confirmation prompt")
  .action(async (name, opts) => {
    const ws = resolveWorkspace();
    const habitsDir = path.join(ws, ".agent", "habits");
    const fileName = normalizeHabitName(name);
    const file = path.join(habitsDir, `${fileName}.yaml`);
    if (!fs.existsSync(file)) {
      console.error("No such habit:", file);
      process.exit(1);
    }
    if (!opts.yes) {
      const confirmed = (await ask(`Delete ${file}? [y/N] `)).trim().toLowerCase();
      if (confirmed !== "y" && confirmed !== "yes") {
        console.log("Cancelled.");
        return;
      }
    }
    fs.unlinkSync(file);
    console.log("Deleted:", file);
  });

// ─── Custom help text ──────────────────────────────────────────────────────

program.addHelpText("after", `
Category summary:
  [Core]     hook, configure, manage
  [Config]   config show, config verify, config set, config write-env
  [Diag]     status, doctor, repair (doctor reports + repair cleans stale daemons/sockets, auto-activates)
  [Habits]   habit create, habit list, habit delete

Examples:
  ack configure --yes                        quick user-mode setup
  ack configure --all                        root-mode setup + Python bindings
  ack manage                                 interactive menu: view/edit every agent
  ack doctor                                 full diagnostic report
  ack repair                                 auto-fix workspace/habits/daemon
  ack habit create verify-workspace          create a new habit
  ack hook claude                            generate Claude companion config
  ack config show                            resolved config paths
`);

// ═══════════════════════════════════════════════════════════════════════════════
//  Parse & run
// ═══════════════════════════════════════════════════════════════════════════════

program.parse();

// ═══════════════════════════════════════════════════════════════════════════════
//  CLI helpers
// ═══════════════════════════════════════════════════════════════════════════════

// Line-buffered stdin reader. The original version resolved on a single raw
// "data" event and .trim()'d the whole chunk -- fine for the one-shot habit
// prompts this was written for, but silently wrong the moment more than one
// answer arrives in the same chunk (piped/scripted stdin, or just fast
// typing/paste over a laggy SSH session): "1\n1\nb\nq\n" became one garbage
// answer instead of four real ones. `ack manage`'s menu loop asks many
// sequential questions per session, so this now actually queues complete
// lines and hands them out one at a time, same semantics a real
// line-oriented readline would give.
const _askQueue = [];
let _askWaiter = null;
let _askListenerInstalled = false;

function _installAskListener() {
  if (_askListenerInstalled) return;
  _askListenerInstalled = true;
  let leftover = "";
  const flushWaiter = () => {
    if (!_askWaiter) return;
    const w = _askWaiter;
    _askWaiter = null;
    w();
  };
  process.stdin.on("data", (d) => {
    leftover += d.toString();
    let idx;
    while ((idx = leftover.indexOf("\n")) !== -1) {
      _askQueue.push(leftover.slice(0, idx).replace(/\r$/, ""));
      leftover = leftover.slice(idx + 1);
    }
    flushWaiter();
  });
  process.stdin.on("end", () => {
    if (leftover) { _askQueue.push(leftover); leftover = ""; }
    // Stdin is gone -- resolve any pending ask() with "" rather than hang
    // forever (each caller's parser treats blank as a safe default: quit
    // the top menu, back-out of a submenu, cancel a delete confirmation).
    if (_askWaiter) { _askQueue.push(""); flushWaiter(); }
  });
}

function ask(q) {
  if (q) process.stdout.write(q);
  _installAskListener();
  return new Promise((resolve) => {
    const attempt = () => {
      if (_askQueue.length > 0) resolve(_askQueue.shift().trim());
      else _askWaiter = attempt;
    };
    attempt();
  });
}
