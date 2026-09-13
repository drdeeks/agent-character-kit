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
  });

  it("tools/call execute_tool returns a v0 deny in content, not MCP isError", () => {
    const out = handleMcpJsonRpc(fakeEnforcer(), {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "execute_tool", arguments: { tool: "Bash", command: "rm -rf /" } },
    }, { version: "1.6.0" });
    assert.equal(out.result.isError, false);
    const body = JSON.parse(out.result.content[0].text);
    assert.equal(body.denied, true);
    assert.equal(body.reason, "rm -rf /");
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
