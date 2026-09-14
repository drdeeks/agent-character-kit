import assert from "node:assert/strict";
import { test } from "node:test";
import worker from "./index.js";
import { MemoryStore } from "./storage/memory.js";
import { handleMcpJsonRpc } from "./mcp.js";
import { HOSTED_TOOLS } from "@drdeeks/character-kit-mcp-contract";

const env = { ACK_ALLOW_TEST_IDENTITY: "1", ACK_VERSION: "1.9.0" };

function identityHeader(user, ws = "ws_a") {
  return `workspace=${ws},user=${user},installation=inst_${user}`;
}

async function mcp(store, identity, method, extra = {}) {
  const request = new Request("https://ack.example/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-ack-test-identity": identity,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: extra.rpc || "tools/call",
      params: extra.rpc ? extra.params : { name: method, arguments: extra.args || {} },
    }),
  });
  return worker.fetch(request, { ...env, ACK_STORE: store });
}

async function call(store, identity, name, args = {}) {
  const res = await mcp(store, identity, name, { args });
  const body = await res.json();
  return body.result?.structuredContent || body;
}

test("hosted tools/list has the spec names with schemas", async () => {
  const names = HOSTED_TOOLS.map((t) => t.name);
  assert.ok(names.includes("ack_check_action"));
  assert.ok(names.includes("ack_create_profile"));
  for (const t of HOSTED_TOOLS) {
    assert.equal(typeof t.title, "string");
    assert.ok(t.inputSchema);
    assert.ok(t.outputSchema);
    assert.ok(t.annotations);
  }
  const store = new MemoryStore();
  const res = await mcp(store, identityHeader("user_a"), null, { rpc: "tools/list" });
  const body = await res.json();
  assert.equal(body.result.tools.length, HOSTED_TOOLS.length);
});

test("identity comes from the connection, not user_id args", async () => {
  const store = new MemoryStore();
  const mine = await call(store, identityHeader("user_a"), "ack_get_status", { user_id: "user_b" });
  assert.equal(mine.ok, true);
  assert.ok(String(mine.profileId).startsWith("profile_"));
  const other = await call(store, identityHeader("user_b"), "ack_list_profiles");
  assert.equal(other.profiles.length, 1);
  assert.notEqual(other.profiles[0].profileId, mine.profileId);
});

test("tenant isolation: user A cannot read user B profiles", async () => {
  const store = new MemoryStore();
  const a = await call(store, identityHeader("user_a"), "ack_create_profile", { name: "strict-a" });
  const stolen = await call(store, identityHeader("user_b"), "ack_get_policy", { profileId: a.profileId });
  assert.equal(stolen.error, "profile not found");
});

test("ack_check_action denies rm -rf via shared PolicyEngine", async () => {
  const store = new MemoryStore();
  const id = identityHeader("user_a");
  await call(store, id, "ack_update_profile", {
    profileId: (await call(store, id, "ack_get_status")).profileId,
    patch: { toolRules: [{ type: "hard", pattern: "rm -rf" }], habits: [] },
  });
  const decision = await call(store, id, "ack_check_action", { tool: "Bash", command: "rm -rf /" });
  assert.equal(decision.decision, "deny");
  assert.ok(decision.reasonCodes.length);
});

test("fail-closed hold then acknowledge", async () => {
  const store = new MemoryStore();
  const id = identityHeader("user_a");
  const status = await call(store, id, "ack_get_status");
  await call(store, id, "ack_update_profile", {
    profileId: status.profileId,
    patch: {
      habits: [{ name: "verify_functionality_not_syntax", requiresAck: true }],
      acknowledgmentRules: { requiredAcks: 1, holdEvery: 1 },
      toolRules: [],
    },
  });
  const held = await call(store, id, "ack_check_action", { tool: "Bash", command: "ls" });
  assert.equal(held.decision, "hold");
  assert.equal(held.nextAction, "acknowledge_hold");
  const thin = await call(store, id, "ack_acknowledge_hold", { habitName: "verify_functionality_not_syntax", reason: "ok" });
  assert.equal(thin.decision, "deny");
  const acked = await call(store, id, "ack_acknowledge_hold", {
    habitName: "verify_functionality_not_syntax",
    reason: "I ran the tests and they passed on this tree",
    decisionId: held.decisionId,
  });
  assert.equal(acked.decision, "acknowledge");
});

test("missing auth is 401; /health is public", async () => {
  const store = new MemoryStore();
  const denied = await worker.fetch(new Request("https://ack.example/mcp", {
    method: "POST",
    body: "{}",
  }), { ACK_STORE: store });
  assert.equal(denied.status, 401);
  const health = await worker.fetch(new Request("https://ack.example/health"), { ACK_STORE: store });
  assert.equal(health.status, 200);
});

test("storage failure is unavailable, not allow", async () => {
  const store = new MemoryStore();
  store.ensureTenant = async () => {
    const err = new Error("D1 unavailable");
    err.code = "storage";
    throw err;
  };
  const rpc = await handleMcpJsonRpc(
    { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "ack_check_action", arguments: { tool: "Bash" } } },
    { identity: { workspaceId: "w", userId: "u", installationId: "i", agentId: "chatgpt" }, store }
  );
  assert.equal(rpc.result.structuredContent.decision, "unavailable");
  assert.notEqual(rpc.result.structuredContent.decision, "allow");
});

test("export and delete stay tenant-scoped", async () => {
  const store = new MemoryStore();
  const a = identityHeader("user_a");
  const b = identityHeader("user_b");
  await call(store, a, "ack_get_status");
  await call(store, b, "ack_get_status");
  const exported = await call(store, a, "ack_export_user_data");
  assert.equal(exported.profiles.length, 1);
  await call(store, a, "ack_delete_user_data");
  const after = await call(store, a, "ack_list_profiles");
  assert.equal(after.profiles.length, 0);
  const stillB = await call(store, b, "ack_list_profiles");
  assert.equal(stillB.profiles.length, 1);
});
