/**
 * `ack doctor` — read-only diagnostic report.
 */

import fs from "fs";
import path from "path";
import { VERSION } from "../../../node/src/index.js";
import { section, check, warn } from "./report.js";
import {
  resolveWorkspace,
  resolveSocket,
  resolveAckLog,
  checkDaemon,
  checkAllSockets,
} from "./workspace.js";
import { findEnforcerDaemons, findDeadSockets } from "./daemons.js";

export async function runDoctor() {
  const ws = resolveWorkspace();
  const habitsDir = path.join(ws, ".agent", "habits");
  const constitution = path.join(ws, ".agent", "constitution.yaml");
  const ackLogPath = resolveAckLog();
  const sock = resolveSocket();

  let passed = 0;
  let total = 0;

  function c(label, ok, detail) {
    total++;
    if (ok) passed++;
    check(label, ok, detail);
  }

  console.log("\n==========================================");
  console.log("   ACK DOCTOR — Full Diagnostic Report");
  console.log("==========================================");

  section("Version & Environment");
  c("Node.js >= 18", parseFloat(process.version.slice(1)) >= 18, process.version);
  c("Platform", true, `${process.platform} ${process.arch}`);

  const envKeys = ["AGENT_WORKSPACE", "ENFORCER_SOCKET", "ACK_ACK_LOG", "ACK_HABITS_DIR"];
  for (const key of envKeys) {
    if (process.env[key]) {
      check(true, `env ${key}=${process.env[key]}`);
    } else {
      warn(`env ${key} (unset — using default resolution)`);
    }
  }

  section("Workspace Integrity");
  c("Workspace directory exists", fs.existsSync(ws), ws);
  c("Habits directory exists", fs.existsSync(habitsDir), habitsDir);
  c("Constitution file exists", fs.existsSync(constitution), constitution);

  const enforcerYaml = path.join(ws, ".agent", "enforcer.yaml");
  c("Enforcer config exists", fs.existsSync(enforcerYaml), enforcerYaml);
  if (!fs.existsSync(enforcerYaml)) {
    warn("No enforcer.yaml — daemon uses embedded defaults");
  }

  if (fs.existsSync(habitsDir)) {
    const habitFiles = fs.readdirSync(habitsDir).filter(f => f.endsWith(".yaml"));
    c("Habits present", habitFiles.length >= 5, `${habitFiles.length} YAML files`);

    let validCount = 0;
    let invalidCount = 0;
    for (const f of habitFiles.slice(0, 30)) {
      try {
        const content = fs.readFileSync(path.join(habitsDir, f), "utf8");
        const hasName = /^name:\s*"?\S/m.test(content);
        const hasPrompt = /^prompt:\s*"?\S/m.test(content);
        const hasLogic = /\blogic\b/.test(content);
        if (hasName && hasPrompt) validCount++;
        else invalidCount++;
      } catch { invalidCount++; }
    }
    if (invalidCount > 0) {
      warn(`${invalidCount} habit files have missing required fields (name/prompt)`);
    }
  }

  section("Daemon Connectivity");

  if (sock.startsWith("tcp://")) {
    check(true, "TCP transport configured — no local socket file", sock);
  } else {
    c(`Socket file exists`, fs.existsSync(sock), sock);
  }

  const daemon = await checkDaemon(sock);
  if (daemon.alive) {
    c("Daemon reachable", true, sock);
    if (daemon.workspace) check(true, "Daemon reports workspace", daemon.workspace);
    if (typeof daemon.habits === "number") {
      c(`Daemon has ${daemon.habits} habits indexed`, daemon.habits >= 5);
    }
    if (daemon.version) {
      c(`Daemon version matches CLI`, daemon.version === VERSION,
        `daemon=${daemon.version} cli=${VERSION}`);
    }
  } else {
    c("Daemon reachable", false, `${daemon.error || "unreachable"}`);
    warn("Start daemon: `sudo systemctl start agent-enforcer` (root) or `ack configure --yes` (user)");
  }

  const { results: endpoints } = await checkAllSockets();
  const aliveCount = Object.values(endpoints).filter(e => e.alive).length;
  if (aliveCount > 0) {
    check(true, `${aliveCount}/${Object.keys(endpoints).length} endpoints alive`);
  } else {
    const anyConfigured = Object.values(endpoints).filter(e => e.checked).length;
    if (anyConfigured > 0) {
      c("Any endpoint alive", false, "No running daemon found on any socket path");
    }
  }

  section("Stale Resources (cleanup guard)");
  const staleDaemons = findEnforcerDaemons();
  if (staleDaemons.length === 0) {
    check(true, "No orphaned enforcer daemons");
  } else {
    let orphans = 0;
    for (const d of staleDaemons) {
      if (d.orphan) {
        orphans++;
        warn(`Orphan daemon pid ${d.pid}`, `workspace gone: ${d.workspace || "(none)"} — run 'ack repair daemon' to clean`);
      }
    }
    const live = staleDaemons.length - orphans;
    c(`Enforcer daemons running`, live >= 1, `${live} live, ${orphans} orphaned`);
  }
  const deadSocks = findDeadSockets();
  if (deadSocks.length === 0) {
    check("No dead socket files", true);
  } else {
    c("Dead socket files present", false, `${deadSocks.length} — run 'ack repair daemon' to remove`);
    for (const s of deadSocks) warn(`  stale socket: ${s}`);
  }

  section("Ack Log");
  c("Ack log exists", fs.existsSync(ackLogPath), ackLogPath);
  if (fs.existsSync(ackLogPath)) {
    try {
      const lines = fs.readFileSync(ackLogPath, "utf8").split("\n").filter(Boolean);
      c("Ack log has entries", lines.length > 0, `${lines.length} entries`);
      if (lines.length > 0) {
        try {
          JSON.parse(lines[lines.length - 1]);
          check(true, "Last ack log entry valid JSON");
        } catch {
          check(false, "Last ack log entry valid JSON");
        }
      }
    } catch (e) {
      check(false, `Read ack log — ${e.message}`);
    }
  }

  section("Monitor & Watchdog");
  const monitorPidFile = path.join(ws, ".agent", "ack-monitor.pid");
  const watchdogPidFile = path.join(ws, ".agent", "ack-watchdog.pid");

  if (fs.existsSync(monitorPidFile)) {
    const pid = parseInt(fs.readFileSync(monitorPidFile, "utf8").trim());
    try {
      process.kill(pid, 0);
      c("Ack monitor alive", true, `pid ${pid}`);
    } catch {
      c("Ack monitor alive", false, `pid ${pid} not running`);
    }
  } else {
    warn("No monitor pidfile (user-mode may use different tracking)");
  }

  if (fs.existsSync(watchdogPidFile)) {
    const pid = parseInt(fs.readFileSync(watchdogPidFile, "utf8").trim());
    try {
      process.kill(pid, 0);
      c("Watchdog alive", true, `pid ${pid}`);
    } catch {
      c("Watchdog alive", false, `pid ${pid} not running`);
    }
  } else {
    warn("No watchdog pidfile (user-mode may use different tracking)");
  }

  section("Config Resolution Chain");
  console.log("  AGENT_WORKSPACE  →", ws);
  console.log("  ENFORCER_SOCKET  →", sock);
  console.log("  ACK_ACK_LOG      →", ackLogPath);
  console.log("  habits dir       →", habitsDir);
  console.log("  constitution     →", constitution);

  const pct = total > 0 ? Math.round((passed / total) * 100) : 0;
  console.log("\n==========================================");
  console.log(`   ${passed}/${total} checks passed (${pct}%)`);
  if (pct < 100) {
    console.log("   Run `ack repair` to auto-fix what can be fixed.");
    console.log("   Run `ack doctor 2>&1 | grep -E \"FAIL|WARN\"` to see only issues.");
  } else {
    console.log("   All systems nominal.");
  }
  console.log("==========================================\n");
}
