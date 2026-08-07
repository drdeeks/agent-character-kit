import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { fileURLToPath } from "node:url";
import { resolveSocket, discoverAgentWorkspaces, writeClaudeHookConfig, claudeSettingsPath } from "../bin/install.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, "..", ".."); // package root, regardless of CWD
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

// ─── discoverAgentWorkspaces (pure, no spawn) ─────────────────────────────────

test("discoverAgentWorkspaces: finds SOUL.md and .agent/constitution.yaml markers, skips node_modules/.git, stops descending into a found workspace", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ack-discover-"));
  try {
    // A real SOUL.md-marked workspace
    fs.mkdirSync(path.join(root, "agent-a"), { recursive: true });
    fs.writeFileSync(path.join(root, "agent-a", "SOUL.md"), "# agent a\n");
    // A real .agent/constitution.yaml-marked workspace
    fs.mkdirSync(path.join(root, "agent-b", ".agent"), { recursive: true });
    fs.writeFileSync(path.join(root, "agent-b", ".agent", "constitution.yaml"), "hard_constraints: []\n");
    // Should never be scanned into
    fs.mkdirSync(path.join(root, "node_modules", "some-pkg"), { recursive: true });
    fs.writeFileSync(path.join(root, "node_modules", "some-pkg", "SOUL.md"), "# should not be found\n");
    // Nested SOUL.md one level inside an already-found workspace -- must not
    // also appear, since discovery stops descending once a marker is found.
    fs.mkdirSync(path.join(root, "agent-a", "nested"), { recursive: true });
    fs.writeFileSync(path.join(root, "agent-a", "nested", "SOUL.md"), "# nested, should not appear separately\n");

    const found = discoverAgentWorkspaces(root);
    const dirs = found.map((f) => f.dir).sort();

    assert.deepEqual(dirs, [path.join(root, "agent-a"), path.join(root, "agent-b")].sort());
    assert.equal(found.find((f) => f.dir === path.join(root, "agent-a")).marker, "SOUL.md");
    assert.equal(found.find((f) => f.dir === path.join(root, "agent-b")).marker, ".agent/constitution.yaml");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("discoverAgentWorkspaces: returns empty array for a directory with no markers, and for a nonexistent path", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ack-discover-empty-"));
  try {
    fs.mkdirSync(path.join(root, "just-a-dir"), { recursive: true });
    assert.deepEqual(discoverAgentWorkspaces(root), []);
    assert.deepEqual(discoverAgentWorkspaces(path.join(root, "does-not-exist")), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ─── daemon reuse-window (integration: boot daemon, exercise submitAck) ───────

function rpc(sock, method, params, token) {
  return new Promise((res, rej) => {
    const c = net.connect(sock, () => {
      const payload = token !== undefined ? { method, params, token } : { method, params };
      c.write(JSON.stringify(payload) + "\n");
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

// ─── writeClaudeHookConfig (MOD-003: both PreToolUse + UserPromptSubmit) ──────

test("writeClaudeHookConfig wires both PreToolUse and UserPromptSubmit, preserves unrelated settings", () => {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "ack-claude-home-"));
  const realHome = os.homedir;
  const origHomeEnv = process.env.HOME;
  process.env.HOME = tmpHome;
  try {
    const settingsDir = path.join(tmpHome, ".claude");
    fs.mkdirSync(settingsDir, { recursive: true });
    const settingsPath = path.join(settingsDir, "settings.json");
    fs.writeFileSync(settingsPath, JSON.stringify({
      someUnrelatedKey: "must-survive",
      hooks: { SomeOtherPlugin: [{ hooks: [{ type: "command", command: "not-ack" }] }] },
    }, null, 2));

    const cmd = `node '${path.join(REPO, "node", "bin", "ack.js")}' hook claude`;
    const written = writeClaudeHookConfig(cmd);
    assert.equal(written, claudeSettingsPath());

    const result = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    assert.equal(result.someUnrelatedKey, "must-survive", "unrelated top-level key must survive");
    assert.deepEqual(result.hooks.SomeOtherPlugin, [{ hooks: [{ type: "command", command: "not-ack" }] }],
      "unrelated hook entry must survive");
    assert.ok(Array.isArray(result.hooks.PreToolUse) && result.hooks.PreToolUse.length === 1);
    assert.ok(Array.isArray(result.hooks.UserPromptSubmit) && result.hooks.UserPromptSubmit.length === 1,
      "MOD-003: UserPromptSubmit must be wired, not just PreToolUse");
    assert.equal(result.hooks.PreToolUse[0].hooks[0].command, cmd);
    assert.equal(result.hooks.UserPromptSubmit[0].hooks[0].command, cmd);

    // Re-running must replace our own entry, not duplicate it (idempotent re-install)
    writeClaudeHookConfig(cmd);
    const result2 = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    assert.equal(result2.hooks.PreToolUse.length, 1, "re-install must not duplicate PreToolUse entries");
    assert.equal(result2.hooks.UserPromptSubmit.length, 1, "re-install must not duplicate UserPromptSubmit entries");
    assert.deepEqual(result2.hooks.SomeOtherPlugin, [{ hooks: [{ type: "command", command: "not-ack" }] }],
      "unrelated hook entry must still survive after re-install");
  } finally {
    process.env.HOME = origHomeEnv;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

// ─── MOD-006: ACK_AUTH_TOKEN reaches the real daemon process env ──────────────

test("daemon: ACK_AUTH_TOKEN passed at spawn time is genuinely present in the running process's real env, and gates every RPC", { timeout: 20000 }, async () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "ackauth-"));
  const sock = path.join(ws, ".agent", "enforcer.sock");
  const realToken = "test-token-" + Math.random().toString(36).slice(2);
  // Mirrors install.js's own `vars` object after the MOD-006 fix: the token
  // now flows through the same spawn-env path as AGENT_WORKSPACE/ENFORCER_SOCKET.
  const env = { ...process.env, AGENT_WORKSPACE: ws, ENFORCER_SOCKET: sock, ACK_AUTH_TOKEN: realToken };
  fs.mkdirSync(path.join(ws, ".agent", "habits"), { recursive: true });

  const { spawn } = await import("node:child_process");
  const child = spawn(process.execPath, [DAEMON], { env, detached: true, stdio: "ignore" });
  child.unref();

  try {
    const start = Date.now();
    while (!fs.existsSync(sock) && Date.now() - start < 8000) {
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.ok(fs.existsSync(sock), "daemon socket should be up before checking its env");
    await new Promise((r) => setTimeout(r, 500));

    // Read the REAL running process's actual environment, not the env
    // object we passed to spawn() -- proves the token reached the daemon
    // itself, not just that we intended to pass it (Linux-only check; the
    // RPC-level checks below are the portable proof).
    if (fs.existsSync(`/proc/${child.pid}/environ`)) {
      const environ = fs.readFileSync(`/proc/${child.pid}/environ`, "utf8");
      assert.ok(environ.includes(`ACK_AUTH_TOKEN=${realToken}`),
        "the real daemon process's actual environment must contain the token, not just the spawn call's intent");
    }

    const withRightToken = await rpc(sock, "status", {}, realToken);
    assert.equal(withRightToken.ok, true, "a request with the correct token must succeed");

    const withWrongToken = await rpc(sock, "status", {}, "totally-wrong-token");
    assert.equal(withWrongToken.error, "unauthorized", "a mismatched token must be genuinely rejected, not silently allowed");

    const withNoToken = await rpc(sock, "status", {});
    assert.equal(withNoToken.error, "unauthorized", "a missing token must be rejected once ACK_AUTH_TOKEN is set in the daemon's env");
  } finally {
    try { process.kill(-child.pid, "SIGKILL"); } catch {}
    try { child.kill("SIGKILL"); } catch {}
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

// ─── MOD-007: liveness verification ────────────────────────────────────────────

test("isPidAlive: true for this test's own real process, false for a PID very unlikely to exist", async () => {
  const { isPidAlive } = await import("../bin/install.js");
  assert.equal(isPidAlive(process.pid), true);
  assert.equal(isPidAlive(999999), false);
  assert.equal(isPidAlive(null), false);
});

test("verifyLiveness: reports allAlive=false when the daemon PID is dead, without ever contacting a socket", async () => {
  const { verifyLiveness } = await import("../bin/install.js");
  const result = await verifyLiveness({
    sock: "/nonexistent/socket/path",
    token: "irrelevant",
    daemonPid: 999999, // not alive
    monitorPid: null,
    watchdogPid: null,
  });
  assert.equal(result.daemon, false);
  assert.equal(result.allAlive, false);
  assert.equal(result.statusOk, false, "must never claim the daemon answered when it's not even alive");
});

test("verifyLiveness: reports allAlive=false when monitor/watchdog PIDs are dead even though the daemon is alive and answering", { timeout: 15000 }, async () => {
  const { verifyLiveness } = await import("../bin/install.js");
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "acklive-"));
  const sock = path.join(ws, ".agent", "enforcer.sock");
  const token = "test-token-" + Math.random().toString(36).slice(2);
  const env = { ...process.env, AGENT_WORKSPACE: ws, ENFORCER_SOCKET: sock, ACK_AUTH_TOKEN: token };
  fs.mkdirSync(path.join(ws, ".agent", "habits"), { recursive: true });

  const { spawn } = await import("node:child_process");
  const child = spawn(process.execPath, [DAEMON], { env, detached: true, stdio: "ignore" });
  child.unref();
  try {
    const start = Date.now();
    while (!fs.existsSync(sock) && Date.now() - start < 8000) await new Promise((r) => setTimeout(r, 100));
    assert.ok(fs.existsSync(sock));
    await new Promise((r) => setTimeout(r, 300));

    const result = await verifyLiveness({
      sock, token, daemonPid: child.pid,
      monitorPid: 999999, // dead -- monitor "failed to start"
      watchdogPid: 999998, // dead -- watchdog "failed to start"
    });
    assert.equal(result.daemon, true);
    assert.equal(result.statusOk, true, "the real daemon must genuinely answer the status RPC");
    assert.equal(result.monitor, false, "a dead monitor PID must be reported as not alive");
    assert.equal(result.watchdog, false, "a dead watchdog PID must be reported as not alive");
    assert.equal(result.allAlive, false, "partial failure (daemon up, monitor/watchdog not) must not report allAlive=true");
  } finally {
    try { process.kill(-child.pid, "SIGKILL"); } catch {}
    try { child.kill("SIGKILL"); } catch {}
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test("verifyLiveness: allAlive=true end-to-end when daemon/monitor/watchdog are all really running and the token is correct", { timeout: 15000 }, async () => {
  const { verifyLiveness } = await import("../bin/install.js");
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "acklive-ok-"));
  const sock = path.join(ws, ".agent", "enforcer.sock");
  const token = "test-token-" + Math.random().toString(36).slice(2);
  const vars = {
    AGENT_WORKSPACE: ws, ENFORCER_SOCKET: sock, ACK_AUTH_TOKEN: token,
    ACK_ACK_LOG: path.join(ws, ".agent", "ack.jsonl"),
    ACK_MONITOR_PID: path.join(ws, ".agent", "ack-monitor.pid"),
    ACK_MONITOR_STATE: path.join(ws, ".agent", "ack-monitor.pos"),
    ACK_WATCHDOG_PID: path.join(ws, ".agent", "ack-watchdog.pid"),
  };
  fs.mkdirSync(path.join(ws, ".agent", "habits"), { recursive: true });

  const { spawn } = await import("node:child_process");
  const MONITOR = path.join(REPO, "deploy", "ack_monitor.js");
  const WATCHDOG = path.join(REPO, "deploy", "ack_watchdog.js");
  const daemon = spawn(process.execPath, [DAEMON], { env: { ...process.env, ...vars }, detached: true, stdio: "ignore" });
  daemon.unref();
  const monitor = spawn(process.execPath, [MONITOR], { env: { ...process.env, ...vars }, detached: true, stdio: "ignore" });
  monitor.unref();
  const watchdog = spawn(process.execPath, [WATCHDOG], { env: { ...process.env, ...vars }, detached: true, stdio: "ignore" });
  watchdog.unref();

  try {
    const start = Date.now();
    while (!fs.existsSync(sock) && Date.now() - start < 8000) await new Promise((r) => setTimeout(r, 100));
    assert.ok(fs.existsSync(sock));
    await new Promise((r) => setTimeout(r, 500));

    const result = await verifyLiveness({
      sock, token, daemonPid: daemon.pid, monitorPid: monitor.pid, watchdogPid: watchdog.pid,
    });
    assert.equal(result.allAlive, true, `expected fully alive, got ${JSON.stringify(result)}`);
  } finally {
    for (const c of [daemon, monitor, watchdog]) {
      try { process.kill(-c.pid, "SIGKILL"); } catch {}
      try { c.kill("SIGKILL"); } catch {}
    }
    fs.rmSync(ws, { recursive: true, force: true });
  }
});
