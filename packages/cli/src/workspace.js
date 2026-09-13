/**
 * Shared workspace / socket / registry helpers for ack CLI commands.
 */

import fs from "fs";
import os from "os";
import path from "path";
import { EnforcerClient } from "../../../node/src/enforcer/client.js";

export function resolveWorkspace() {
  return process.env.AGENT_WORKSPACE ||
    path.join(os.homedir(), ".agent-character-kit", "workspace");
}

export function resolveSocket() {
  return process.env.ENFORCER_SOCKET ||
    (process.env.AGENT_WORKSPACE
      ? path.join(process.env.AGENT_WORKSPACE, ".agent", "enforcer.sock")
      : path.join(os.homedir(), ".agent-character-kit", "workspace", ".agent", "enforcer.sock"));
}

export function looksNeverConfigured() {
  const rootSocketExists = fs.existsSync("/run/agent-enforcer/main.sock");
  const defaultWs = path.join(os.homedir(), ".agent-character-kit", "workspace");
  const defaultWsConfigured = fs.existsSync(path.join(defaultWs, ".agent", "constitution.yaml"));
  const envWsConfigured = process.env.AGENT_WORKSPACE &&
    fs.existsSync(path.join(process.env.AGENT_WORKSPACE, ".agent", "constitution.yaml"));
  return !rootSocketExists && !defaultWsConfigured && !envWsConfigured;
}

export const FIRST_RUN_NUDGE =
  "No Agent Character Kit setup found on this machine yet.\n" +
  "Run `ack configure` for a guided, interactive setup (asks about root vs\n" +
  "user mode, which harness(es) you use, and confirms before touching\n" +
  "anything -- nothing runs without you saying yes at each step).\n" +
  "Or `ack configure --yes` for a fast, non-interactive default (user-mode,\n" +
  "generic harness, no daemon auto-started).\n";

export function resolveAckLog() {
  return process.env.ACK_ACK_LOG ||
    path.join(resolveWorkspace(), ".agent", "ack.jsonl");
}

export async function checkDaemon(socketPath = resolveSocket()) {
  return new Promise((resolve) => {
    const client = new EnforcerClient(socketPath);
    let attempts = 0;
    const tryCall = () => {
      client.call("status", {}).then(res => {
        if (!res || res.error) {
          if (res?.error === "invalid request" && attempts < 1) {
            attempts++;
            setTimeout(tryCall, 50);
            return;
          }
          resolve({ alive: false, error: res?.error });
        } else {
          resolve({ alive: true, ...res });
        }
      }).catch(err => resolve({ alive: false, error: err.message }));
    };
    tryCall();
    setTimeout(() => resolve({ alive: false, error: "timeout" }), 3000);
  });
}

export function readWorkspacesRegistry() {
  const candidates = [
    process.env.ACK_WORKSPACES_REGISTRY,
    "/var/lib/agent-character-kit/workspaces.json",
    path.join(os.homedir(), ".agent-character-kit", "workspaces.json"),
  ].filter(Boolean);
  for (const rp of candidates) {
    try {
      if (fs.existsSync(rp)) {
        const list = JSON.parse(fs.readFileSync(rp, "utf8"));
        if (Array.isArray(list) && list.length) return { registryPath: rp, agents: list };
      }
    } catch { /* best-effort */ }
  }
  return { registryPath: null, agents: [] };
}

export function resolveAgentByName(name) {
  const { agents } = readWorkspacesRegistry();
  const match = agents.find((ws) => path.basename(ws) === name);
  if (!match) return null;
  return {
    ws: match,
    sock: path.join(match, ".agent", `${name}.sock`),
    ackLog: path.join(match, ".agent", "ack.jsonl"),
  };
}

export async function checkAllSockets() {
  const results = {};
  const candidates = [
    { name: "user workspace", path: path.join(resolveWorkspace(), ".agent", "enforcer.sock") },
    { name: "env ENFORCER_SOCKET", path: resolveSocket() },
  ];

  const { registryPath, agents } = readWorkspacesRegistry();
  if (agents.length) {
    for (const ws of agents) {
      const name = path.basename(ws);
      candidates.push({ name: `agent: ${name}`, path: path.join(ws, ".agent", `${name}.sock`), ws });
    }
  } else {
    candidates.unshift({ name: "root (systemd)", path: "/run/agent-enforcer/main.sock" });
  }

  for (const c of candidates) {
    if (!c.path) {
      results[c.name] = { checked: false, reason: "not configured" };
      continue;
    }
    const r = await checkDaemon(c.path);
    results[c.name] = { path: c.path, checked: true, ws: c.ws, ...r };
  }
  return { results, registryPath };
}

export async function verifyAgentReport(ws, sock, ackLogPath, label) {
  if (label) console.log(`\n=== ${label} ===`);
  const habitsDir = path.join(ws, ".agent", "habits");
  const constitution = path.join(ws, ".agent", "constitution.yaml");
  console.log("Workspace:", ws, fs.existsSync(ws) ? "✓" : "✗");
  console.log("  habits:", fs.existsSync(habitsDir) ? "✓" : "✗");
  console.log("  constitution:", fs.existsSync(constitution) ? "✓" : "✗");
  console.log("Socket:", sock);
  const daemon = await checkDaemon(sock);
  console.log("  daemon:", daemon.alive ? "✓ reachable" : `✗ ${daemon.error || "unreachable"}`);
  console.log("Ack log:", ackLogPath, fs.existsSync(ackLogPath) ? "✓" : "✗");
  return { daemonAlive: daemon.alive };
}
