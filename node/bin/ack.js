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
import { generateConfig } from "../src/index.js";
import { EnforcerClient } from "../src/enforcer/client.js";
import fs from "fs";
import os from "os";
import path from "path";
import { spawn } from "child_process";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..");

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

async function checkAllSockets() {
  const results = {};
  const candidates = [
    { name: "root (systemd)", path: "/run/agent-enforcer/main.sock" },
    { name: "user workspace", path: path.join(resolveWorkspace(), ".agent", "enforcer.sock") },
    { name: "env ENFORCER_SOCKET", path: resolveSocket() },
  ];
  for (const c of candidates) {
    if (!c.path) {
      results[c.name] = { checked: false, reason: "not configured" };
      continue;
    }
    const r = await checkDaemon(c.path);
    results[c.name] = { path: c.path, checked: true, ...r };
  }
  return results;
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
        const hasName = /name:\s*"/.test(content);
        const hasPrompt = /prompt:\s*"/.test(content);
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
    if (daemon.habits && Array.isArray(daemon.habits)) {
      c(`Daemon has ${daemon.habits.length} habits indexed`, daemon.habits.length >= 5);
    }
    if (daemon.version) {
      c(`Daemon version matches CLI`, daemon.version === "1.0.5",
        `daemon=${daemon.version} cli=1.0.5`);
    }
  } else {
    c("Daemon reachable", false, `${daemon.error || "unreachable"}`);
    warn("Start daemon: `sudo systemctl start agent-enforcer` (root) or `ack install --yes` (user)");
  }

  // Check all endpoints
  const endpoints = await checkAllSockets();
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
          // Overwrite all
          let copied = 0;
          for (const f of fs.readdirSync(srcHabits)) {
            if (f.endsWith(".yaml")) {
              const dest = path.join(habitsDir, f);
              fs.copyFileSync(path.join(srcHabits, f), dest);
              copied++;
            }
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
        const daemonStatus = await checkDaemon(sock);
        if (daemonStatus.alive) {
          console.log("    ~ Daemon already running");
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
          console.log("        ack install --yes                             (user)");
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
  .version("1.0.5")
  .configureHelp({
    sortSubcommands: true,
    subcommandTerm: (cmd) => {
      const desc = cmd.description().split(" — ")[0];
      const args = cmd.registeredArguments.map(a => a.name()).join(" ");
      return cmd.name() + (args ? ` ${args}` : "") + (desc ? `  ${desc}` : "");
    },
    helpWidth: 100,
  });

function addHelpCategory(cmd, category) {
  // Append category tag to description for semantic grouping in help
  cmd.description(cmd.description() + ` [${category}]`);
}

// ─── Core commands ─────────────────────────────────────────────────────────

program
  .command("hook")
  .description("Generate hook config for your agent framework [Core]")
  .argument("<framework>", "Framework: claude | cursor | gemini | opencode | hermes | generic")
  .option("--hook-command <cmd>", "Custom hook command", "npx ack hook")
  .action((framework, opts) => {
    const config = generateConfig(framework, opts.hookCommand);
    console.log(JSON.stringify(config, null, 2));
  });

program
  .command("install")
  .description("Deploy daemon + monitor + watchdog + companion [Core]")
  .option("--yes", "Non-interactive, sensible defaults")
  .option("--all", "Everything: root mode + all components + Python bindings")
  .option("--user", "User-mode (default)")
  .option("--root", "Root mode (systemd)")
  .option("--workspace <path>", "Workspace path (default: ~/.agent-character-kit/workspace)")
  .option("--socket <mode>", "Socket: unix | tcp (default: unix)")
  .option("--harness <name>", "Harness: claude | cursor | gemini | opencode | hermes | generic")
  .option("--python", "Also install Python ACK bindings (auto with --all)")
  .option("--no-python", "Skip Python ACK bindings")
  .option("--no-monitor", "Skip acknowledgment monitor")
  .option("--no-watchdog", "Skip monitor watchdog")
  .option("--no-companion", "Skip companion hook config")
  .action(async (opts) => {
    const { main } = await import("./install.js");
    const flags = Object.entries(opts)
      .filter(([k, v]) => {
        if (k === "python") return false; // handled separately
        return v !== false && v !== true;
      })
      .flatMap(([k, v]) => v === true ? [`--${k}`] : [`--${k}`, String(v)]);
    // Pass --python / --no-python explicitly (boolean flags are filtered above)
    if (opts.python === true) flags.push("--python");
    else if (opts.python === false) flags.push("--no-python");
    process.argv = ["node", "install.js", ...flags, "--yes"];
    await main(opts);
  });

// ─── Configuration ─────────────────────────────────────────────────────────

const configCmd = program
  .command("config")
  .description("Manage agent configuration [Config]");

configCmd
  .command("show")
  .description("Show resolved configuration paths")
  .action(() => {
    console.log("AGENT_WORKSPACE:", resolveWorkspace());
    console.log("ENFORCER_SOCKET:", resolveSocket());
    console.log("ACK_ACK_LOG:", resolveAckLog());
    console.log("");
    console.log("Environment (where set):");
    for (const key of ["AGENT_WORKSPACE", "ENFORCER_SOCKET", "ACK_ACK_LOG", "ACK_HABITS_DIR"]) {
      console.log(`  ${key}: ${process.env[key] || "(unset — using default)"}`);
    }
  });

configCmd
  .command("verify")
  .description("Verify all paths exist and daemon is reachable")
  .action(async () => {
    const ws = resolveWorkspace();
    const habitsDir = path.join(ws, ".agent", "habits");
    const constitution = path.join(ws, ".agent", "constitution.yaml");
    const sock = resolveSocket();
    const ackLogPath = resolveAckLog();

    console.log("Workspace:", ws, fs.existsSync(ws) ? "✓" : "✗");
    console.log("  habits:", fs.existsSync(habitsDir) ? "✓" : "✗");
    console.log("  constitution:", fs.existsSync(constitution) ? "✓" : "✗");
    console.log("Socket:", sock);
    const daemon = await checkDaemon(sock);
    console.log("  daemon:", daemon.alive ? "✓ reachable" : `✗ ${daemon.error || "unreachable"}`);
    console.log("Ack log:", ackLogPath, fs.existsSync(ackLogPath) ? "✓" : "✗");
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
  .action((file) => {
    const target = file
      ? path.resolve(file)
      : path.join(resolveWorkspace(), ".env");
    const lines = [
      `AGENT_WORKSPACE=${resolveWorkspace()}`,
      `ENFORCER_SOCKET=${resolveSocket()}`,
      `ACK_ACK_LOG=${resolveAckLog()}`,
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
    const results = await checkAllSockets();
    if (opts.json) {
      console.log(JSON.stringify(results, null, 2));
      return;
    }
    console.log("=== Socket Status ===");
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
  });

program
  .command("doctor")
  .description("Full structured diagnostic report (read-only) [Diag]")
  .action(runDoctor);

program
  .command("repair")
  .description("Auto-fix problems (workspace, habits, constitution, daemon) [Diag]")
  .argument("[targets...]", "What to fix: workspace, habits, constitution, daemon (omit for all)")
  .option("--reinstall", "Re-seed habits from bundled set (overwrites existing)")
  .action(runRepair);

// ─── Habit management ──────────────────────────────────────────────────────

const habitCmd = program
  .command("habit")
  .description("Manage enforcement habits [Habits]");

habitCmd
  .command("create")
  .description("Create a new habit YAML file")
  .argument("<name>", "Habit name (kebab-case, becomes filename)")
  .option("-p, --prompt <text>", "Self-question prompt")
  .option("-l, --logic <text>", "Reasoning / logic behind the habit")
  .action(async (name, opts) => {
    if (!name || !name.trim()) {
      console.error("Habit name is required");
      process.exit(1);
    }
    const ws = resolveWorkspace();
    const habitsDir = path.join(ws, ".agent", "habits");
    fs.mkdirSync(habitsDir, { recursive: true });
    const fileName = name.replace(/[^a-z0-9]+/gi, "_").toLowerCase().replace(/^_+|_+$/g, "");
    const file = path.join(habitsDir, `${fileName}.yaml`);
    if (fs.existsSync(file)) {
      console.error("Habit already exists:", file);
      process.exit(1);
    }
    const prompt = opts.prompt || await ask("Prompt (self-question): ");
    const logic = opts.logic || await ask("Logic (why this governs your actions): ");
    const yaml = [
      `# Habit: ${fileName}`,
      `# Source question: ${prompt}`,
      `# Logic: ${logic}`,
      `name: "${fileName}"`,
      `prompt: ${JSON.stringify(prompt)}`,
      `enforcement:`,
      `  level: "reminder"`,
      `behavior:`,
      `  kind: "standard"`,
      `  assert: ${JSON.stringify(logic)}`,
      `  evidence: "The agent applies this habit consistently and can state WHY when held."`,
      `  logic: ${JSON.stringify(logic)}`,
      "",
    ].join("\n");
    fs.writeFileSync(file, yaml);
    console.log("Created:", file);
  });

habitCmd
  .command("list")
  .description("List all habits with prompts")
  .action(() => {
    const ws = resolveWorkspace();
    const habitsDir = path.join(ws, ".agent", "habits");
    if (!fs.existsSync(habitsDir)) {
      console.log("No habits directory at", habitsDir);
      return;
    }
    const files = fs.readdirSync(habitsDir).filter(f => f.endsWith(".yaml"));
    if (files.length === 0) {
      console.log("No habit files found in", habitsDir);
      return;
    }
    for (const f of files) {
      const content = fs.readFileSync(path.join(habitsDir, f), "utf8");
      const nameMatch = content.match(/name:\s*"([^"]+)"/);
      const promptMatch = content.match(/prompt:\s*"([^"]+)"/);
      console.log(`  ${nameMatch?.[1] || f}: ${promptMatch?.[1] || "(no prompt)"}`);
    }
  });

// ─── Custom help text ──────────────────────────────────────────────────────

program.addHelpText("after", `
Category summary:
  [Core]     hook, install
  [Config]   config show, config verify, config set, config write-env
  [Diag]     status, doctor, repair (doctor reports + repair cleans stale daemons/sockets, auto-activates)
  [Habits]   habit create, habit list

Examples:
  ack install --yes                          quick user-mode install
  ack install --all                          root-mode install + Python bindings
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

function ask(q) {
  return new Promise(r => {
    process.stdout.write(q);
    process.stdin.once("data", d => r(d.toString().trim()));
  });
}
