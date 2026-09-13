/**
 * `ack constitution` / `ack policy` — write workspace YAML, then reload if the daemon is up.
 */

import path from "path";
import { runConfigTool } from "../../daemon/src/config-tools.js";
import { EnforcerClient } from "../../../node/src/enforcer/client.js";
import { resolveWorkspace, resolveSocket, resolveAgentByName } from "./workspace.js";

export function workspaceEnforcer(ws) {
  const agent = path.join(ws, ".agent");
  return {
    cfg: {
      WORKSPACE: ws,
      AGENT_DIR: agent,
      HABITS_DIR: process.env.ACK_HABITS_DIR || path.join(agent, "habits"),
      CONSTITUTION: path.join(agent, "constitution.yaml"),
      POLICY_FILE: process.env.ENFORCER_POLICY || path.join(agent, "enforcer.yaml"),
    },
    constitution: {},
    characterHash: null,
    holdEveryNCalls: 5,
    requiredAcks: 2,
    reload() {},
  };
}

function resolveTarget(opts = {}) {
  if (opts.agent) {
    const agent = resolveAgentByName(opts.agent);
    if (!agent) {
      console.error(`No registered agent named '${opts.agent}'.`);
      process.exit(1);
    }
    return { ws: agent.ws, sock: agent.sock };
  }
  return { ws: resolveWorkspace(), sock: resolveSocket() };
}

async function reloadIfUp(sock) {
  const client = new EnforcerClient(sock);
  const res = await client.call("reload", {});
  if (res && !res.error) return res;
  return { skipped: true, error: res?.error || "daemon unreachable" };
}

function mustOk(out) {
  if (!out || out.error) {
    console.error(out?.error || "config write failed");
    process.exit(1);
  }
  return out;
}

export async function runConstitutionShow(opts = {}) {
  const { ws } = resolveTarget(opts);
  const out = mustOk(runConfigTool(workspaceEnforcer(ws), "get_character_config", {}));
  const file = out.constitution_file?.hard_constraints;
  const live = out.live_hard_constraints || [];
  const rows = Array.isArray(file) ? file : live;
  if (opts.json) {
    console.log(JSON.stringify({ workspace: ws, hard_constraints: rows, live, file: out.constitution_file }, null, 2));
    return;
  }
  console.log("Workspace:", ws);
  console.log("hard_constraints:");
  if (!rows.length) console.log("  (none in file — embedded default still includes rm -rf /)");
  for (const p of rows) console.log(" -", p);
}

export async function runConstitutionAdd(pattern, opts = {}) {
  const { ws, sock } = resolveTarget(opts);
  const enforcer = workspaceEnforcer(ws);
  const cur = mustOk(runConfigTool(enforcer, "get_character_config", {}));
  const fromFile = cur.constitution_file?.hard_constraints;
  const fromLive = cur.live_hard_constraints;
  const seed = (Array.isArray(fromFile) && fromFile.length)
    ? fromFile
    : (Array.isArray(fromLive) && fromLive.length)
      ? fromLive
      : ["rm -rf /"];
  const list = [...seed];
  const p = String(pattern || "").trim();
  if (!p) {
    console.error("pattern required");
    process.exit(1);
  }
  if (!list.includes(p)) list.push(p);
  mustOk(runConfigTool(enforcer, "set_character_config", { hard_constraints: list }));
  const reload = await reloadIfUp(sock);
  console.log("Updated hard_constraints:", list.join(", "));
  if (reload.skipped) console.log("Daemon not running — files written; run `ack reload` after start.");
  else if (reload.character_hash) console.log("Reloaded. character_hash:", reload.character_hash);
}

export async function runConstitutionRemove(pattern, opts = {}) {
  const { ws, sock } = resolveTarget(opts);
  const enforcer = workspaceEnforcer(ws);
  const cur = mustOk(runConfigTool(enforcer, "get_character_config", {}));
  const list = [...(cur.constitution_file?.hard_constraints || cur.live_hard_constraints || [])];
  const p = String(pattern || "").trim();
  const next = list.filter((x) => x !== p);
  if (next.length === list.length) {
    console.error("Pattern not in hard_constraints:", p);
    process.exit(1);
  }
  mustOk(runConfigTool(enforcer, "set_character_config", { hard_constraints: next }));
  const reload = await reloadIfUp(sock);
  console.log("Updated hard_constraints:", next.length ? next.join(", ") : "(empty file list)");
  if (reload.skipped) console.log("Daemon not running — files written; run `ack reload` after start.");
}

export async function runPolicyShow(opts = {}) {
  const { ws } = resolveTarget(opts);
  const out = mustOk(runConfigTool(workspaceEnforcer(ws), "get_character_config", {}));
  const pol = out.policy_file || {};
  if (opts.json) {
    console.log(JSON.stringify({ workspace: ws, policy: pol, live_hold_every_n_calls: out.live_hold_every_n_calls, live_required_acks: out.live_required_acks }, null, 2));
    return;
  }
  console.log("Workspace:", ws);
  console.log("deny:", (pol.deny || []).length ? (pol.deny || []).join(", ") : "(none)");
  console.log("allow:", (pol.allow || []).length ? (pol.allow || []).join(", ") : "(none — not in allow-list mode)");
  console.log("hold_every_n_calls:", pol.hold_every_n_calls ?? out.live_hold_every_n_calls ?? 5);
  console.log("required_acks:", pol.required_acks ?? out.live_required_acks ?? 2);
}

async function patchPolicyList(kind, action, pattern, opts) {
  const { ws, sock } = resolveTarget(opts);
  const enforcer = workspaceEnforcer(ws);
  const cur = mustOk(runConfigTool(enforcer, "get_character_config", {}));
  const list = [...(cur.policy_file?.[kind] || [])];
  const p = String(pattern || "").trim();
  if (!p) {
    console.error("pattern required");
    process.exit(1);
  }
  if (action === "add") {
    if (!list.includes(p)) list.push(p);
  } else {
    const next = list.filter((x) => x !== p);
    if (next.length === list.length) {
      console.error(`Pattern not in ${kind}:`, p);
      process.exit(1);
    }
    list.length = 0;
    list.push(...next);
  }
  mustOk(runConfigTool(enforcer, "set_character_config", { [kind]: list }));
  const reload = await reloadIfUp(sock);
  console.log(`Updated ${kind}:`, list.length ? list.join(", ") : "(empty)");
  if (reload.skipped) console.log("Daemon not running — files written; run `ack reload` after start.");
}

export async function runPolicyDenyAdd(pattern, opts = {}) {
  await patchPolicyList("deny", "add", pattern, opts);
}
export async function runPolicyDenyRemove(pattern, opts = {}) {
  await patchPolicyList("deny", "remove", pattern, opts);
}
export async function runPolicyAllowAdd(pattern, opts = {}) {
  await patchPolicyList("allow", "add", pattern, opts);
}
export async function runPolicyAllowRemove(pattern, opts = {}) {
  await patchPolicyList("allow", "remove", pattern, opts);
}

export async function runPolicySet(key, value, opts = {}) {
  const map = {
    "hold-every": "hold_every_n_calls",
    hold_every_n_calls: "hold_every_n_calls",
    "required-acks": "required_acks",
    required_acks: "required_acks",
  };
  const field = map[key];
  if (!field) {
    console.error("Unknown key. Use hold-every or required-acks.");
    process.exit(1);
  }
  const n = parseInt(value, 10);
  if (!Number.isInteger(n) || n < 1) {
    console.error("Value must be a positive integer.");
    process.exit(1);
  }
  const { ws, sock } = resolveTarget(opts);
  mustOk(runConfigTool(workspaceEnforcer(ws), "set_character_config", { [field]: n }));
  const reload = await reloadIfUp(sock);
  console.log(`Updated ${field}:`, n);
  if (reload.skipped) console.log("Daemon not running — files written; run `ack reload` after start.");
}
