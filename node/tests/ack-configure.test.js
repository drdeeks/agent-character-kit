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
  } finally {
    // pkill -f <workspace> cannot find monitor/watchdog either, for the same
    // reason documented on the idempotency test below -- AGENT_WORKSPACE is
    // env-only, never argv. Scan /proc/<pid>/environ for the real cleanup.
    for (const pidDir of fs.readdirSync("/proc").filter((n) => /^\d+$/.test(n))) {
      try {
        const environ = fs.readFileSync(`/proc/${pidDir}/environ`, "utf8");
        if (environ.includes(`AGENT_WORKSPACE=${ws}\0`)) process.kill(Number(pidDir), "SIGKILL");
      } catch { /* process gone, or unreadable -- fine, skip */ }
    }
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

    // Real proof the reused pid is genuinely alive, not just a number the
    // second run happened to print. NOTE: `pgrep -f <workspace>` does NOT
    // work here -- the daemon/monitor/watchdog are spawned with the
    // workspace passed via env vars only, never as a literal CLI argument,
    // so it can never match their command lines. Found live: this exact
    // mistake in earlier drafts of this test (and, it turns out, in every
    // OTHER test file's cleanup in this repo) silently leaked dozens of
    // orphaned processes across a single session before being caught.
    let daemonAlive = true;
    try { process.kill(firstPid, 0); } catch { daemonAlive = false; }
    assert.equal(daemonAlive, true, "the reused daemon pid must actually still be running");
  } finally {
    // `pgrep -f <workspace>` cannot find these (AGENT_WORKSPACE only ever
    // reaches the child as an environment variable, never a CLI argument,
    // and pgrep -f only matches argv). /proc/<pid>/environ is the real way
    // to find a process by an env var it was launched with on Linux.
    for (const pidDir of fs.readdirSync("/proc").filter((n) => /^\d+$/.test(n))) {
      try {
        const environ = fs.readFileSync(`/proc/${pidDir}/environ`, "utf8");
        if (environ.includes(`AGENT_WORKSPACE=${ws}\0`)) process.kill(Number(pidDir), "SIGKILL");
      } catch { /* process gone, or unreadable -- fine, skip */ }
    }
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test("ack install (legacy alias) still resolves to the same configure command", () => {
  const result = spawnSync(process.execPath, [ACK, "install", "--help"], { encoding: "utf8" });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /Set up daemon/);
});
