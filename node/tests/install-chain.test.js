import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";

const REPO = path.resolve(process.cwd());
const INSTALL = path.join(REPO, "node", "bin", "install.js");
const DAEMON = path.join(REPO, "node", "enforcer", "agent_enforcer_daemon.js");

function rpc(sock, method, params) {
  return new Promise((res, rej) => {
    const c = net.connect(sock, () => c.write(JSON.stringify({ method, params }) + "\n"));
    let buf = "";
    c.on("data", (d) => {
      buf += d.toString();
      if (buf.includes("\n")) { c.end(); try { res(JSON.parse(buf.split("\n")[0])); } catch (e) { rej(e); } }
    });
    c.on("error", rej);
    setTimeout(() => rej(new Error("timeout")), 5000);
  });
}

test("install --yes wires daemon + monitor + watchdog and the ack chain lifts the hold", { timeout: 20000 }, async () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "ackfull-"));
  const sock = path.join(ws, ".agent", "enforcer.sock");
  const ackLog = path.join(ws, ".agent", "ack.jsonl");

  const inst = spawn(process.execPath, [INSTALL, "--workspace", ws, "--socket", "unix", "--harness", "hermes", "--user", "--yes"], {
    env: { ...process.env, HOME: os.homedir() }, stdio: "ignore",
  });
  await new Promise((r) => inst.on("exit", r));

  const start = Date.now();
  while (!fs.existsSync(sock) && Date.now() - start < 3000) await new Promise((r) => setTimeout(r, 50));
  assert.ok(fs.existsSync(sock), "daemon socket should be up after install");

  const pg = spawn("pgrep", ["-af", "ack_monitor.py"], { stdio: ["ignore", "pipe", "ignore"] });
  let pgOut = "";
  pg.stdout.on("data", (d) => (pgOut += d));
  await new Promise((r) => pg.on("exit", r));
  assert.ok(/ack_monitor\.py/.test(pgOut), "ack_monitor.py should be running after install");

  const sid = "chain-" + path.basename(ws);
  const ack1 = { statement: "Habit: no_credential_leak why: it applies because the installer wired the monitor to credit this exact log path", session_id: sid };
  const ack2 = { statement: "Habit: complete_thoroughly resonates true — it ensures proper scope because the full chain daemon+monitor must lift the hold on two real acks", session_id: sid };
  fs.appendFileSync(ackLog, JSON.stringify(ack1) + "\n" + JSON.stringify(ack2) + "\n");

  await new Promise((r) => setTimeout(r, 2500));

  const status = await rpc(sock, "tool_tick", { session_id: sid, tool: "bash" });
  assert.ok(status && typeof status.hold === "boolean", "tool_tick returned a hold state");
  assert.equal(status.hold, false, "hold lifted after monitor credited 2 acks from the log");

  try { spawn("pkill", ["-f", "ack_monitor.py"]); } catch {}
  try { spawn("pkill", ["-f", "ack_watchdog.py"]); } catch {}
  fs.rmSync(ws, { recursive: true, force: true });
});
