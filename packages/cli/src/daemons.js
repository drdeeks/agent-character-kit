/**
 * Enforcer process / socket helpers for ack doctor, repair, and manage.
 */

import fs from "fs";
import os from "os";
import path from "path";
import { spawn, spawnSync } from "child_process";
import { fileURLToPath } from "url";
import { resolveWorkspace, checkDaemon } from "./workspace.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
export const DAEMON_BIN = path.join(REPO_ROOT, "node", "enforcer", "agent_enforcer_daemon.js");

export function findEnforcerDaemons() {
  const out = [];
  try {
    for (const pid of fs.readdirSync("/proc").filter(p => /^\d+$/.test(p))) {
      let cmdline = "";
      try { cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8"); } catch { continue; }
      if (!cmdline.includes("agent_enforcer_daemon.js")) continue;
      let cwd = "";
      try { cwd = fs.readlinkSync(`/proc/${pid}/cwd`); } catch { /* gone */ }
      let workspace = "", socket = "";
      try {
        const env = fs.readFileSync(`/proc/${pid}/environ`, "utf8").split("\0");
        for (const line of env) {
          if (line.startsWith("AGENT_WORKSPACE=")) workspace = line.slice("AGENT_WORKSPACE=".length);
          else if (line.startsWith("ENFORCER_SOCKET=")) socket = line.slice("ENFORCER_SOCKET=".length);
        }
      } catch { /* ignore */ }
      const orphan = workspace && !fs.existsSync(workspace);
      out.push({ pid: parseInt(pid, 10), cwd, workspace, socket, orphan });
    }
  } catch { /* /proc unavailable */ }
  return out;
}

export function findDeadSockets() {
  const dead = [];
  const cands = [
    path.join(resolveWorkspace(), ".agent", "enforcer.sock"),
    path.join(os.homedir(), ".agent-character-kit", "workspace", ".agent", "enforcer.sock"),
  ].concat(process.env.ENFORCER_SOCKET && !process.env.ENFORCER_SOCKET.startsWith("tcp://") ? [process.env.ENFORCER_SOCKET] : []);
  const liveSockets = new Set(findEnforcerDaemons().map(d => d.socket).filter(Boolean));
  for (const s of cands) {
    if (s && fs.existsSync(s) && !liveSockets.has(s)) dead.push(s);
  }
  return dead;
}

export function killDaemonPid(pid) {
  try { process.kill(pid, "SIGKILL"); return true; }
  catch { return false; }
}

export function reviveDaemon(workspace) {
  const sock = path.join(workspace, ".agent", "enforcer.sock");
  const child = spawn(process.execPath, [DAEMON_BIN], {
    env: { ...process.env, AGENT_WORKSPACE: workspace, ENFORCER_SOCKET: sock },
    stdio: "ignore",
    detached: true,
  });
  child.unref();
  return child.pid;
}

export function cleanupStaleResources({ killOrphans = true, removeSockets = true } = {}) {
  const daemons = findEnforcerDaemons();
  let killed = 0, kept = 0;
  for (const d of daemons) {
    if (d.orphan) {
      if (killOrphans) { if (killDaemonPid(d.pid)) killed++; }
      else kept++;
    } else {
      kept++;
    }
  }
  let removedSockets = 0;
  if (removeSockets) {
    for (const s of findDeadSockets()) {
      try { fs.unlinkSync(s); removedSockets++; } catch { /* ignore */ }
    }
  }
  return { killed, kept, removedSockets, daemons };
}

export function isWorkspaceActive(workspace) {
  const habitsDir = path.join(workspace, ".agent", "habits");
  if (!fs.existsSync(habitsDir)) return false;
  return fs.readdirSync(habitsDir).some(f => f.endsWith(".yaml"));
}

export function daemonPidForWorkspace(ws) {
  const match = findEnforcerDaemons().find((d) => d.workspace === ws);
  return match ? match.pid : null;
}

export function stopUserDaemon(ws) {
  const pid = daemonPidForWorkspace(ws);
  if (!pid) return false;
  return killDaemonPid(pid);
}

export function systemctlDaemon(action) {
  console.log(`\nRunning: sudo systemctl ${action} agent-enforcer.service`);
  console.log("(shared by every root-mode agent -- you may be prompted for your sudo password)\n");
  const result = spawnSync("sudo", ["systemctl", action, "agent-enforcer.service"], { stdio: "inherit" });
  return !result.error && result.status === 0;
}

export async function reportDaemonLiveness(sock) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const result = await checkDaemon(sock);
    if (result.alive) {
      console.log("Confirmed alive.");
      return true;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  const final = await checkDaemon(sock);
  console.log(`Did NOT come up: ${final.error || "still unreachable"} -- check the workspace has a constitution.yaml (ack doctor / ack repair).`);
  return false;
}

export function removeAgentFromRegistry(registryPath, ws) {
  try {
    const list = JSON.parse(fs.readFileSync(registryPath, "utf8"));
    const next = Array.isArray(list) ? list.filter((w) => w !== ws) : [];
    fs.writeFileSync(registryPath, JSON.stringify(next, null, 2) + "\n");
    return { ok: true, remaining: next.length };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}
