// Pure, directly-testable menu logic for `ack manage` -- kept separate from
// the readline/console.log orchestration in bin/ack.js so agent-list
// building and choice parsing can be unit tested without a real interactive
// stdin session. Same reasoning as parseHarnessMenuChoice in bin/install.js.

import path from "path";

// Builds the list of agents to show in the manage menu: registry-backed
// entries when a registry exists (each agent's sock/ackLog computed with the
// same <workspace>/.agent/<name>.{sock,jsonl} formula the daemon and
// `ack config show --agent` already use), otherwise exactly one "default"
// entry pointing at the single-workspace resolution. rootMode is derived
// from the registry path itself (/var/lib/... only ever exists for a root
// deploy -- see deploy-agent-enforcer.sh) since root-mode agents share ONE
// systemd-managed daemon, not one process per agent.
export function buildAgentList({ registryPath, registryAgents, defaultWs, defaultSock, defaultAckLog }) {
  if (registryPath && registryAgents && registryAgents.length) {
    const rootMode = registryPath.startsWith("/var/lib");
    return registryAgents.map((ws) => {
      const name = path.basename(ws);
      return {
        name,
        ws,
        sock: path.join(ws, ".agent", `${name}.sock`),
        ackLog: path.join(ws, ".agent", "ack.jsonl"),
        rootMode,
      };
    });
  }
  return [{
    name: "default",
    ws: defaultWs,
    sock: defaultSock,
    ackLog: defaultAckLog,
    rootMode: false,
  }];
}

// Top-level menu: pick an agent by number, add a new one, refresh the list
// (re-checks daemon liveness), or quit. agentCount bounds valid picks.
export function parseMainMenuChoice(raw, agentCount) {
  const s = (raw ?? "").trim().toLowerCase();
  if (s === "" || s === "q" || s === "quit" || s === "exit") return { action: "quit" };
  if (s === "a" || s === "add") return { action: "add" };
  if (s === "r" || s === "refresh") return { action: "refresh" };
  const n = parseInt(s, 10);
  if (String(n) === s && n >= 1 && n <= agentCount) {
    return { action: "select", index: n - 1 };
  }
  return { action: "invalid", raw };
}

// Per-agent submenu: view/change everything scoped to one agent.
export function parseAgentMenuChoice(raw) {
  const s = (raw ?? "").trim().toLowerCase();
  const map = {
    "1": "status",
    "2": "habits",
    "3": "habit-create",
    "4": "habit-delete",
    "5": "daemon-start",
    "6": "daemon-stop",
    "7": "daemon-restart",
    "8": "reconfigure",
    "9": "remove",
    "b": "back",
    "back": "back",
    "": "back",
    "q": "quit",
    "quit": "quit",
  };
  const action = map[s];
  return action ? { action } : { action: "invalid", raw };
}
