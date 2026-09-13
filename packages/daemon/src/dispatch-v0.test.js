import { test } from "node:test";
import assert from "node:assert/strict";
import { dispatchV0 } from "./dispatch-v0.js";

function fake() {
  return {
    cfg: { WORKSPACE: "/ws", SOCKET: "/ws/.agent/enforcer.sock" },
    habits: [{ name: "no_credential_leak" }],
    HOLD_STATE: new Map(),
    characterHash: "h",
    executeTool: (tool) => ({ denied: tool === "Bash", reason: "x" }),
    heartbeat: () => ({ ok: true }),
    reload() { this.characterHash = "h2"; },
    getHabit: (name) => ({ name }),
    pickPrompt: () => ({ prompts: ["q"] }),
    toolTick: () => ({ ok: true }),
    validate_workspace: () => [],
    submitAck: () => ({ ok: true }),
  };
}

test("dispatchV0 status and frozen Watchtower methods", () => {
  const e = fake();
  const st = dispatchV0(e, { method: "status", params: {} }, { version: "1.6.0" });
  assert.equal(st.ok, true);
  assert.equal(st.version, "1.6.0");
  assert.equal(st.habits, 1);
  assert.equal(dispatchV0(e, { method: "heartbeat", params: {} }).ok, true);
  assert.equal(dispatchV0(e, { method: "execute_tool", params: { tool: "Bash" } }).denied, true);
  assert.equal(dispatchV0(e, { method: "get_habit", params: { name: "x" } }).name, "x");
  assert.equal(dispatchV0(e, { method: "submit_ack", params: { statement: "s" } }).ok, true);
});

test("dispatchV0 unknown method", () => {
  assert.equal(dispatchV0(fake(), { method: "not_a_method", params: {} }).error, "unknown method");
});
