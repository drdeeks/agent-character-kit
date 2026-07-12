#!/usr/bin/env node
/**
 * ack — Agent Character Kit CLI
 *
 * Single binary: enforcer daemon + companion hook + config + diagnostics
 */

import { Command } from "commander";
import { processToolCall, generateConfig, EnforcerClient } from "../src/index.js";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..");

// ─── Helpers ─────────────────────────────────────────────────────────────────
function resolveSocket() {
  return process.env.ENFORCER_SOCKET ||
    (process.env.AGENT_WORKSPACE
      ? path.join(process.env.AGENT_WORKSPACE, ".agent", "enforcer.sock")
      : path.join(os.homedir(), ".agent-character-kit", "workspace", ".agent", "enforcer.sock"));
}

function resolveWorkspace() {
  return process.env.AGENT_WORKSPACE ||
    path.join(os.homedir(), ".agent-character-kit", "workspace");
}

function resolveAckLog() {
  return process.env.ACK_ACK_LOG ||
    path.join(resolveWorkspace(), ".agent", "ack.jsonl");
}

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

function printStatus(obj) {
  console.log(JSON.stringify(obj, null, 2));
}

function ask(q) {
  return new Promise(r => {
    process.stdout.write(q);
    process.stdin.once("data", d => r(d.toString().trim()));
  });
}

// ─── Commands ────────────────────────────────────────────────────────────────

const program = new Command()
  .name("ack")
  .description("Agent Character Kit — character enforcement for any agent")
  .version("1.0.0");

// hook — generate hook config for any framework
program
  .command("hook")
  .description("Generate hook configuration for your agent framework")
  .argument("<framework>", "Framework: claude | cursor | gemini | opencode | hermes | generic")
  .option("--hook-command <cmd>", "Custom hook command", "npx ack hook")
  .action((framework, opts) => {
    const config = generateConfig(framework, opts.hookCommand);
    console.log(JSON.stringify(config, null, 2));
  });

// config — workspace / agent paths / verification
program
  .command("config")
  .description("Configure and verify agent workspace / integration paths")
  .option("--workspace <path>", "Set AGENT_WORKSPACE")
  .option("--socket <path>", "Set ENFORCER_SOCKET")
  .option("--ack-log <path>", "Set ACK_ACK_LOG")
  .option("--show", "Show current resolved config")
  .option("--verify", "Verify all paths exist and daemon reachable")
  .option("--write-env [file]", "Write resolved .env to file (default: workspace/.env)")
  .action(async (opts) => {
    if (opts.show || (!opts.workspace && !opts.socket && !opts.ackLog && !opts.verify && !opts.writeEnv)) {
      console.log("=== Resolved Config ===");
      console.log("AGENT_WORKSPACE:", resolveWorkspace());
      console.log("ENFORCER_SOCKET:", resolveSocket());
      console.log("ACK_ACK_LOG:", resolveAckLog());
      console.log("");
      console.log("Env vars (if set):");
      console.log("  ENFORCER_SOCKET:", process.env.ENFORCER_SOCKET || "(unset)");
      console.log("  AGENT_WORKSPACE:", process.env.AGENT_WORKSPACE || "(unset)");
      console.log("  ACK_ACK_LOG:", process.env.ACK_ACK_LOG || "(unset)");
    }
    if (opts.workspace) {
      console.log(`Set AGENT_WORKSPACE=${opts.workspace} in your shell/env`);
    }
    if (opts.socket) {
      console.log(`Set ENFORCER_SOCKET=${opts.socket} in your shell/env`);
    }
    if (opts.ackLog) {
      console.log(`Set ACK_ACK_LOG=${opts.ackLog} in your shell/env`);
    }
    if (opts.verify) {
      console.log("\n=== Verification ===");
      const ws = resolveWorkspace();
      console.log("Workspace exists:", fs.existsSync(ws));
      console.log("  habits dir:", fs.existsSync(path.join(ws, ".agent", "habits")));
      console.log("  constitution:", fs.existsSync(path.join(ws, ".agent", "constitution.yaml")));
      const sock = resolveSocket();
      console.log("Socket path:", sock);
      const daemon = await checkDaemon(sock);
      console.log("Daemon reachable:", daemon.alive, daemon.error ? `(${daemon.error})` : "");
      console.log("Ack log:", resolveAckLog(), fs.existsSync(resolveAckLog()) ? "exists" : "missing");
    }
    if (opts.writeEnv) {
      const target = opts.writeEnv === true
        ? path.join(resolveWorkspace(), ".env")
        : opts.writeEnv;
      const lines = [
        `AGENT_WORKSPACE=${resolveWorkspace()}`,
        `ENFORCER_SOCKET=${resolveSocket()}`,
        `ACK_ACK_LOG=${resolveAckLog()}`,
      ];
      fs.writeFileSync(target, lines.join("\n") + "\n");
      console.log("Wrote .env to:", target);
    }
  });

// status — all sockets + daemon health
program
  .command("status")
  .description("Show all socket endpoints and daemon health")
  .option("--json", "Output JSON")
  .action(async (opts) => {
    const results = await checkAllSockets();
    if (opts.json) {
      printStatus(results);
    } else {
      console.log("=== Socket Status ===");
      for (const [name, info] of Object.entries(results)) {
        if (!info.checked) {
          console.log(`  ${name}: not configured`);
          continue;
        }
        const state = info.alive ? "🟢 ALIVE" : "🔴 DEAD";
        console.log(`  ${name}: ${state}`);
        console.log(`    path: ${info.path}`);
        if (info.error) console.log(`    error: ${info.error}`);
        if (info.workspace) console.log(`    workspace: ${info.workspace}`);
      }
    }
  });

// repair — troubleshoot / auto-fix common issues
program
  .command("repair")
  .description("Diagnose and auto-repair common issues")
  .option("--fix", "Apply fixes (dry-run by default)")
  .option("--reinstall", "Re-seed habits and constitution")
  .action(async (opts) => {
    console.log("=== ACK Repair ===\n");
    const issues = [];
    const fixes = [];

    const ws = resolveWorkspace();
    const habitsDir = path.join(ws, ".agent", "habits");
    const constitution = path.join(ws, ".agent", "constitution.yaml");
    const sock = resolveSocket();

    if (!fs.existsSync(ws)) {
      issues.push("Workspace missing");
      if (opts.fix) {
        fs.mkdirSync(habitsDir, { recursive: true });
        fs.mkdirSync(path.join(ws, ".agent"), { recursive: true });
        fixes.push("Created workspace directories");
      }
    }
    if (!fs.existsSync(habitsDir)) {
      issues.push("Habits directory missing");
      if (opts.fix) {
        fs.mkdirSync(habitsDir, { recursive: true });
        fixes.push("Created habits directory");
      }
    }
    if (!fs.existsSync(constitution)) {
      issues.push("Constitution missing");
      if (opts.fix) {
        fs.writeFileSync(constitution, [
          "# Agent Character Kit — constitution (hard constraints).",
          "# The daemon embeds safe defaults; this file OVERRIDES/extends them.",
          "hard_constraints:",
          "  - no_credential_leak: block any tool call that would expose a secret",
          "  - no_destructive_without_confirm: block rm -rf /, mkfs, dd on disks, etc. unless confirmed",
        ].join("\n") + "\n");
        fixes.push("Created default constitution.yaml");
      }
    }
    if (opts.reinstall) {
      const srcHabits = path.join(REPO_ROOT, "python", "example_workspace", ".agent", "habits");
      if (fs.existsSync(srcHabits)) {
        for (const f of fs.readdirSync(srcHabits)) {
          if (f.endsWith(".yaml")) {
            fs.copyFileSync(path.join(srcHabits, f), path.join(habitsDir, f));
          }
        }
        fixes.push(`Re-seeded ${fs.readdirSync(srcHabits).length} habit files`);
      }
    }
    if (!fs.existsSync(sock) && !sock.startsWith("tcp://")) {
      issues.push(`Socket not found at ${sock} (daemon may not be running)`);
      if (opts.fix) {
        fixes.push("Start daemon with: sudo systemctl start agent-enforcer (root) or ack install --yes (user)");
      }
    }
    const daemon = await checkDaemon(sock);
    if (!daemon.alive) {
      issues.push(`Daemon unreachable: ${daemon.error}`);
      if (opts.fix) {
        fixes.push("Start daemon with: sudo systemctl start agent-enforcer (root) or ack install --yes (user)");
      }
    }

    console.log("Issues found:", issues.length);
    issues.forEach(i => console.log("  ⚠ ", i));
    console.log("\nFixes applied:", fixes.length);
    fixes.forEach(f => console.log("  ✓ ", f));
    if (issues.length && !opts.fix) {
      console.log("\nRun with --fix to apply repairs.");
    }
  });

// install — one-command setup (delegates to install.js)
program
  .command("install")
  .description("Install ACK (daemon + monitor + watchdog + companion config)")
  .option("--yes", "Non-interactive, all components")
  .option("--all", "Everything: root mode + all components")
  .option("--user", "User-mode (default)")
  .option("--root", "Root mode (systemd)")
  .option("--workspace <path>", "Workspace path")
  .option("--socket <mode>", "Socket: unix | tcp | path")
  .option("--harness <name>", "Harness: claude | cursor | gemini | opencode | hermes | generic")
  .option("--no-monitor", "Skip monitor")
  .option("--no-watchdog", "Skip watchdog")
  .option("--no-companion", "Skip companion config")
  .action(async (opts) => {
    const { default: installMain } = await import("./install.js");
    process.argv = ["node", "install.js", ...Object.entries(opts)
      .filter(([_, v]) => v !== false && v !== true)
      .flatMap(([k, v]) => v === true ? [`--${k}`] : [`--${k}`, String(v)]), "--yes"];
    await installMain();
  });

// habit — create / list habits
program
  .command("habit:create")
  .description("Create a new habit")
  .argument("<name>", "Habit name (kebab-case)")
  .option("-p, --prompt <text>", "Prompt question")
  .option("-l, --logic <text>", "Reasoning / logic")
  .action(async (name, opts) => {
    const ws = resolveWorkspace();
    const habitsDir = path.join(ws, ".agent", "habits");
    fs.mkdirSync(habitsDir, { recursive: true });
    const file = path.join(habitsDir, `${name}.yaml`);
    if (fs.existsSync(file)) {
      console.error("Habit already exists:", file);
      process.exit(1);
    }
    const prompt = opts.prompt || await ask("Prompt (self-question): ");
    const logic = opts.logic || await ask("Logic (why this governs your actions): ");
    const yaml = [
      `# Habit: ${name}`,
      `# Source question: ${prompt}`,
      `# Logic: ${logic}`,
      `name: "${name}"`,
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

program
  .command("habit:list")
  .description("List all habits")
  .action(() => {
    const ws = resolveWorkspace();
    const habitsDir = path.join(ws, ".agent", "habits");
    if (!fs.existsSync(habitsDir)) {
      console.log("No habits directory");
      return;
    }
    const files = fs.readdirSync(habitsDir).filter(f => f.endsWith(".yaml"));
    for (const f of files) {
      const content = fs.readFileSync(path.join(habitsDir, f), "utf8");
      const nameMatch = content.match(/name:\s*"([^"]+)"/);
      const promptMatch = content.match(/prompt:\s*"([^"]+)"/);
      console.log(`  ${nameMatch?.[1] || f}: ${promptMatch?.[1] || "(no prompt)"}`);
    }
  });

// doctor — full diagnostics
program
  .command("doctor")
  .description("Full diagnostic report")
  .action(async () => {
    console.log("=== ACK Doctor ===\n");
    console.log("Version: 1.0.0");
    console.log("Node:", process.version);
    console.log("Platform:", process.platform, process.arch);
    console.log("");

    const ws = resolveWorkspace();
    console.log("Workspace:", ws);
    console.log("  exists:", fs.existsSync(ws));
    console.log("  habits:", fs.existsSync(path.join(ws, ".agent", "habits")) ? fs.readdirSync(path.join(ws, ".agent", "habits")).filter(f => f.endsWith(".yaml")).length : 0);
    console.log("  constitution:", fs.existsSync(path.join(ws, ".agent", "constitution.yaml")));
    console.log("");

    const sock = resolveSocket();
    console.log("Socket:", sock);
    const daemon = await checkDaemon(sock);
    console.log("  daemon:", daemon.alive ? "🟢 reachable" : "🔴 unreachable");
    if (daemon.error) console.log("    error:", daemon.error);
    console.log("");

    const results = await checkAllSockets();
    console.log("All endpoints:");
    for (const [name, info] of Object.entries(results)) {
      if (!info.checked) {
        console.log(`  ${name}: not configured`);
        continue;
      }
      console.log(`  ${name}: ${info.alive ? "🟢" : "🔴"} ${info.path}`);
    }
    console.log("");

    console.log("Ack log:", resolveAckLog(), fs.existsSync(resolveAckLog()) ? "exists" : "missing");
  });

program.parse();