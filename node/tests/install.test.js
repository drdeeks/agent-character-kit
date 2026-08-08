import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { fileURLToPath } from "node:url";
import { resolveSocket, discoverAgentWorkspaces, writeClaudeHookConfig, claudeSettingsPath, parseArgs, installPythonCompanion, deployRootIfNeeded, parseHarnessMenuChoice, main as installMain } from "../bin/install.js";

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
  // This test's whole point is exercising a 2-item window shifting after a
  // 3rd distinct ack -- the real default is now 10 (KD-25, fixed
  // 2026-08-07: a hardcoded window of 2 meant alternating between exactly
  // two habits never tripped the guard, which is exactly what happened
  // live). Overriding it back to 2 here keeps this test's original intent
  // intact rather than rewriting it to need 11 real distinct habits; the
  // real default is covered by the new test right after this one.
  const env = { ...process.env, AGENT_WORKSPACE: ws, ENFORCER_SOCKET: sock, HOME: os.homedir(), ACK_MAX_HABIT_NAME_HISTORY: "2" };
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

    const a = await rpc(sock, "submit_ack", { session_id: sid, statement: "Habit: no_credential_leak why: this test spawns a real daemon in install.test.js and must not leak its socket path in logs" });
    const b = await rpc(sock, "submit_ack", { session_id: sid, statement: "Habit: complete_thoroughly because this test file exercises three distinct embedded-backed habits, not a lucky pair" });
    assert.equal(a.ok, true);
    assert.equal(b.ok, true);

    const reuseA = await rpc(sock, "submit_ack", { session_id: sid, statement: "Habit: no_credential_leak why: this test spawns a real daemon in install.test.js and must not leak its socket path in logs" });
    const reuseB = await rpc(sock, "submit_ack", { session_id: sid, statement: "Habit: complete_thoroughly because this test file exercises three distinct embedded-backed habits, not a lucky pair" });
    assert.equal(reuseA.ok, false, "reusing no_credential_leak (in previous two) must be rejected");
    assert.equal(reuseB.ok, false, "reusing complete_thoroughly (in previous two) must be rejected");

    const c = await rpc(sock, "submit_ack", { session_id: sid, statement: "Habit: rigorous_commits_no_push because this test edit added a third distinct connector and reason, not a repeat of the first two" });
    assert.equal(c.ok, true);
    const aAgain = await rpc(sock, "submit_ack", { session_id: sid, statement: "Habit: no_credential_leak applies because this test's window has shifted and the daemon now accepts this habit again with fresh reasoning" });
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

test("daemon: real default habit-name window (10) rejects immediate reuse -- the exact live bug KD-25 caught", { timeout: 25000 }, async () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "ackdw-"));
  const sock = path.join(ws, ".agent", "enforcer.sock");
  // No ACK_MAX_HABIT_NAME_HISTORY override here -- this is the real default
  // (10) the daemon ships with. The bug drdeek caught live: a hardcoded
  // window of 2 let exactly 2 alternating habit names pass forever. This
  // proves the shipped default actually closes that gap.
  const env = { ...process.env, AGENT_WORKSPACE: ws, ENFORCER_SOCKET: sock, HOME: os.homedir() };
  fs.mkdirSync(path.join(ws, ".agent", "habits"), { recursive: true });

  const { spawn } = await import("node:child_process");
  const child = spawn(process.execPath, [DAEMON], { env, detached: true, stdio: "ignore" });
  child.unref();

  const repoHabits = path.join(REPO, "python", "example_workspace", ".agent", "habits");
  const wsHabits = path.join(ws, ".agent", "habits");
  if (fs.existsSync(repoHabits)) {
    for (const f of fs.readdirSync(repoHabits)) {
      if (f.endsWith(".yaml")) fs.copyFileSync(path.join(repoHabits, f), path.join(wsHabits, f));
    }
  }

  const sid = "test-" + path.basename(ws);

  try {
    const start = Date.now();
    while (!fs.existsSync(sock) && Date.now() - start < 8000) {
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.ok(fs.existsSync(sock), "daemon socket should be up before RPCs");
    await new Promise((r) => setTimeout(r, 1000));

    const a = await rpc(sock, "submit_ack", { session_id: sid, statement: "Habit: no_credential_leak why: this test spawns a real daemon in install.test.js under its default config" });
    const b = await rpc(sock, "submit_ack", { session_id: sid, statement: "Habit: complete_thoroughly because this test alternates exactly two habit names to reproduce the live bug" });
    assert.equal(a.ok, true);
    assert.equal(b.ok, true);

    // Alternating back to A must be rejected -- under the old hardcoded
    // window of 2, this is exactly the sequence that passed forever.
    const reuseA = await rpc(sock, "submit_ack", { session_id: sid, statement: "Habit: no_credential_leak why: this test spawns a real daemon in install.test.js under its default config" });
    assert.equal(reuseA.ok, false, "immediate reuse of A must be rejected under the real default window");

    const reuseB = await rpc(sock, "submit_ack", { session_id: sid, statement: "Habit: complete_thoroughly because this test alternates exactly two habit names to reproduce the live bug" });
    assert.equal(reuseB.ok, false, "immediate reuse of B must be rejected under the real default window");
  } finally {
    try { process.kill(-child.pid, "SIGKILL"); } catch {}
    try { child.kill("SIGKILL"); } catch {}
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test("daemon: submitAck requires real work attribution, not just a generically-true-sounding reason", { timeout: 25000 }, async () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "ackattr-"));
  const sock = path.join(ws, ".agent", "enforcer.sock");
  const env = { ...process.env, AGENT_WORKSPACE: ws, ENFORCER_SOCKET: sock, HOME: os.homedir() };
  fs.mkdirSync(path.join(ws, ".agent", "habits"), { recursive: true });

  const { spawn } = await import("node:child_process");
  const child = spawn(process.execPath, [DAEMON], { env, detached: true, stdio: "ignore" });
  child.unref();

  const repoHabits = path.join(REPO, "python", "example_workspace", ".agent", "habits");
  const wsHabits = path.join(ws, ".agent", "habits");
  if (fs.existsSync(repoHabits)) {
    for (const f of fs.readdirSync(repoHabits)) {
      if (f.endsWith(".yaml")) fs.copyFileSync(path.join(repoHabits, f), path.join(wsHabits, f));
    }
  }

  try {
    const start = Date.now();
    while (!fs.existsSync(sock) && Date.now() - start < 8000) {
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.ok(fs.existsSync(sock), "daemon socket should be up before RPCs");
    await new Promise((r) => setTimeout(r, 1000));

    // Long enough to pass the length check, but attributes to nothing real
    // -- exactly the abstract truth-claim shape drdeek objected to.
    const generic = await rpc(sock, "submit_ack", {
      session_id: "attr-generic",
      statement: "Habit: no_credential_leak because it is important to never leak secrets in any project ever",
    });
    assert.equal(generic.ok, false, "a generic truth-claim reason with no concrete attribution must be rejected");

    const fileRef = await rpc(sock, "submit_ack", {
      session_id: "attr-file",
      statement: "Habit: no_credential_leak because agent_enforcer_daemon.js never logs the raw token",
    });
    assert.equal(fileRef.ok, true, "a reason naming a real file must be accepted");

    const pastAction = await rpc(sock, "submit_ack", {
      session_id: "attr-past",
      statement: "Habit: complete_thoroughly because I just fixed the reuse-window default in this session",
    });
    assert.equal(pastAction.ok, true, "a reason naming a real past-tense action must be accepted");

    const futureEffect = await rpc(sock, "submit_ack", {
      session_id: "attr-future",
      statement: "Habit: due_diligence because skipping this check will affect every future install of this package",
    });
    assert.equal(futureEffect.ok, true, "a reason naming a stated future effect must be accepted");
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

    // "status" is deliberately EXEMPT from the auth gate (fixed 2026-08-07):
    // a plain `ack status`/`ack repair`/`ack doctor` invocation is a fresh
    // process with no token in its own env (only the Claude-hook wrapper
    // sources the workspace .env), so gating status behind a token callers
    // can't possibly have yet made every liveness check silently report
    // "dead" against a perfectly healthy, correctly-tokened daemon -- found
    // live while KD-20's fix (ack repair checking other sockets first)
    // mysteriously kept failing. status's response carries no secret, so
    // this is safe. tool_tick is the real proof the gate still works for
    // everything else.
    const statusNoToken = await rpc(sock, "status", {});
    assert.equal(statusNoToken.ok, true, "status must succeed with NO token even when ACK_AUTH_TOKEN is set -- it's the one exempt method");

    const withRightToken = await rpc(sock, "tool_tick", { session_id: "auth-test", tool: "Bash" }, realToken);
    assert.notEqual(withRightToken.error, "unauthorized", "a gated method with the correct token must not be rejected");

    const withWrongToken = await rpc(sock, "tool_tick", { session_id: "auth-test", tool: "Bash" }, "totally-wrong-token");
    assert.equal(withWrongToken.error, "unauthorized", "a mismatched token must be genuinely rejected, not silently allowed");

    const withNoToken = await rpc(sock, "tool_tick", { session_id: "auth-test", tool: "Bash" });
    assert.equal(withNoToken.error, "unauthorized", "a missing token must be rejected once ACK_AUTH_TOKEN is set in the daemon's env, for every method except status");
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

// ─── Python companion vectors extra (drdeek: prompt on demand, root auto-runs pip) ──

function captureConsoleLog(fn) {
  const lines = [];
  const orig = console.log;
  console.log = (...args) => lines.push(args.join(" "));
  try {
    fn();
  } finally {
    console.log = orig;
  }
  return lines.join("\n");
}

test("parseArgs: recognizes --vectors and --no-vectors, defaults to false", () => {
  assert.equal(parseArgs([]).vectors, false, "default (no flag) must be false, never auto-on");
  assert.equal(parseArgs(["--vectors"]).vectors, true);
  assert.equal(parseArgs(["--no-vectors"]).vectors, false);
});

test("installPythonCompanion: user-mode (anyRoot=false) only prints instructions, never spawns pip", () => {
  const pyDir = path.join(REPO, "python");
  let spawnCalls = 0;
  const fakeSpawn = () => { spawnCalls++; return { status: 0 }; };

  const out = captureConsoleLog(() => {
    const result = installPythonCompanion({ pyDir, anyVectors: false, anyRoot: false }, fakeSpawn);
    assert.deepEqual(result, { ran: false, printed: true, target: pyDir });
  });
  assert.equal(spawnCalls, 0, "user-mode must never touch a non-root user's Python env automatically");
  assert.match(out, /pip3 install/);
  assert.match(out, /break-system-packages/i);
});

test("installPythonCompanion: user-mode target string includes [vectors] when anyVectors is true", () => {
  const pyDir = path.join(REPO, "python");
  const out = captureConsoleLog(() => {
    installPythonCompanion({ pyDir, anyVectors: true, anyRoot: false }, () => ({ status: 0 }));
  });
  assert.match(out, /pip3 install .*\[vectors\]/);
});

test("installPythonCompanion: root mode actually runs pip3 install via the injected spawn function", () => {
  const pyDir = path.join(REPO, "python");
  const calls = [];
  const fakeSpawn = (cmd, args) => { calls.push([cmd, ...args]); return { status: 0 }; };

  const out = captureConsoleLog(() => {
    const result = installPythonCompanion({ pyDir, anyVectors: true, anyRoot: true }, fakeSpawn);
    assert.deepEqual(result, { ran: true, ok: true, target: pyDir + "[vectors]" });
  });
  assert.equal(calls.length, 1, "success on first attempt must not retry");
  assert.deepEqual(calls[0], ["pip3", "install", pyDir + "[vectors]"]);
  assert.match(out, /Python companion installed/);
});

test("installPythonCompanion: root mode retries with --break-system-packages on PEP 668 failure, then succeeds", () => {
  const pyDir = path.join(REPO, "python");
  const calls = [];
  const fakeSpawn = (cmd, args) => {
    calls.push([cmd, ...args]);
    // First call (plain install) fails; second (with the guard flag) succeeds.
    return { status: calls.length === 1 ? 1 : 0 };
  };

  const out = captureConsoleLog(() => {
    const result = installPythonCompanion({ pyDir, anyVectors: false, anyRoot: true }, fakeSpawn);
    assert.deepEqual(result, { ran: true, ok: true, target: pyDir });
  });
  assert.equal(calls.length, 2, "must retry exactly once after a PEP 668 failure");
  assert.deepEqual(calls[0], ["pip3", "install", pyDir]);
  assert.deepEqual(calls[1], ["pip3", "install", "--break-system-packages", pyDir]);
  assert.match(out, /Retrying with --break-system-packages/);
  assert.match(out, /Python companion installed/);
});

test("installPythonCompanion: root mode reports failure (not a silent skip) if both pip attempts fail", () => {
  const pyDir = path.join(REPO, "python");
  const calls = [];
  const fakeSpawn = (cmd, args) => { calls.push([cmd, ...args]); return { status: 1 }; };

  const out = captureConsoleLog(() => {
    const result = installPythonCompanion({ pyDir, anyVectors: false, anyRoot: true }, fakeSpawn);
    assert.deepEqual(result, { ran: true, ok: false, target: pyDir });
  });
  assert.equal(calls.length, 2, "both the plain and guarded attempts must have run");
  assert.match(out, /install FAILED -- run manually/);
});

test("installPythonCompanion: no pyproject.toml at the target path -> no-op, no spawn calls at all", () => {
  const fakePyDir = path.join(os.tmpdir(), "no-such-python-dir-" + Date.now());
  let spawnCalls = 0;
  const result = installPythonCompanion(
    { pyDir: fakePyDir, anyVectors: false, anyRoot: true },
    () => { spawnCalls++; return { status: 0 }; }
  );
  assert.deepEqual(result, { ran: false });
  assert.equal(spawnCalls, 0);
});

test("main() end-to-end (user-mode, no sudo): --yes --harness hermes --python --vectors threads anyVectors through to the printed pip target", { timeout: 20000 }, async () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "ack-vectors-e2e-"));
  const sock = path.join(ws, ".agent", "enforcer.sock");
  const origArgv = process.argv;
  const origLog = console.log;
  const lines = [];
  console.log = (...args) => lines.push(args.join(" "));
  try {
    await installMain({
      yes: true,
      root: false,
      workspace: ws,
      socket: "unix",
      harness: "hermes",
      python: true,
      vectors: true,
      monitor: false,
      watchdog: false,
      companion: true,
      start: true,
      writeClaudeConfig: false,
    });
  } finally {
    console.log = origLog;
    process.argv = origArgv;
    // AGENT_WORKSPACE only ever reaches the spawned daemon via env, never
    // argv, so pkill -f <workspace> can never match it -- same real bug
    // documented in ack-configure.test.js. Scan /proc/<pid>/environ instead.
    for (const pidDir of fs.readdirSync("/proc").filter((n) => /^\d+$/.test(n))) {
      try {
        const environ = fs.readFileSync(`/proc/${pidDir}/environ`, "utf8");
        if (environ.includes(`AGENT_WORKSPACE=${ws}\0`)) process.kill(Number(pidDir), "SIGKILL");
      } catch { /* process gone, or unreadable -- fine, skip */ }
    }
    fs.rmSync(ws, { recursive: true, force: true });
  }
  const out = lines.join("\n");
  assert.match(out, /pip3 install .*\[vectors\]/, "anyVectors must reach installPythonCompanion through main()'s real accumulation logic, not just the isolated unit test");
});

// ─── deployRootIfNeeded (KD: --yes --root never actually deployed anything) ──

test("parseArgs: --service-user implies --root and captures the name", () => {
  const opts = parseArgs(["--service-user", "my-enforcer"]);
  assert.equal(opts.root, true);
  assert.equal(opts.serviceUser, "my-enforcer");
});

test("deployRootIfNeeded: asRoot=false is a no-op, never spawns sudo", async () => {
  let calls = 0;
  const result = await deployRootIfNeeded({ asRoot: false, serviceUser: null, agentWorkspace: "/tmp/whatever" }, () => { calls++; return { status: 0 }; });
  assert.deepEqual(result, { rootSocket: null });
  assert.equal(calls, 0);
});

test("deployRootIfNeeded: asRoot=true invokes sudo bash deploy-agent-enforcer.sh with the right argv and per-agent AGENT_WORKSPACE", async () => {
  const calls = [];
  const fakeSpawn = (cmd, args, opts) => { calls.push({ cmd, args, opts }); return { status: 0 }; };
  const agentWorkspace = "/var/lib/agent-character-kit/workspace/agents/claude";
  const result = await deployRootIfNeeded({ asRoot: true, serviceUser: null, agentWorkspace }, fakeSpawn);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cmd, "sudo");
  assert.deepEqual(calls[0].args.slice(0, 2), ["-E", "bash"]);
  assert.match(calls[0].args[2], /deploy-agent-enforcer\.sh$/);
  assert.equal(calls[0].opts.stdio, "inherit", "sudo's password prompt must reach the real terminal, not be captured");
  assert.equal(calls[0].opts.env.AGENT_WORKSPACE, agentWorkspace, "each agent's deploy call must pass ITS OWN workspace, not a shared one");
  assert.equal(result.rootSocket, path.join(agentWorkspace, ".agent", "claude.sock"), "socket formula must mirror startMultiWorkspaceDaemon()'s exactly");
});

test("deployRootIfNeeded: service-user mode sets ACK_SERVICE_USER/ACK_AGENT_USER in the deploy script's env", async () => {
  const calls = [];
  const fakeSpawn = (cmd, args, opts) => { calls.push({ cmd, args, opts }); return { status: 0 }; };
  await deployRootIfNeeded({ asRoot: true, serviceUser: "ack-enforcer", agentWorkspace: "/var/lib/agent-character-kit/workspace/agents/opencode" }, fakeSpawn);
  assert.equal(calls[0].opts.env.ACK_SERVICE_USER, "ack-enforcer");
  assert.equal(calls[0].opts.env.ACK_AGENT_USER, os.userInfo().username);
});

test("deployRootIfNeeded: a failed deploy throws (not a silently-successful no-op)", async () => {
  const result = await deployRootIfNeeded(
    { asRoot: true, serviceUser: null, agentWorkspace: "/tmp/whatever" },
    () => ({ status: 1 })
  ).then(() => "resolved", (e) => e);
  assert.ok(result instanceof Error, "must reject/throw on a real deploy failure, not resolve as if it worked");
  assert.match(result.message, /Deploy failed/);
});

test("deployRootIfNeeded: two different agents get two different sockets, never the same one", async () => {
  const fakeSpawn = () => ({ status: 0 });
  const a = await deployRootIfNeeded({ asRoot: true, serviceUser: null, agentWorkspace: "/var/lib/agent-character-kit/workspace/agents/claude" }, fakeSpawn);
  const b = await deployRootIfNeeded({ asRoot: true, serviceUser: null, agentWorkspace: "/var/lib/agent-character-kit/workspace/agents/opencode" }, fakeSpawn);
  assert.notEqual(a.rootSocket, b.rootSocket, "drdeek: \"how do you know if you have 12 agents running at the same time on one sock which one is doing what?\"");
});

// ─── parseHarnessMenuChoice (drdeek: "blank Enter silently installs all 3" fix) ──

const DETECTED = ["claude", "hermes", "opencode"];

test("parseHarnessMenuChoice: a single number selects exactly that one harness", () => {
  assert.deepEqual(parseHarnessMenuChoice("2", DETECTED), { action: "select", harnesses: ["hermes"] });
});

test("parseHarnessMenuChoice: comma-separated subset (the exact case drdeek's live session needed) selects only those, in order, excluding the rest", () => {
  const result = parseHarnessMenuChoice("1,3", DETECTED);
  assert.equal(result.action, "select");
  assert.deepEqual(result.harnesses, ["claude", "opencode"]);
  assert.ok(!result.harnesses.includes("hermes"), "hermes must be excluded, not silently included");
});

test("parseHarnessMenuChoice: space-separated subset works the same as comma-separated", () => {
  const result = parseHarnessMenuChoice("1 3", DETECTED);
  assert.deepEqual(result.harnesses, ["claude", "opencode"]);
});

test("parseHarnessMenuChoice: the numeric 'all' index (N+1) selects every detected harness", () => {
  const result = parseHarnessMenuChoice("4", DETECTED); // 3 detected -> allIdx = 4
  assert.deepEqual(result.harnesses, ["claude", "hermes", "opencode"]);
});

test("parseHarnessMenuChoice: the word 'all' works the same as its numeric index", () => {
  const result = parseHarnessMenuChoice("all", DETECTED);
  assert.deepEqual(result.harnesses, DETECTED);
});

test("parseHarnessMenuChoice: the numeric 'custom' index (N+2) and the word 'custom' both defer to the caller's follow-up prompt", () => {
  assert.deepEqual(parseHarnessMenuChoice("5", DETECTED), { action: "custom" }); // 3 detected -> customIdx = 5
  assert.deepEqual(parseHarnessMenuChoice("custom", DETECTED), { action: "custom" });
});

test("parseHarnessMenuChoice: the numeric 'cancel' index (N+3), 'none', and 'cancel' all cancel", () => {
  assert.deepEqual(parseHarnessMenuChoice("6", DETECTED), { action: "cancel" }); // 3 detected -> cancelIdx = 6
  assert.deepEqual(parseHarnessMenuChoice("none", DETECTED), { action: "cancel" });
  assert.deepEqual(parseHarnessMenuChoice("cancel", DETECTED), { action: "cancel" });
});

test("parseHarnessMenuChoice: out-of-range numbers are dropped, not treated as valid indices into a shorter list", () => {
  // Only 3 detected -- "9" isn't any of claude/hermes/opencode/all/custom/cancel.
  const result = parseHarnessMenuChoice("9", DETECTED);
  assert.equal(result.fallback, true);
  assert.deepEqual(result.harnesses, DETECTED);
});

test("parseHarnessMenuChoice: unrecognized garbage input falls back to all detected, with fallback flagged for the caller to warn about", () => {
  const result = parseHarnessMenuChoice("asdf", DETECTED);
  assert.equal(result.action, "select");
  assert.equal(result.fallback, true, "caller needs this flag to print the 'unrecognized, defaulting to all' warning");
  assert.deepEqual(result.harnesses, DETECTED);
});

test("parseHarnessMenuChoice: case-insensitive and tolerant of surrounding whitespace", () => {
  assert.deepEqual(parseHarnessMenuChoice("  ALL  ", DETECTED).harnesses, DETECTED);
  assert.deepEqual(parseHarnessMenuChoice(" None ", DETECTED), { action: "cancel" });
});

test("parseHarnessMenuChoice: works correctly with a different detected-harness count (menu indices shift accordingly)", () => {
  const twoDetected = ["claude", "opencode"];
  // allIdx=3, customIdx=4, cancelIdx=5 -- NOT the same indices as the 3-harness case above.
  assert.deepEqual(parseHarnessMenuChoice("3", twoDetected).harnesses, twoDetected);
  assert.deepEqual(parseHarnessMenuChoice("4", twoDetected), { action: "custom" });
  assert.deepEqual(parseHarnessMenuChoice("5", twoDetected), { action: "cancel" });
});
