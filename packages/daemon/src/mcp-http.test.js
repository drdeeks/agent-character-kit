import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  handleMcpJsonRpc,
  parseMcpListenTarget,
  MCP_TOOLS,
  bearerToken,
} from "./mcp-http.js";

function fakeEnforcer() {
  return {
    cfg: { WORKSPACE: "/tmp/ack-ws", SOCKET: "/tmp/ack.sock" },
    habits: [{ name: "no_credential_leak" }],
    HOLD_STATE: new Map(),
    characterHash: "abc",
    executeTool: () => ({ denied: true, reason: "rm -rf /" }),
    heartbeat: () => ({ ok: true }),
    getHabit: (name) => ({ name, prompt: "did I?" }),
    reload: () => {},
    pickPrompt: () => ({ prompts: ["Did I expose a credential?"] }),
    toolTick: () => ({ ok: true }),
    validate_workspace: () => [],
  };
}

describe("MCP HTTP JSON-RPC", () => {
  it("parses ACK_MCP_HTTP listen targets", () => {
    assert.deepEqual(parseMcpListenTarget("tcp://127.0.0.1:8754"), {
      isTcp: true, host: "127.0.0.1", port: 8754,
    });
    assert.deepEqual(parseMcpListenTarget("8754"), {
      isTcp: true, host: "127.0.0.1", port: 8754,
    });
    assert.equal(parseMcpListenTarget(""), null);
  });

  it("initialize and tools/list", () => {
    const enforcer = fakeEnforcer();
    const init = handleMcpJsonRpc(enforcer, {
      jsonrpc: "2.0", id: 1, method: "initialize", params: {},
    }, { version: "1.6.0" });
    assert.equal(init.result.protocolVersion, "2025-03-26");
    assert.equal(init.result.serverInfo.name, "agent-character-kit");
    const list = handleMcpJsonRpc(enforcer, {
      jsonrpc: "2.0", id: 2, method: "tools/list",
    });
    assert.equal(list.result.tools.length, MCP_TOOLS.length);
    assert.ok(list.result.tools.some((t) => t.name === "execute_tool"));
    for (const t of list.result.tools) {
      assert.equal(typeof t.title, "string", t.name);
      assert.equal(typeof t.description, "string", t.name);
      assert.equal(t.inputSchema?.type, "object", t.name);
      assert.equal(t.outputSchema?.type, "object", t.name);
      assert.equal(typeof t.annotations?.readOnlyHint, "boolean", t.name);
      assert.equal(typeof t.annotations?.destructiveHint, "boolean", t.name);
    }
    const reads = ["list_habits", "get_habit", "get_character_config", "heartbeat", "status", "pick_prompt"];
    for (const name of reads) {
      const t = list.result.tools.find((x) => x.name === name);
      assert.equal(t.annotations.readOnlyHint, true, name);
    }
    const writes = ["write_habit", "set_character_config", "execute_tool", "submit_ack", "reload", "tool_tick"];
    for (const name of writes) {
      const t = list.result.tools.find((x) => x.name === name);
      assert.equal(t.annotations.readOnlyHint, false, name);
    }
    assert.equal(list.result.tools.find((x) => x.name === "delete_habit").annotations.destructiveHint, true);
  });

  it("tools/call execute_tool returns a v0 deny in structuredContent, not MCP isError", () => {
    const out = handleMcpJsonRpc(fakeEnforcer(), {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "execute_tool", arguments: { tool: "Bash", command: "rm -rf /" } },
    }, { version: "1.6.0" });
    assert.equal(out.result.isError, false);
    assert.equal(out.result.structuredContent.denied, true);
    assert.equal(out.result.structuredContent.reason, "rm -rf /");
    assert.equal(out.result.content[0].type, "text");
    assert.match(out.result.content[0].text, /Blocked/);
  });

  it("reads bearer token from headers", () => {
    assert.equal(bearerToken({ authorization: "Bearer secret" }), "secret");
    assert.equal(bearerToken({ "x-ack-token": "secret" }), "secret");
  });

  it("notifications/initialized has no JSON-RPC body", () => {
    const out = handleMcpJsonRpc(fakeEnforcer(), {
      jsonrpc: "2.0", method: "notifications/initialized",
    });
    assert.equal(out, null);
  });
});
