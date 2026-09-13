/**
 * Live proof the Watchtower adapter can still talk to this kit.
 * Same NDJSON: {method, params, token?} / one JSON line back.
 * Frozen v0: execute_tool, get_habit, submit_ack, heartbeat.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const DAEMON = path.join(ROOT, "node/enforcer/agent_enforcer_daemon.js");
const ADAPTER = path.resolve(ROOT, "../watchtower-adapter/src/bridge/character-kit.ts");
const AUTH = "wt-" + "v0-tok";

function rpc(sock, method, params = {}) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(sock);
    let buf = "";
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`timeout ${method}`));
    }, 5000);
    socket.setEncoding("utf8");
    socket.on("connect", () => {
      socket.write(JSON.stringify({ method, params, token: AUTH }) + "\n");
    });
    socket.on("data", (chunk) => {
      buf += chunk;
      const idx = buf.indexOf("\n");
      if (idx === -1) return;
      clearTimeout(timer);
      socket.end();
      try { resolve(JSON.parse(buf.slice(0, idx))); }
      catch (err) { reject(err); }
    });
    socket.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

async function startDaemon() {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "ack-wt-"));
  fs.mkdirSync(path.join(ws, ".agent", "habits"), { recursive: true });
  const sock = path.join(ws, ".agent", "enforcer.sock");
  const child = spawn(process.execPath, [DAEMON], {
    env: {
      ...process.env,
      AGENT_WORKSPACE: ws,
      ENFORCER_SOCKET: sock,
      ACK_AUTH_TOKEN: AUTH,
    },
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  const start = Date.now();
  while (!fs.existsSync(sock) && Date.now() - start < 8000) {
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.ok(fs.existsSync(sock), "daemon socket");
  return { ws, sock, child };
}

function stopDaemon(child, ws) {
  try { process.kill(-child.pid, "SIGKILL"); } catch { /* gone */ }
  try { child.kill("SIGKILL"); } catch { /* gone */ }
  fs.rmSync(ws, { recursive: true, force: true });
}

test("Watchtower v0 NDJSON: execute_tool, get_habit, submit_ack, heartbeat", { timeout: 20000 }, async () => {
  const { ws, sock, child } = await startDaemon();
  try {
    const allow = await rpc(sock, "execute_tool", { tool: "Bash", command: "ls" });
    assert.equal(allow.error, undefined);
    assert.equal(allow.denied, false);

    const deny = await rpc(sock, "execute_tool", { tool: "Bash", command: "rm -rf /" });
    assert.equal(deny.denied, true);
    assert.equal(typeof deny.reason, "string");

    const habit = await rpc(sock, "get_habit", { name: "no_credential_leak" });
    assert.equal(habit.error, undefined);
    assert.equal(habit.name, "no_credential_leak");

    const missing = await rpc(sock, "get_habit", { name: "not-a-habit" });
    assert.match(String(missing.error), /unknown habit/);

    const ack = await rpc(sock, "submit_ack", {
      session_id: "default",
      statement: "Habit: no_credential_leak because I wrote packages/daemon/src/enforcer.js and it will prevent assigned secrets in this session",
    });
    assert.equal(ack.ok, true, JSON.stringify(ack));

    const beat = await rpc(sock, "heartbeat", {});
    assert.equal(beat.status, "ok");
    assert.equal(typeof beat.version, "string");
    assert.equal(beat.error, undefined);
  } finally {
    stopDaemon(child, ws);
  }
});

test("Watchtower adapter createCharacterKitClient against live ACK daemon", { timeout: 20000 }, async () => {
  if (!fs.existsSync(ADAPTER)) {
    assert.fail(`watchtower adapter missing at ${ADAPTER}`);
  }
  const { ws, sock, child } = await startDaemon();
  try {
    const mod = await import(pathToFileURL(ADAPTER).href);
    const client = mod.createCharacterKitClient(sock, AUTH);
    const allowed = await client.gateAction("Bash", { command: "ls" });
    assert.equal(allowed.decision, "allowed");
    const blocked = await client.gateAction("Bash", { command: "rm -rf /" });
    assert.equal(blocked.decision, "blocked");
    await client.injectHabit("no_credential_leak", "verify habit exists");
    await client.submitAcknowledgement(
      "Habit: no_credential_leak because I wrote packages/daemon/src/enforcer.js and it will prevent assigned secrets in this session",
    );
    await client.heartbeat();
    assert.equal(client.isConnected(), true);
  } finally {
    stopDaemon(child, ws);
  }
});
