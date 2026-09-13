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
import path from "path";
import { VERSION } from "../src/version.js";
import { dispatchV0 } from "../../packages/daemon/src/dispatch-v0.js";
import { attachJsonlRpc, listenEnforcerSocket } from "../../packages/daemon/src/jsonl-server.js";
import { Enforcer, EnforcerWithConfig } from "../../packages/daemon/src/enforcer.js";
import { resolveWorkspaces, registerWorkspace } from "../../packages/daemon/src/registry.js";
import { maybeStartMcpHttp } from "../../packages/daemon/src/mcp-http.js";

export { Enforcer, EnforcerWithConfig } from "../../packages/daemon/src/enforcer.js";

// Version — single source of truth is node/src/version.js (kept in sync
// with /VERSION at repo root). Re-exported under this name for the RPC
// wire format / existing call sites in this file.
export const ACK_VERSION = VERSION;

function startSocketServer(enforcer) {
  const server = net.createServer((socket) => {
    attachJsonlRpc(socket, (request) => {
      console.error("[daemon] parsed:", JSON.stringify(request));
      return dispatchV0(enforcer, request, { includePid: true, version: ACK_VERSION });
    });
  });

  const raw = process.env.ENFORCER_SOCKET
    || (enforcer.cfg.WORKSPACE && path.join(enforcer.cfg.WORKSPACE, ".agent", "enforcer.sock"))
    || "/run/agent-enforcer/main.sock";

  listenEnforcerSocket(server, raw, {
    fatal: true,
    onListening: () => {
      console.log(`ACK Enforcer daemon v${ACK_VERSION} listening on ${raw}`);
      console.log("System-owned enforcement service started successfully.");
    },
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

function startMultiWorkspaceDaemon(workspaces) {
  const servers = [];
  const enforcers = new Map(); // workspace path -> Enforcer instance

  for (const ws of workspaces) {
    const envOverrides = { ...process.env, AGENT_WORKSPACE: ws };
    // Each workspace gets its own socket under its .agent/ dir, named after
    // the workspace's own directory name -- install.js already names each
    // agent's nested workspace dir after its resolved agent name (identity
    // file, or a real prompt, or the harness name), so the basename IS the
    // agent name already. No separate naming step needed here; this just
    // stops hardcoding the literal filename "enforcer.sock" for every
    // single agent indistinguishably (drdeek, 2026-08-07: "how do you know
    // if you have 12 agents running at the same time on one sock which one
    // is doing what?"). Deliberately no "just one workspace, use the bare
    // ENFORCER_SOCKET env var instead" special case: once this function
    // runs at all (multi-workspace mode, forced by a real registry from
    // agent #1 onward -- see resolveWorkspaces' hasRegistry), naming needs
    // to be consistent regardless of how many agents happen to be
    // registered THIS run. Without this, agent #1 would get a generic name
    // now and silently change socket path the moment agent #2 showed up.
    const sock = path.join(ws, ".agent", `${path.basename(ws)}.sock`);

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

    const server = net.createServer((socket) => {
      attachJsonlRpc(socket, (request) => dispatchV0(enforcer, request, {
        registerWorkspace,
        version: ACK_VERSION,
      }));
    });

    listenEnforcerSocket(server, sock, {
      failLabel: `Failed to start enforcer socket for workspace ${ws}:`,
      onListening: () => {
        console.log(`ACK Enforcer daemon v${ACK_VERSION} listening on ${sock} [workspace: ${ws}]`);
      },
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

// ─── Bootstrap ──────────────────────────────────────────────────────────────────
const { list: workspaces, hasRegistry } = resolveWorkspaces();
if (workspaces.length > 1 || process.env.AGENT_WORKSPACES || hasRegistry) {
  const { enforcers } = startMultiWorkspaceDaemon(workspaces);
  const first = enforcers.values().next().value;
  maybeStartMcpHttp(first, { version: ACK_VERSION, registerWorkspace });
  console.log(`ACK Enforcer daemon v${ACK_VERSION} started in multi-workspace mode.`);
  console.log(`Serving ${workspaces.length} workspaces: ${workspaces.join(", ")}`);
} else {
  const enforcer = new Enforcer();
  startSocketServer(enforcer);
  maybeStartMcpHttp(enforcer, { version: ACK_VERSION, includePid: true });
  console.log(`ACK Enforcer daemon v${ACK_VERSION} started successfully.`);
  console.log("Root-owned system daemon with automatic restart support.");
  console.log(`Workspace: ${enforcer.cfg.WORKSPACE}`);
  console.log(`Config: ${enforcer.cfg.CONSTITUTION}`);
  console.log(`Habits directory: ${enforcer.cfg.HABITS_DIR}`);
}
