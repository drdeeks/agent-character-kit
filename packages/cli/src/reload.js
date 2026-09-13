/**
 * `ack reload` — ask the running daemon to re-read constitution/habits/policy.
 */

import { EnforcerClient } from "../../../node/src/enforcer/client.js";
import { resolveSocket, resolveAgentByName } from "./workspace.js";

export async function runReload(opts = {}) {
  let sock = resolveSocket();
  if (opts.agent) {
    const agent = resolveAgentByName(opts.agent);
    if (!agent) {
      console.error(`No registered agent named '${opts.agent}'.`);
      process.exit(1);
    }
    sock = agent.sock;
  }
  const client = new EnforcerClient(sock);
  const res = await client.call("reload", {});
  if (!res || res.error) {
    console.error("Reload failed:", res?.error || "no response");
    console.error("Start the daemon (`ack configure --yes` or `sudo systemctl start agent-enforcer`) then retry.");
    process.exit(1);
  }
  if (opts.json) {
    console.log(JSON.stringify(res));
    return;
  }
  console.log("Reloaded constitution/habits/policy.");
  if (res.character_hash) console.log("character_hash:", res.character_hash);
}
