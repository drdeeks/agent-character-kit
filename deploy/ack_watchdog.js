#!/usr/bin/env node
/**
 * ACK monitor watchdog (self-healing companion, Node-native).
 *
 * Node port of ack_watchdog.py. Revives the acknowledgment monitor
 * (ack_monitor.js) if it dies, and revives the enforcer daemon itself in
 * root-mode installs. This is the self-healing layer: no single process in
 * the daemon/monitor/watchdog trio is a point of failure on its own.
 *
 * Revival order: prefer `systemctl restart <unit>` (idempotent, re-reads the
 * unit). Fall back to a direct launch if systemctl is unavailable (e.g. a
 * container without systemd).
 */

import fs from "fs";
import path from "path";
import os from "os";
import { fileURLToPath } from "url";
import { spawn, spawnSync } from "child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PIDFILE = process.env.ACK_MONITOR_PID || "/var/lib/agent-character-kit/ack-monitor.pid";
const WATCHDOG_PID = process.env.ACK_WATCHDOG_PID || "/var/lib/agent-character-kit/ack-watchdog.pid";
const MONITOR_BIN = process.env.ACK_MONITOR_BIN || path.join(__dirname, "ack_monitor.js");
const MONITOR_UNIT = "agent-character-monitor.service";
const ENFORCER_UNIT = "agent-enforcer.service";
const INTERVAL = parseInt(process.env.ACK_WATCHDOG_INTERVAL || "5", 10) * 1000;

function log(msg) {
  console.log(`${new Date().toISOString()} [ack-watchdog] ${msg}`);
}
function logError(msg) {
  console.error(`${new Date().toISOString()} [ack-watchdog] ${msg}`);
}

function processAlive(pattern, pidfile) {
  try {
    const out = spawnSync("pgrep", ["-af", pattern], { encoding: "utf8", timeout: 5000 });
    const lines = (out.stdout || "").split("\n");
    if (lines.some((l) => l.includes(pattern) && !l.includes("grep"))) return true;
  } catch { /* pgrep unavailable, fall through to pidfile */ }

  if (pidfile) {
    try {
      const pid = parseInt(fs.readFileSync(pidfile, "utf8").trim(), 10);
      if (pid) {
        process.kill(pid, 0); // throws if not alive / no permission
        return true;
      }
    } catch { /* not alive or pidfile missing */ }
  }
  return false;
}

function monitorAlive() {
  return processAlive("ack_monitor.js", PIDFILE);
}
function enforcerAlive() {
  return processAlive("agent_enforcer_daemon.js", null);
}

// systemctl restart of a root-owned unit only makes sense (and only
// succeeds) when this watchdog itself is root — true only for a real
// root-mode deploy. In a user-mode install the unit was never installed, so
// calling systemctl here can never succeed; it would just fail (or prompt
// for a password via polkit) on every interval forever.
function isRoot() {
  return typeof process.getuid === "function" && process.getuid() === 0;
}

function systemctlRestart(unit) {
  try {
    const r = spawnSync("systemctl", ["restart", unit], { timeout: 10000 });
    return r.status === 0;
  } catch (exc) {
    logError(`systemctl restart ${unit} failed: ${exc.message}`);
    return false;
  }
}

function reviveMonitor() {
  log("monitor not alive -> restarting");
  if (isRoot() && systemctlRestart(MONITOR_UNIT)) return;
  try {
    const child = spawn("node", [MONITOR_BIN], {
      env: process.env,
      detached: true,
      stdio: "ignore",
    });
    child.unref();
  } catch (exc) {
    logError(`direct monitor launch failed: ${exc.message}`);
  }
}

function reviveEnforcer() {
  if (!isRoot()) {
    // User-mode has no enforcer supervisor by design (see AGENTS.md
    // Fail-closed guarantees) -- warn once per detection instead of
    // retrying a systemctl call against a unit that was never installed.
    logError(
      `enforcer not alive, but this is a user-mode install (no root) -- skipping ` +
      `systemctl restart of ${ENFORCER_UNIT}, it was never installed here. ` +
      `Re-run 'ack install' to relaunch the daemon directly, or use root-mode ` +
      `for automatic revival.`
    );
    return;
  }
  log("enforcer not alive -> restarting");
  if (!systemctlRestart(ENFORCER_UNIT)) {
    logError(`systemctl restart of ${ENFORCER_UNIT} failed`);
  }
  // No direct fallback for enforcer here (it's managed by systemd in root-mode).
}

function main() {
  try {
    fs.mkdirSync(path.dirname(WATCHDOG_PID), { recursive: true });
    fs.writeFileSync(WATCHDOG_PID, String(process.pid));
  } catch (exc) {
    logError(`could not write pidfile ${WATCHDOG_PID}: ${exc.message}`);
  }
  log(`watchdog started (interval=${INTERVAL / 1000}s) — monitoring monitor + enforcer`);

  const tick = () => {
    if (!monitorAlive()) reviveMonitor();
    if (!enforcerAlive()) reviveEnforcer();
  };
  tick();
  setInterval(tick, INTERVAL);
}

main();
