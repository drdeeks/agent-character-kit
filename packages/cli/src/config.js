/**
 * `ack config` show / verify / set / write-env.
 */

import fs from "fs";
import path from "path";
import {
  resolveWorkspace,
  resolveSocket,
  resolveAckLog,
  readWorkspacesRegistry,
  resolveAgentByName,
  verifyAgentReport,
} from "./workspace.js";

export function runConfigShow(opts) {
  if (opts.agent) {
    const agent = resolveAgentByName(opts.agent);
    if (!agent) {
      console.error(`No registered agent named '${opts.agent}'. Run 'ack config show' with no --agent to see the registry.`);
      process.exit(1);
    }
    console.log(`Agent: ${opts.agent}`);
    console.log("AGENT_WORKSPACE:", agent.ws);
    console.log("ENFORCER_SOCKET:", agent.sock);
    console.log("ACK_ACK_LOG:", agent.ackLog);
    return;
  }
  console.log("AGENT_WORKSPACE:", resolveWorkspace());
  console.log("ENFORCER_SOCKET:", resolveSocket());
  console.log("ACK_ACK_LOG:", resolveAckLog());
  console.log("");
  console.log("Environment (where set):");
  for (const key of ["AGENT_WORKSPACE", "ENFORCER_SOCKET", "ACK_ACK_LOG", "ACK_HABITS_DIR"]) {
    console.log(`  ${key}: ${process.env[key] || "(unset — using default)"}`);
  }
  const { registryPath, agents } = readWorkspacesRegistry();
  if (registryPath) {
    console.log("");
    console.log(`Registered agents (${agents.length}, registry: ${registryPath}):`);
    for (const ws of agents) {
      console.log(`  ${path.basename(ws)}  ->  ${ws}`);
    }
    console.log("Use --agent <name> to show that agent's resolved paths specifically.");
  }
}

export async function runConfigVerify(opts) {
  if (opts.agent) {
    const agent = resolveAgentByName(opts.agent);
    if (!agent) {
      console.error(`No registered agent named '${opts.agent}'.`);
      process.exit(1);
    }
    await verifyAgentReport(agent.ws, agent.sock, agent.ackLog, null);
    return;
  }

  const { registryPath, agents } = readWorkspacesRegistry();
  if (registryPath && agents.length) {
    for (const ws of agents) {
      const name = path.basename(ws);
      await verifyAgentReport(ws, path.join(ws, ".agent", `${name}.sock`), path.join(ws, ".agent", "ack.jsonl"), `agent: ${name}`);
    }
    return;
  }
  await verifyAgentReport(resolveWorkspace(), resolveSocket(), resolveAckLog(), null);
}

export function runConfigSet(key, value) {
  const envMap = {
    workspace: "AGENT_WORKSPACE",
    socket: "ENFORCER_SOCKET",
    "ack-log": "ACK_ACK_LOG",
  };
  const envKey = envMap[key];
  if (!envKey) {
    console.error(`Unknown key: ${key} (use: workspace, socket, ack-log)`);
    process.exit(1);
  }
  console.log(`export ${envKey}=${value}`);
  console.log(`Add the above to your shell profile or .env file.`);
}

export function runConfigWriteEnv(file, opts) {
  let ws, sock, ackLogPath;
  if (opts.agent) {
    const agent = resolveAgentByName(opts.agent);
    if (!agent) {
      console.error(`No registered agent named '${opts.agent}'.`);
      process.exit(1);
    }
    ({ ws, sock, ackLog: ackLogPath } = agent);
  } else {
    ws = resolveWorkspace();
    sock = resolveSocket();
    ackLogPath = resolveAckLog();
  }
  const target = file ? path.resolve(file) : path.join(ws, ".env");
  const lines = [
    `AGENT_WORKSPACE=${ws}`,
    `ENFORCER_SOCKET=${sock}`,
    `ACK_ACK_LOG=${ackLogPath}`,
  ];
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, lines.join("\n") + "\n");
  console.log("Wrote .env to:", target);
}
