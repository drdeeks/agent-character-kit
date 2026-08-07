import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  listProcesses,
  killByPidFile,
  killByPattern,
  claudeSettingsPath,
  stripClaudeHooks,
} from "../bin/preuninstall.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ─── killByPattern / killByPidFile matching logic (synthetic proc lists) ─────

test("killByPattern: only kills processes whose command matches the marker", () => {
  let killed = [];
  const origKill = process.kill;
  process.kill = (pid) => { killed.push(pid); };
  try {
    const procs = [
      { pid: 100, command: "node /some/path/deploy/ack_monitor.js" },
      { pid: 101, command: "node /some/path/deploy/ack_watchdog.js" },
      { pid: 102, command: "unrelated-process --flag" },
    ];
    const result = killByPattern(path.join("deploy", "ack_monitor.js"), "monitor", procs);
    assert.equal(result, true);
    assert.deepEqual(killed, [100], "must kill only the matching process, not the watchdog or the unrelated one");
  } finally {
    process.kill = origKill;
  }
});

test("killByPattern: returns false and kills nothing when no process matches", () => {
  let killed = [];
  const origKill = process.kill;
  process.kill = (pid) => { killed.push(pid); };
  try {
    const procs = [{ pid: 200, command: "totally-unrelated" }];
    const result = killByPattern("deploy/ack_monitor.js", "monitor", procs);
    assert.equal(result, false);
    assert.deepEqual(killed, []);
  } finally {
    process.kill = origKill;
  }
});

test("killByPidFile: stale PID file (process not in list) is skipped silently, not an error", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ack-pidfile-"));
  let killed = [];
  const origKill = process.kill;
  process.kill = (pid) => { killed.push(pid); };
  try {
    const pidFile = path.join(tmp, "ack-monitor.pid");
    fs.writeFileSync(pidFile, "999999\n"); // a PID very unlikely to exist
    const procs = []; // simulates: that PID is not actually running
    const result = killByPidFile(pidFile, "deploy/ack_monitor.js", "monitor", procs);
    assert.equal(result, false, "stale PID file must not report a kill");
    assert.deepEqual(killed, [], "must not attempt to kill a PID confirmed not running");
  } finally {
    process.kill = origKill;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("killByPidFile: PID reused by an unrelated process falls back to pattern match instead of killing the wrong process", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ack-pidfile-reuse-"));
  let killed = [];
  const origKill = process.kill;
  process.kill = (pid) => { killed.push(pid); };
  try {
    const pidFile = path.join(tmp, "ack-monitor.pid");
    fs.writeFileSync(pidFile, "555\n");
    const procs = [
      { pid: 555, command: "some-completely-different-program" }, // PID reused
      { pid: 556, command: "node /x/deploy/ack_monitor.js" }, // the real one, different PID
    ];
    killByPidFile(pidFile, path.join("deploy", "ack_monitor.js"), "monitor", procs);
    assert.deepEqual(killed, [556], "must kill the real monitor found by pattern match, never the reused PID 555");
  } finally {
    process.kill = origKill;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("killByPidFile: valid, matching PID file kills exactly that process", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ack-pidfile-valid-"));
  let killed = [];
  const origKill = process.kill;
  process.kill = (pid) => { killed.push(pid); };
  try {
    const pidFile = path.join(tmp, "ack-monitor.pid");
    fs.writeFileSync(pidFile, "777\n");
    const procs = [{ pid: 777, command: "node /x/deploy/ack_monitor.js" }];
    const result = killByPidFile(pidFile, path.join("deploy", "ack_monitor.js"), "monitor", procs);
    assert.equal(result, true);
    assert.deepEqual(killed, [777]);
  } finally {
    process.kill = origKill;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ─── listProcesses (real, no mocking -- must find this test's own process) ────

test("listProcesses: returns real running processes including this test's own node process", () => {
  const procs = listProcesses();
  assert.ok(Array.isArray(procs) && procs.length > 0, "must return a non-empty real process list");
  assert.ok(procs.some((p) => p.pid === process.pid), "this test's own PID must be discoverable in the real process list");
});

// ─── End-to-end: spawn a REAL process, kill it via killByPattern, confirm it's gone ──

test("killByPattern end-to-end: a real spawned process matching the marker is actually terminated", async () => {
  // The PID is a SEPARATE `ps` column, never part of the command text --
  // an earlier version of this test searched for the PID inside the
  // command string and always found nothing (a bug in the test, not the
  // function). Use a unique marker actually embedded in the -e script
  // text instead, since that's what really appears in `ps`'s command
  // column.
  const marker = `ack-preuninstall-test-marker-${process.pid}-${Date.now()}`;
  const child = spawn(process.execPath, ["-e", `/* ${marker} */ setInterval(() => {}, 1000)`], {
    stdio: "ignore",
    detached: true,
  });
  child.unref();
  // Give it a moment to actually be visible in `ps`.
  await new Promise((r) => setTimeout(r, 300));

  try {
    const procs = listProcesses();
    const before = procs.find((p) => p.pid === child.pid);
    assert.ok(before, "spawned process must be visible in the real process list before killing");
    assert.ok(before.command.includes(marker), "the marker must actually be visible in the real ps command output");

    const killed = killByPattern(marker, "test-process", procs);
    assert.equal(killed, true);

    await new Promise((r) => setTimeout(r, 300));
    let stillAlive = true;
    try { process.kill(child.pid, 0); } catch { stillAlive = false; }
    assert.equal(stillAlive, false, "process must actually be dead after killByPattern, not just reported as killed");
  } finally {
    try { process.kill(child.pid, "SIGKILL"); } catch { /* already dead, expected */ }
  }
});

// ─── stripClaudeHooks (real file I/O) ─────────────────────────────────────────

test("stripClaudeHooks: removes both ack.js hook arrays, preserves unrelated settings and hooks", () => {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "ack-strip-home-"));
  const origHomeEnv = process.env.HOME;
  process.env.HOME = tmpHome;
  try {
    const settingsDir = path.join(tmpHome, ".claude");
    fs.mkdirSync(settingsDir, { recursive: true });
    const settingsPath = path.join(settingsDir, "settings.json");
    fs.writeFileSync(settingsPath, JSON.stringify({
      someUnrelatedKey: "must-survive",
      hooks: {
        SomeOtherPlugin: [{ hooks: [{ type: "command", command: "not-ack" }] }],
        PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: "node /x/bin/ack.js hook claude" }] }],
        UserPromptSubmit: [{ hooks: [{ type: "command", command: "node /x/bin/ack.js hook claude" }] }],
      },
    }, null, 2));

    assert.equal(claudeSettingsPath(), settingsPath);
    stripClaudeHooks();

    const result = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    assert.equal(result.someUnrelatedKey, "must-survive");
    assert.deepEqual(result.hooks.SomeOtherPlugin, [{ hooks: [{ type: "command", command: "not-ack" }] }],
      "unrelated hook entry must survive");
    assert.equal(result.hooks.PreToolUse, undefined, "ack.js PreToolUse entry must be fully removed");
    assert.equal(result.hooks.UserPromptSubmit, undefined, "ack.js UserPromptSubmit entry must be fully removed");
  } finally {
    process.env.HOME = origHomeEnv;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

test("stripClaudeHooks: no-ops safely (no throw) when settings.json doesn't exist", () => {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "ack-strip-missing-"));
  const origHomeEnv = process.env.HOME;
  process.env.HOME = tmpHome;
  try {
    assert.doesNotThrow(() => stripClaudeHooks());
  } finally {
    process.env.HOME = origHomeEnv;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

test("stripClaudeHooks: leaves a corrupted (unparseable) settings.json untouched rather than guessing", () => {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "ack-strip-corrupt-"));
  const origHomeEnv = process.env.HOME;
  process.env.HOME = tmpHome;
  try {
    const settingsDir = path.join(tmpHome, ".claude");
    fs.mkdirSync(settingsDir, { recursive: true });
    const settingsPath = path.join(settingsDir, "settings.json");
    const corrupted = "{ this is not valid json,,,";
    fs.writeFileSync(settingsPath, corrupted);
    stripClaudeHooks();
    assert.equal(fs.readFileSync(settingsPath, "utf8"), corrupted, "corrupted file must be left byte-for-byte untouched");
  } finally {
    process.env.HOME = origHomeEnv;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});
