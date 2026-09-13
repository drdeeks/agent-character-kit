/**
 * `ack manage` — interactive per-agent menu.
 */

import fs from "fs";
import path from "path";
import { spawnSync } from "child_process";
import { fileURLToPath } from "url";
import { normalizeHabitName } from "../../../node/src/habits/build.js";
import { ask } from "./ask.js";
import { createHabitInteractive, listHabitsForWorkspace } from "./habit.js";
import {
  resolveWorkspace,
  resolveSocket,
  resolveAckLog,
  checkDaemon,
  readWorkspacesRegistry,
  verifyAgentReport,
} from "./workspace.js";
import {
  reviveDaemon,
  stopUserDaemon,
  systemctlDaemon,
  reportDaemonLiveness,
  removeAgentFromRegistry,
} from "./daemons.js";
import { buildAgentList, parseMainMenuChoice, parseAgentMenuChoice } from "../../../node/src/manage-menu.js";

const ACK_BIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "node", "bin", "ack.js");

export async function runManage() {
  while (true) {
    const { registryPath, agents: registryAgents } = readWorkspacesRegistry();
    const agents = buildAgentList({
      registryPath,
      registryAgents,
      defaultWs: resolveWorkspace(),
      defaultSock: resolveSocket(),
      defaultAckLog: resolveAckLog(),
    });

    console.log("\n=== Agent Character Kit — Manage ===\n");
    for (let i = 0; i < agents.length; i++) {
      const a = agents[i];
      const daemon = await checkDaemon(a.sock);
      const state = daemon.alive ? "🟢 alive" : "🔴 dead";
      console.log(`  ${i + 1}) ${a.name.padEnd(20)} ${state}   ${a.ws}`);
    }
    console.log(`  A) Add new agent (runs 'ack configure')`);
    console.log(`  R) Refresh`);
    console.log(`  Q) Quit`);

    const raw = await ask("\nChoice: ");
    const choice = parseMainMenuChoice(raw, agents.length);

    if (choice.action === "quit") return;
    if (choice.action === "refresh") continue;
    if (choice.action === "invalid") {
      console.log(`"${choice.raw}" isn't a valid choice.`);
      continue;
    }
    if (choice.action === "add") {
      spawnSync(process.execPath, [ACK_BIN, "configure"], { stdio: "inherit" });
      continue;
    }
    await runAgentMenu(agents[choice.index]);
  }
}

export async function runAgentMenu(agent) {
  while (true) {
    console.log(`\n=== agent: ${agent.name} ${agent.rootMode ? "(root-mode, shared daemon)" : "(user-mode)"} ===`);
    console.log("Workspace:", agent.ws);
    console.log("Socket:", agent.sock);
    const daemon = await checkDaemon(agent.sock);
    console.log("Daemon:", daemon.alive ? "🟢 alive" : "🔴 dead");
    const habits = listHabitsForWorkspace(agent.ws, { print: false });
    console.log("Habits:", habits.length);

    console.log("");
    console.log("  1) Full status report");
    console.log("  2) List habits");
    console.log("  3) Create habit");
    console.log("  4) Delete habit");
    console.log(`  5) Start daemon${daemon.alive ? "  (already running)" : ""}`);
    console.log(`  6) Stop daemon${!daemon.alive ? "   (not running)" : ""}`);
    console.log("  7) Restart daemon");
    console.log("  8) Re-run configure for this agent");
    console.log(`  9) Remove agent from registry${agent.rootMode === false && agent.name === "default" ? "  (n/a -- not registry-backed)" : ""}`);
    console.log("  B) Back");
    console.log("  Q) Quit");

    const raw = await ask("\nChoice: ");
    const choice = parseAgentMenuChoice(raw);

    if (choice.action === "invalid") {
      console.log(`"${choice.raw}" isn't a valid choice.`);
      continue;
    }
    if (choice.action === "back") return;
    if (choice.action === "quit") process.exit(0);

    if (choice.action === "status") {
      await verifyAgentReport(agent.ws, agent.sock, agent.ackLog, null);
    } else if (choice.action === "habits") {
      listHabitsForWorkspace(agent.ws);
    } else if (choice.action === "habit-create") {
      await createHabitInteractive(agent.ws, undefined, {});
    } else if (choice.action === "habit-delete") {
      const rows = listHabitsForWorkspace(agent.ws);
      if (rows.length === 0) continue;
      const pick = (await ask("Habit name to delete (blank to cancel): ")).trim();
      if (!pick) continue;
      const fileName = normalizeHabitName(pick);
      const file = path.join(agent.ws, ".agent", "habits", `${fileName}.yaml`);
      if (!fs.existsSync(file)) {
        console.log("No such habit:", file);
        continue;
      }
      const confirmed = (await ask(`Delete ${file}? [y/N] `)).trim().toLowerCase();
      if (confirmed === "y" || confirmed === "yes") {
        fs.unlinkSync(file);
        console.log("Deleted:", file);
      } else {
        console.log("Cancelled.");
      }
    } else if (choice.action === "daemon-start") {
      if (daemon.alive) {
        console.log("Already running.");
      } else if (agent.rootMode) {
        systemctlDaemon("start");
        await reportDaemonLiveness(agent.sock);
      } else {
        const pid = reviveDaemon(agent.ws);
        console.log(`Spawned daemon (pid ${pid}) -- checking it actually came up...`);
        await reportDaemonLiveness(agent.sock);
      }
    } else if (choice.action === "daemon-stop") {
      if (!daemon.alive) {
        console.log("Not running.");
      } else if (agent.rootMode) {
        systemctlDaemon("stop");
      } else {
        console.log(stopUserDaemon(agent.ws) ? "Stopped." : "Could not find/stop the daemon process.");
      }
    } else if (choice.action === "daemon-restart") {
      if (agent.rootMode) {
        systemctlDaemon("restart");
        await reportDaemonLiveness(agent.sock);
      } else {
        if (daemon.alive) stopUserDaemon(agent.ws);
        const pid = reviveDaemon(agent.ws);
        console.log(`Spawned daemon (pid ${pid}) -- checking it actually came up...`);
        await reportDaemonLiveness(agent.sock);
      }
    } else if (choice.action === "reconfigure") {
      console.log(`\nLaunching 'ack configure' -- when it asks for a workspace path, use:\n  ${agent.ws}\n`);
      spawnSync(process.execPath, [ACK_BIN, "configure", "--workspace", agent.ws], { stdio: "inherit" });
    } else if (choice.action === "remove") {
      const { registryPath } = readWorkspacesRegistry();
      if (!registryPath) {
        console.log("Not registry-backed -- nothing to remove.");
        continue;
      }
      const confirmed = (await ask(`Remove '${agent.name}' (${agent.ws}) from the registry? [y/N] `)).trim().toLowerCase();
      if (confirmed !== "y" && confirmed !== "yes") {
        console.log("Cancelled.");
        continue;
      }
      const result = removeAgentFromRegistry(registryPath, agent.ws);
      if (!result.ok) {
        console.log(`Could not update registry: ${result.error}`);
        if (agent.rootMode) console.log(`Root-mode registry is likely owned by root -- try: sudo -e ${registryPath}`);
        continue;
      }
      console.log(`Removed. ${result.remaining} agent(s) remain in the registry.`);
      if (daemon.alive) {
        console.log("The daemon still has this workspace loaded from when it started.");
        const restart = (await ask("Restart the daemon now so it stops serving this agent? [y/N] ")).trim().toLowerCase();
        if (restart === "y" || restart === "yes") {
          if (agent.rootMode) systemctlDaemon("restart");
          else { stopUserDaemon(agent.ws); }
        }
      }
      return;
    }
  }
}
