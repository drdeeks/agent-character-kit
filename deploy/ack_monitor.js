#!/usr/bin/env node
/**
 * ACK acknowledgment monitor (self-healing companion, Node-native).
 *
 * Node port of ack_monitor.py. The core daemon/monitor/watchdog trio is
 * Node-only — Python stays purely optional, needed only for the Hermes
 * companion binding, never for this self-healing infrastructure itself.
 *
 * Watches the external ack log the companion writes. For each entry it
 * validates the `Habit: <name> <closer> <reason>` statement and credits it
 * to the DAEMON's hold ledger via the submit_ack RPC. Runs as a separate
 * process (ideally root-owned) so the agent cannot forge or disable
 * acknowledgments from inside its own process.
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
function resolveSocket() {
  if (process.env.ENFORCER_SOCKET) return process.env.ENFORCER_SOCKET;
  const ws = process.env.AGENT_WORKSPACE;
  if (ws) return path.join(ws, ".agent", "enforcer.sock");
  return path.join(os.homedir() || "/root", ".agent-character-kit", "workspace", ".agent", "enforcer.sock");
}
const SOCKET_PATH = resolveSocket();

function rpc(method, params) {
  return new Promise((resolve) => {
    const payload = JSON.stringify({ method, params, token: process.env.ACK_AUTH_TOKEN }) + "\n";
    const isTcp = SOCKET_PATH.startsWith("tcp://");
    const socket = isTcp
      ? (() => { const u = new URL(SOCKET_PATH); return net.createConnection(parseInt(u.port, 10) || 8753, u.hostname || "127.0.0.1"); })()
      : net.createConnection(SOCKET_PATH);
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

const ACK_LOG = process.env.ACK_ACK_LOG || "/tmp/agent-character-kit-ack.jsonl";
const PIDFILE = process.env.ACK_MONITOR_PID || "/var/lib/agent-character-kit/ack-monitor.pid";
const STATE = process.env.ACK_MONITOR_STATE || "/var/lib/agent-character-kit/ack-monitor.pos";

function log(msg) {
  console.log(`${new Date().toISOString()} [ack-monitor] ${msg}`);
}
function logError(msg) {
  console.error(`${new Date().toISOString()} [ack-monitor] ${msg}`);
}

function readPos() {
  try {
    if (fs.existsSync(STATE)) {
      const [ino, off] = fs.readFileSync(STATE, "utf8").trim().split(/\s+/).map(Number);
      return { ino, off };
    }
  } catch { /* best-effort */ }
  return { ino: null, off: 0 };
}

function writePos(ino, off) {
  try {
    fs.mkdirSync(path.dirname(STATE), { recursive: true });
    fs.writeFileSync(STATE, `${ino} ${off}`);
  } catch { /* best-effort */ }
}

async function tail() {
  if (!fs.existsSync(ACK_LOG)) return;
  let st;
  try {
    st = fs.statSync(ACK_LOG);
  } catch {
    return;
  }
  let { ino: lastIno, off } = readPos();
  // Log rotated (inode changed) -> re-read from start.
  if (lastIno !== st.ino) off = 0;

  let fd;
  try {
    fd = fs.openSync(ACK_LOG, "r");
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
      const res = await rpc("submit_ack", { session_id: session, statement });
      if (res && res.ok) {
        log(`credited ack for ${session} (acked=${res.acked})`);
      } else {
        logError(`ack rejected for ${session}: ${(res && res.error) || "unknown error"}`);
      }
    }
    off = size;
  } catch (exc) {
    logError(`tail error: ${exc.message}`);
    return;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
  writePos(st.ino, off);
}

async function main() {
  try {
    fs.mkdirSync(path.dirname(PIDFILE), { recursive: true });
    fs.writeFileSync(PIDFILE, String(process.pid));
  } catch (exc) {
    logError(`could not write pidfile ${PIDFILE}: ${exc.message}`);
  }
  log(`ack monitor started (log=${ACK_LOG})`);
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      await tail();
    } catch (exc) {
      logError(`unexpected: ${exc.message}`);
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
}

main();
