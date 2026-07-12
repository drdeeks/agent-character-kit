import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { resolveSocket } from "../bin/install.js";

const REPO = path.resolve(process.cwd());
const DAEMON = path.join(REPO, "node", "enforcer", "agent_enforcer_daemon.js");

// ─── install.js socket resolution (pure, no spawn) ───────────────────────────

test("resolveSocket: unix mode -> workspace-relative path", () => {
  const ws = "/tmp/myagent";
  assert.equal(resolveSocket("unix", ws), path.join(ws, ".agent", "enforcer.sock"));
  assert.equal(resolveSocket("1", ws), path.join(ws, ".agent", "enforcer.sock"));
});

test("resolveSocket: tcp mode -> loopback url", () => {
  assert.equal(resolveSocket("tcp", "/tmp/x"), "tcp://127.0.0.1:8753");
  assert.equal(resolveSocket("2", "/tmp/x"), "tcp://127.0.0.1:8753");
  assert.equal(resolveSocket("tcp://10.0.0.1:9000", "/tmp/x"), "tcp://10.0.0.1:9000");
});

// ─── daemon reuse-window (integration: boot daemon, exercise submitAck) ───────

function rpc(sock, method, params) {
  return new Promise((res, rej) => {
    const c = net.connect(sock, () => {
      c.write(JSON.stringify({ method, params }) + "\n");
    });
    let buf = "";
    c.on("data", (d) => {
      buf += d.toString();
      if (buf.includes("\n")) {
        c.end();
        try { res(JSON.parse(buf.split("\n")[0])); } catch (e) { rej(e); }
      }
    });
    c.on("error", rej);
  });
}

test("daemon: reuse-window rejects the previous two habits", { timeout: 25000 }, async () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "ackrw-"));
  const sock = path.join(ws, ".agent", "enforcer.sock");
  const env = { ...process.env, AGENT_WORKSPACE: ws, ENFORCER_SOCKET: sock, HOME: os.homedir() };
  fs.mkdirSync(path.join(ws, ".agent", "habits"), { recursive: true });

  const { spawn } = await import("node:child_process");
  const child = spawn(process.execPath, [DAEMON], { env, detached: true, stdio: "ignore" });
  child.unref();

  // Seed the workspace with the kit's real habit files so the daemon knows all
  // of them (mirrors what `ack install` does). Without this, only the single
  // embedded default habit exists and the window test can't use 3 distinct habits.
  const repoHabits = path.join(REPO, "python", "example_workspace", ".agent", "habits");
  const wsHabits = path.join(ws, ".agent", "habits");
  if (fs.existsSync(repoHabits)) {
    for (const f of fs.readdirSync(repoHabits)) {
      if (f.endsWith(".yaml")) fs.copyFileSync(path.join(repoHabits, f), path.join(wsHabits, f));
    }
  }

  // unique session so no residual state from a prior run can interfere
  const sid = "test-" + path.basename(ws);

  try {
    // poll for the socket instead of a fixed sleep (host-speed independent)
    const start = Date.now();
    while (!fs.existsSync(sock) && Date.now() - start < 8000) {
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.ok(fs.existsSync(sock), "daemon socket should be up before RPCs");

    // Give daemon extra time to fully initialize
    await new Promise((r) => setTimeout(r, 1000));

    const a = await rpc(sock, "submit_ack", { session_id: sid, statement: "Habit: no_credential_leak why: it applies because this test spawns a real daemon and must not leak its socket path in logs" });
    const b = await rpc(sock, "submit_ack", { session_id: sid, statement: "Habit: complete_thoroughly resonates true — it ensures proper scope because the window test must exercise three distinct embedded-backed habits, not a lucky pair" });
    assert.equal(a.ok, true);
    assert.equal(b.ok, true);

    const reuseA = await rpc(sock, "submit_ack", { session_id: sid, statement: "Habit: no_credential_leak why: it applies because this test spawns a real daemon and must not leak its socket path in logs" });
    const reuseB = await rpc(sock, "submit_ack", { session_id: sid, statement: "Habit: complete_thoroughly resonates true — it ensures proper scope because the window test must exercise three distinct embedded-backed habits, not a lucky pair" });
    assert.equal(reuseA.ok, false, "reusing no_credential_leak (in previous two) must be rejected");
    assert.equal(reuseB.ok, false, "reusing complete_thoroughly (in previous two) must be rejected");

    const c = await rpc(sock, "submit_ack", { session_id: sid, statement: "Habit: rigorous_commits_no_push because it matters that this third ack uses a different closer and a genuinely different reason than the first two" });
    assert.equal(c.ok, true);
    const aAgain = await rpc(sock, "submit_ack", { session_id: sid, statement: "Habit: no_credential_leak applies because the window has shifted and the daemon now accepts this habit again with fresh reasoning" });
    assert.equal(aAgain.ok, true, "no_credential_leak freed after window shifted");

    // filler must be rejected under the new grammar
    const filler = await rpc(sock, "submit_ack", { session_id: sid, statement: "Habit: no_credential_leak why: yes" });
    assert.equal(filler.ok, false, "filler reason (too short) must be rejected");
  } finally {
    try { process.kill(-child.pid, "SIGKILL"); } catch {}
    try { child.kill("SIGKILL"); } catch {}
    fs.rmSync(ws, { recursive: true, force: true });
  }
});
