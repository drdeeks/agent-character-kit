import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync, execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, "..", "..");
const ACK = path.join(REPO, "node", "bin", "ack.js");

// Regression test for a real bug: ack.js's `install`/`configure` command
// handler used to force-append "--yes" onto every invocation of
// install.js, unconditionally -- so `--yes` passed by the user was
// redundant, and the true interactive branch inside install.js could never
// actually be reached through the CLI. This proves the fix by exercising
// the real ack.js -> install.js flag round-trip end to end (not install.js
// directly, which every other test in this repo already covers).
test("ack configure --yes: real CLI flags reach install.js and actually start a live daemon", { timeout: 20000 }, () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "ack-configure-cli-"));
  try {
    const result = spawnSync(process.execPath, [
      ACK, "configure", "--yes",
      "--workspace", ws,
      "--harness", "generic",
      "--no-claude-config",
    ], { encoding: "utf8", timeout: 15000 });

    assert.equal(result.status, 0, `ack configure --yes should exit 0. stderr: ${result.stderr}`);
    const pidMatch = result.stdout.match(/Daemon pid:\s+(\d+)/);
    assert.ok(pidMatch, `expected a real daemon pid in output. stdout: ${result.stdout}`);
    const daemonPid = Number(pidMatch[1]);
    let alive = true;
    try { process.kill(daemonPid, 0); } catch { alive = false; }
    assert.equal(alive, true, "the reported daemon pid must actually be a running process");
    try { process.kill(daemonPid, "SIGKILL"); } catch { /* already dead */ }
  } finally {
    try { execSync(`pkill -f ${JSON.stringify(ws)}`); } catch { /* nothing left to kill, expected */ }
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

// Regression test for a real bug found by actually re-running the CLI
// against a real workspace twice in a row (not just reading the code):
// launchDaemon() had no liveness check, so a second `ack configure --yes`
// against the same workspace spawned a SECOND daemon that stole the unix
// socket out from under the first via unlink+rebind, leaving the original
// orphaned (still alive, no longer reachable). Reproduced live on a real
// global install before this fix existed.
test("ack configure --yes is idempotent: running it twice reuses the same daemon, never spawns a second one", { timeout: 25000 }, () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "ack-configure-idempotent-"));
  try {
    const run = () => spawnSync(process.execPath, [
      ACK, "configure", "--yes",
      "--workspace", ws,
      "--harness", "generic",
      "--no-claude-config",
    ], { encoding: "utf8", timeout: 15000 });

    const first = run();
    assert.equal(first.status, 0, `first run should exit 0. stderr: ${first.stderr}`);
    const firstPid = Number(first.stdout.match(/Daemon pid:\s+(\d+)/)?.[1]);
    assert.ok(firstPid, `expected a real daemon pid. stdout: ${first.stdout}`);

    const second = run();
    assert.equal(second.status, 0, `second run should exit 0. stderr: ${second.stderr}`);
    assert.match(second.stdout, /already running.*reusing/i,
      "second run must report reuse, not silently spawn another daemon");
    const secondPid = Number(second.stdout.match(/Daemon pid:\s+(\d+)/)?.[1]);
    assert.equal(secondPid, firstPid, "the second run must report the SAME daemon pid, not a new one");

    // Real proof, not just trusting the printed pid: exactly one live
    // process for this workspace's daemon script, not two.
    const psOut = execSync(`pgrep -f ${JSON.stringify(ws)} | wc -l`, { encoding: "utf8" }).trim();
    assert.equal(Number(psOut), 3, // daemon + monitor + watchdog, each exactly once
      `expected exactly 3 processes (daemon+monitor+watchdog) for this workspace, found ${psOut}`);
  } finally {
    try { execSync(`pkill -9 -f ${JSON.stringify(ws)}`); } catch { /* nothing left to kill, expected */ }
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test("ack install (legacy alias) still resolves to the same configure command", () => {
  const result = spawnSync(process.execPath, [ACK, "install", "--help"], { encoding: "utf8" });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /Set up daemon/);
});
