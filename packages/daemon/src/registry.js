/**
 * Multi-workspace registry (same path priority as ack status/doctor).
 */

import fs from "fs";
import fssync from "fs";
import path from "path";

export function resolveWorkspaces() {
  const primary = process.env.AGENT_WORKSPACE
    || path.join(process.env.HOME || "/root", ".agent-character-kit", "workspace");
  const workspaces = new Set([primary]);

  // AGENT_WORKSPACES = comma-separated additional workspace paths
  const extra = process.env.AGENT_WORKSPACES;
  if (extra) {
    for (const ws of extra.split(",").map((s) => s.trim()).filter(Boolean)) {
      workspaces.add(path.resolve(ws));
    }
  }

  // Registry file (JSON array of agent workspace paths). Priority:
  //   1. ACK_WORKSPACES_REGISTRY -- explicit override.
  //   2. /var/lib/agent-character-kit/workspaces.json -- the real location
  //      for root/service-user mode. A HOME-based path doesn't work there:
  //      a --no-create-home service user has no HOME at all, and even if
  //      it did, /root/ isn't readable by a non-root service user anyway.
  //      /var/lib/agent-character-kit/ is already owned by whichever
  //      service user deploy-agent-enforcer.sh set up, so both the
  //      deploying root process and the running daemon can reach it.
  //   3. $HOME/.agent-character-kit/workspaces.json -- unchanged, plain
  //      user-mode default (same-uid daemon, real HOME available).
  const registryPath = process.env.ACK_WORKSPACES_REGISTRY
    || (fs.existsSync("/var/lib/agent-character-kit/workspaces.json")
      ? "/var/lib/agent-character-kit/workspaces.json"
      : path.join(process.env.HOME || "/root", ".agent-character-kit", "workspaces.json"));
  let hasRegistry = false;
  try {
    if (fs.existsSync(registryPath)) {
      // hasRegistry is set only after a successful read+parse, not on mere
      // existence. A root-owned registry from an unrelated root/service-user
      // deploy is unreadable (EACCES) to a plain user -- that's not "this
      // user has a multi-agent registry," it's "no registry applies to me."
      // Treating existence alone as hasRegistry=true forced single-workspace
      // user-mode installs into multi-workspace socket naming
      // (path.basename(ws) => the literal string "workspace", not an agent
      // name), which nothing in ack.js's status/liveness checks looks for.
      const list = JSON.parse(fs.readFileSync(registryPath, "utf8"));
      hasRegistry = true;
      if (Array.isArray(list)) {
        for (const ws of list) {
          if (typeof ws === "string" && ws.trim()) workspaces.add(path.resolve(ws.trim()));
        }
      }
    }
  } catch (e) {
    if (e.code !== "EACCES") {
      console.error(`Warning: registry at ${registryPath} exists but could not be read/parsed (${e.code || e.message}) -- treating as absent.`);
    }
  }

  // hasRegistry forces multi-workspace mode even with exactly one agent so
  // far, not just "more than one" -- root/service-user deploys always
  // create this registry (deploy-agent-enforcer.sh), so a real
  // registry-backed deploy gets consistent agent-named sockets from the
  // very first agent onward. Without this, agent #1 would get the old
  // generic socket name via single-workspace mode, then have its socket
  // path silently change out from under it the moment agent #2 got added
  // and multi-workspace mode kicked in for the first time.
  return { list: [...workspaces], hasRegistry };
}

export function registerWorkspace(wsPath) {
  if (!wsPath || typeof wsPath !== "string") return { ok: false, error: "workspace path required" };
  const absWs = path.resolve(wsPath);
  const agentDir = path.join(absWs, ".agent");
  try { fssync.mkdirSync(path.join(agentDir, "habits"), { recursive: true }); } catch {}

  // Add to registry file
  const registryPath = path.join(process.env.HOME || "/root", ".agent-character-kit", "workspaces.json");
  try {
    let list = [];
    if (fs.existsSync(registryPath)) {
      list = JSON.parse(fs.readFileSync(registryPath, "utf8"));
      if (!Array.isArray(list)) list = [];
    }
    if (!list.includes(absWs)) {
      list.push(absWs);
      fssync.mkdirSync(path.dirname(registryPath), { recursive: true });
      fs.writeFileSync(registryPath, JSON.stringify(list, null, 2) + "\n");
    }
  } catch { /* best-effort */ }

  return { ok: true, workspace: absWs, message: "workspace registered — restart daemon to serve it" };
}
