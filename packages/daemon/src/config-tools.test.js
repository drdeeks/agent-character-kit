import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { runConfigTool } from "./config-tools.js";
import { handleMcpJsonRpc } from "./mcp-http.js";

function makeEnforcer(ws) {
  const agent = path.join(ws, ".agent");
  return {
    cfg: {
      WORKSPACE: ws,
      AGENT_DIR: agent,
      HABITS_DIR: path.join(agent, "habits"),
      CONSTITUTION: path.join(agent, "constitution.yaml"),
      POLICY_FILE: path.join(agent, "enforcer.yaml"),
    },
    constitution: { hard_constraints: ["rm -rf /"] },
    characterHash: "before",
    holdEveryNCalls: 5,
    requiredAcks: 2,
    reload() { this.characterHash = "after"; },
  };
}

describe("config MCP tools", () => {
  it("writes a habit, patches constitution/policy, then reloads", () => {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), "ack-cfg-"));
    const enforcer = makeEnforcer(ws);
    const wrote = runConfigTool(enforcer, "write_habit", {
      name: "no-force-push",
      prompt: "Did I force-push?",
      logic: "Force-push rewrites shared history.",
      evidence: "git push had no --force.",
      level: "must",
    });
    assert.equal(wrote.ok, true);
    assert.equal(enforcer.characterHash, "after");
    const listed = runConfigTool(enforcer, "list_habits", {});
    assert.equal(listed.habits.length, 1);
    assert.equal(listed.habits[0].name, "no_force_push");

    const set = runConfigTool(enforcer, "set_character_config", {
      hard_constraints: ["rm -rf /", "DROP TABLE"],
      deny: ["chmod 777"],
      hold_every_n_calls: 7,
      required_acks: 3,
    });
    assert.equal(set.ok, true);
    const got = runConfigTool(enforcer, "get_character_config", {});
    assert.deepEqual(got.constitution_file.hard_constraints, ["rm -rf /", "DROP TABLE"]);
    assert.deepEqual(got.policy_file.deny, ["chmod 777"]);
    assert.equal(got.policy_file.hold_every_n_calls, 7);
    assert.equal(got.policy_file.required_acks, 3);

    const del = runConfigTool(enforcer, "delete_habit", { name: "no_force_push" });
    assert.equal(del.ok, true);
    assert.equal(runConfigTool(enforcer, "list_habits", {}).habits.length, 0);
  });

  it("exposes config tools on tools/list and tools/call", () => {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), "ack-cfg-mcp-"));
    const enforcer = makeEnforcer(ws);
    const list = handleMcpJsonRpc(enforcer, { jsonrpc: "2.0", id: 1, method: "tools/list" });
    assert.ok(list.result.tools.some((t) => t.name === "get_character_config"));
    const call = handleMcpJsonRpc(enforcer, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "get_character_config", arguments: {} },
    });
    const body = JSON.parse(call.result.content[0].text);
    assert.equal(body.ok, true);
    assert.equal(body.workspace, ws);
  });
});
