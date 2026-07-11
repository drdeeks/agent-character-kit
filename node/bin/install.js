#!/usr/bin/env node
/**
 * @character-kit interactive installer.
 *
 * One command deploys the whole kit:
 *   npm i -g @character-kit        (postinstall runs this)
 *   npx @character-kit install     (or: ack install)
 *
 * Non-interactive (CI / tests / scripting):
 *   ack install --workspace ~/myagent --socket unix --user --yes
 *
 * Interactive (TTY): prompts for where the agent + habit system live, the
 * socket mode, and root vs user install. Writes a single .env that EVERY
 * component reads (daemon, monitor, watchdog, python plugin, node client).
 * No hardcoded paths — references self-resolve from AGENT_WORKSPACE + ENFORCER_SOCKET.
 *
 * Cross-platform: Node only, supports Linux/macOS/Windows.
 */
import fs from "fs";
import path from "path";
import os from "os";
import readline from "readline";
import { spawn } from "child_process";
import { fileURLToPath, pathToFileURL } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, "..", ".."); // package root
const HOME = os.homedir();

function parseArgs(argv) {
  const out = { workspace: null, socket: null, root: null, yes: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--workspace") out.workspace = argv[++i];
    else if (a === "--socket") out.socket = argv[++i];
    else if (a === "--root") out.root = true;
    else if (a === "--user") out.root = false;
    else if (a === "--yes" || a === "-y") out.yes = true;
  }
  return out;
}

// Resolve socket: --socket may be a MODE ("unix"/"tcp"/"1"/"2") or a literal
// path. "unix" -> workspace-relative; "tcp" -> loopback TCP. Exported for tests.
export function resolveSocket(socketArg, absWs) {
  const s = String(socketArg || "unix").toLowerCase();
  if (s === "tcp" || s === "2") return "tcp://127.0.0.1:8753";
  if (s.startsWith("tcp://")) return s;
  return path.join(absWs, ".agent", "enforcer.sock");
}

function writeEnv(destDir, vars) {
  const lines = Object.entries(vars).map(([k, v]) => `${k}=${v}`);
  fs.writeFileSync(path.join(destDir, ".env"), lines.join("\n") + "\n");
}

function seedHabits(wsDir) {
  const agentDir = path.join(wsDir, ".agent");
  const habitsDir = path.join(agentDir, "habits");
  fs.mkdirSync(habitsDir, { recursive: true });
  const src = path.join(REPO, "python", "example_workspace", ".agent", "habits");
  if (fs.existsSync(src)) {
    for (const f of fs.readdirSync(src)) {
      if (f.endsWith(".yaml") && !fs.existsSync(path.join(habitsDir, f))) {
        fs.copyFileSync(path.join(src, f), path.join(habitsDir, f));
      }
    }
  }
  if (!fs.existsSync(path.join(agentDir, "constitution.yaml"))) {
    fs.writeFileSync(
      path.join(agentDir, "constitution.yaml"),
      "# Agent constitution — define your character's non-negotiables here.\n"
    );
  }
}

function generateService(wsDir, sock, root) {
  const unitName = "agent-character-kit.service";
  const svc = `[Unit]
Description=Agent Character Kit enforcer (${root ? "system" : "user"})
After=network.target

[Service]
Environment=AGENT_WORKSPACE=${wsDir}
Environment=ENFORCER_SOCKET=${sock}
Environment=HOME=${HOME}
WorkingDirectory=${path.join(REPO, "node", "enforcer")}
ExecStart=${process.execPath} ${path.join(REPO, "node", "enforcer", "agent_enforcer_daemon.js")}
Restart=always
RestartSec=5

[Install]
WantedBy=${root ? "multi-user.target" : "default.target"}
`;
  return { unitName, svc };
}

async function prompt(opts) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q, def) =>
    new Promise((res) => rl.question(`${q}${def ? ` [${def}]` : ""}: `, (a) => res((a || "").trim() || def || "")));
  const defaultWs = path.join(HOME, ".agent-character-kit", "workspace");
  opts.workspace = await ask("Where should your agent + habit system live?", opts.workspace || defaultWs);
  const sm = await ask("Socket: (1) unix under workspace  (2) tcp://127.0.0.1:8753", opts.socket || "1");
  opts.socket = sm === "2" ? "tcp://127.0.0.1:8753" : path.join(opts.workspace, ".agent", "enforcer.sock");
  const ra = await ask("Install as root service? (y/N — user-scoped is default)", "N");
  opts.root = ra.toLowerCase() === "y";
  rl.close();
  return opts;
}

function deploy(opts) {
  const absWs = path.resolve(opts.workspace);
  fs.mkdirSync(path.join(absWs, ".agent"), { recursive: true });
  seedHabits(absWs);

  // Resolve socket via the shared helper (also unit-tested).
  const sock = resolveSocket(opts.socket, absWs);
  const vars = {
    AGENT_WORKSPACE: absWs,
    ENFORCER_SOCKET: sock,
    ACK_ACK_LOG: path.join(absWs, ".agent", "ack.jsonl"),
    ACK_INJECT_LOG: path.join(absWs, ".agent", "inject.jsonl"),
    ACK_HABITS_DIR: path.join(absWs, ".agent", "habits"),
  };
  writeEnv(REPO, vars);
  writeEnv(absWs, vars);

  const { unitName, svc } = generateService(absWs, sock, opts.root);
  const unitPath = opts.root
    ? path.join("/etc", "systemd", "system", unitName)
    : path.join(HOME, ".config", "systemd", "user", unitName);

  console.log("\n--- Install summary ---");
  console.log("Workspace:     ", absWs);
  console.log("Socket:        ", sock);
  console.log("Habits seeded: ", path.join(absWs, ".agent", "habits"));
  console.log(".env written:  ", path.join(REPO, ".env"), "+", path.join(absWs, ".env"));
  console.log("Service unit:  ", unitPath, opts.root ? "(root)" : "(user)");

  try {
    fs.mkdirSync(path.dirname(unitPath), { recursive: true });
    fs.writeFileSync(unitPath, svc);
    console.log("Unit written. Enable with:");
    console.log(opts.root
      ? `  sudo systemctl enable --now ${unitName}`
      : `  systemctl --user enable --now ${unitName}`);
  } catch (e) {
    console.log(`Could not write ${unitPath} (permission). Run with sudo for root, or copy manually.`);
  }

  // Start the daemon (persistent) — use spawn+unref so the installer can exit.
  // spawnSync would block forever waiting for the daemon to terminate.
  const child = spawn(
    process.execPath,
    [path.join(REPO, "node", "enforcer", "agent_enforcer_daemon.js")],
    { env: { ...process.env, ...vars }, detached: !opts.root, stdio: "ignore" }
  );
  child.unref();
  if (child.pid) {
    console.log("\n@character-kit enforcer started. Enforcement is now live.");
  } else {
    console.log("\nDaemon did not start automatically — start manually or via the unit above.");
  }
  console.log("\nDone. Reference @character-kit in your harness config to activate enforcement.\n");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const interactive = process.stdin.isTTY && !args.yes;
  let opts = { workspace: args.workspace, socket: args.socket, root: args.root };

  if (interactive) {
    opts = await prompt(opts);
  } else {
    opts.workspace = opts.workspace || path.join(HOME, ".agent-character-kit", "workspace");
    opts.socket = opts.socket === "tcp"
      ? "tcp://127.0.0.1:8753"
      : (opts.socket || path.join(opts.workspace, ".agent", "enforcer.sock"));
    if (opts.root === null) opts.root = false;
  }
  deploy(opts);
}

// Run only when invoked as the CLI (node bin/install.js), NOT when imported
// by tests. Guard prevents side effects (writing .env, spawning daemon) on import.
const __isCLI = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (__isCLI) {
  main().catch((e) => {
    console.error("Install failed:", e.message);
    process.exit(1);
  });
}
