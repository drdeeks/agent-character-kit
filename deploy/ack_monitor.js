#!/usr/bin/env node
/**
 * ACK acknowledgment monitor (self-healing companion, Node-native).
 *
 * Node port of ack_monitor.py. The core daemon/monitor/watchdog trio is
 * Node-only — Python stays purely optional, needed only for the Hermes
 * companion binding, never for this self-healing infrastructure itself.
 *
 * One enforcer holds every agent (agent_enforcer_daemon.js's registry-backed
 * multi-workspace mode); this monitor mirrors that -- ONE process, but it
 * tracks every registered agent individually, tailing EACH agent's own ack
 * log and crediting EACH agent's own socket. drdeek, 2026-08-07: "The
 * monitor needs to keep track of the agents, the daemon is keeping track of
 * tool calls... the watchdog make sure that the monitor and the daemon are
 * always active." One monitor, not one per agent -- but genuinely aware of
 * all of them, not blind to anything past the first.
 *
 * Self-healing: ack_watchdog.js revives this process if it dies.
 */

import fs from "fs";
import path from "path";
import net from "net";
import os from "os";

// Self-contained, deliberately no relative import of node/src/enforcer/client.js:
// deploy-ack-services.sh copies this file standalone to
// /usr/local/lib/agent-character-kit/, with no node/src sibling present
// there. Same reason python/hermes_plugin's ack_monitor.py inlines its own
// _rpc() rather than importing the repo's Python client.

// Same registry-path priority as agent_enforcer_daemon.js's own
// resolveWorkspaces() and ack.js's checkAllSockets() -- all three MUST
// agree on which file is "the" registry, or the monitor could credit a
// socket the daemon isn't actually listening on.
function resolveRegistryPath() {
  if (process.env.ACK_WORKSPACES_REGISTRY) return process.env.ACK_WORKSPACES_REGISTRY;
  if (fs.existsSync("/var/lib/agent-character-kit/workspaces.json")) {
    return "/var/lib/agent-character-kit/workspaces.json";
  }
  const homeBased = path.join(os.homedir() || "/root", ".agent-character-kit", "workspaces.json");
  return fs.existsSync(homeBased) ? homeBased : null;
}

function legacySocket() {
  if (process.env.ENFORCER_SOCKET) return process.env.ENFORCER_SOCKET;
  const ws = process.env.AGENT_WORKSPACE;
  if (ws) return path.join(ws, ".agent", "enforcer.sock");
  return path.join(os.homedir() || "/root", ".agent-character-kit", "workspace", ".agent", "enforcer.sock");
}

// Returns the list of agents to tail. Registry-backed when one exists (root
// / service-user mode, or any deploy that populated it); otherwise exactly
// one "default" agent using the original env-var-based behavior, so a plain
// single-workspace user-mode setup (which never creates a registry) is
// completely unaffected by any of this.
function resolveAgents() {
  const registryPath = resolveRegistryPath();
  if (registryPath) {
    try {
      const list = JSON.parse(fs.readFileSync(registryPath, "utf8"));
      if (Array.isArray(list) && list.length) {
        return list
          .filter((ws) => typeof ws === "string" && ws.trim())
          .map((ws) => {
            const resolved = path.resolve(ws.trim());
            const name = path.basename(resolved);
            return {
              name,
              ws: resolved,
              sock: path.join(resolved, ".agent", `${name}.sock`),
              ackLog: path.join(resolved, ".agent", "ack.jsonl"),
              statePath: path.join(resolved, ".agent", `.${name}-monitor.pos`),
            };
          });
      }
    } catch { /* malformed registry -- fall through to legacy single-agent mode */ }
  }
  return [{
    name: "default",
    ws: process.env.AGENT_WORKSPACE || null,
    sock: legacySocket(),
    ackLog: process.env.ACK_ACK_LOG || "/tmp/agent-character-kit-ack.jsonl",
    statePath: process.env.ACK_MONITOR_STATE || "/var/lib/agent-character-kit/ack-monitor.pos",
  }];
}

function rpc(sock, method, params) {
  return new Promise((resolve) => {
    const payload = JSON.stringify({ method, params, token: process.env.ACK_AUTH_TOKEN }) + "\n";
    const isTcp = sock.startsWith("tcp://");
    const socket = isTcp
      ? (() => { const u = new URL(sock); return net.createConnection(parseInt(u.port, 10) || 8753, u.hostname || "127.0.0.1"); })()
      : net.createConnection(sock);
    let data = "";
    const timeout = setTimeout(() => { socket.destroy(); resolve(null); }, 5000);
    socket.on("connect", () => socket.write(payload));
    socket.on("data", (chunk) => {
      data += chunk.toString();
      if (data.includes("\n")) {
        clearTimeout(timeout);
        socket.destroy();
        try { resolve(JSON.parse(data.trim())); } catch { resolve(null); }
      }
    });
    socket.on("error", () => { clearTimeout(timeout); resolve(null); });
  });
}

const PIDFILE = process.env.ACK_MONITOR_PID || "/var/lib/agent-character-kit/ack-monitor.pid";

function log(agentName, msg) {
  console.log(`${new Date().toISOString()} [ack-monitor:${agentName}] ${msg}`);
}
function logError(agentName, msg) {
  console.error(`${new Date().toISOString()} [ack-monitor:${agentName}] ${msg}`);
}

function readPos(statePath) {
  try {
    if (fs.existsSync(statePath)) {
      const [ino, off] = fs.readFileSync(statePath, "utf8").trim().split(/\s+/).map(Number);
      return { ino, off };
    }
  } catch { /* best-effort */ }
  return { ino: null, off: 0 };
}

function writePos(statePath, ino, off) {
  try {
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(statePath, `${ino} ${off}`);
  } catch { /* best-effort */ }
}

// Tails ONE agent's own ack log and credits ONE agent's own socket. Never
// touches another agent's state -- each agent's tail position, log, and
// socket are entirely independent, so one agent's acks can never be
// misattributed to another's hold ledger.
async function tailAgent(agent) {
  if (!fs.existsSync(agent.ackLog)) return;
  let st;
  try {
    st = fs.statSync(agent.ackLog);
  } catch {
    return;
  }
  let { ino: lastIno, off } = readPos(agent.statePath);
  if (lastIno !== st.ino) off = 0; // rotated -> re-read from start

  let fd;
  try {
    fd = fs.openSync(agent.ackLog, "r");
    const size = st.size;
    if (off > size) off = 0; // truncated
    const buf = Buffer.alloc(size - off);
    if (buf.length > 0) fs.readSync(fd, buf, 0, buf.length, off);
    const lines = buf.toString("utf8").split("\n");
    for (const raw of lines) {
      const line = raw.trim();
      if (!line) continue;
      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      const statement = entry.statement;
      const session = entry.session_id || "default";
      if (!statement) continue;
      const res = await rpc(agent.sock, "submit_ack", { session_id: session, statement });
      if (res && res.ok) {
        log(agent.name, `credited ack for ${session} (acked=${res.acked})`);
      } else {
        logError(agent.name, `ack rejected for ${session}: ${(res && res.error) || "unknown error"}`);
      }
    }
    off = size;
  } catch (exc) {
    logError(agent.name, `tail error: ${exc.message}`);
    return;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
  writePos(agent.statePath, st.ino, off);
}

async function main() {
  try {
    fs.mkdirSync(path.dirname(PIDFILE), { recursive: true });
    fs.writeFileSync(PIDFILE, String(process.pid));
  } catch (exc) {
    console.error(`could not write pidfile ${PIDFILE}: ${exc.message}`);
  }
  const startupAgents = resolveAgents();
  console.log(`${new Date().toISOString()} [ack-monitor] started, tracking ${startupAgents.length} agent(s): ${startupAgents.map((a) => a.name).join(", ")}`);
  // eslint-disable-next-line no-constant-condition
  while (true) {
    // Re-resolved every tick, not just at startup: a new agent registered
    // after this monitor started (deploy-agent-enforcer.sh restarts the
    // enforcer + monitor when that happens, but re-reading here as well
    // means a manual registry edit or a restart race still gets picked up
    // on the very next tick rather than needing yet another restart).
    const agents = resolveAgents();
    for (const agent of agents) {
      try {
        await tailAgent(agent);
      } catch (exc) {
        logError(agent.name, `unexpected: ${exc.message}`);
      }
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
}

main();
