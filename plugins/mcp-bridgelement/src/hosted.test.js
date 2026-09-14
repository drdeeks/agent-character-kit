import assert from "node:assert/strict";
import { test } from "node:test";
import worker from "./index.js";
import { MemoryStore } from "./storage/memory.js";
import { handleMcpJsonRpc } from "./mcp.js";
import { HOSTED_TOOLS } from "@drdeeks/character-kit-mcp-contract";

const env = { ACK_ALLOW_TEST_IDENTITY: "1", ACK_VERSION: "1.9.1" };

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

test("check_action prints canonical RL events to the workspace D1 store", async () => {
  const store = new MemoryStore();
  const id = identityHeader("user_a");
  const status = await call(store, id, "ack_get_status");
  await call(store, id, "ack_update_profile", {
    profileId: status.profileId,
    patch: { toolRules: [{ type: "hard", pattern: "rm -rf" }], habits: [] },
  });
  await call(store, id, "ack_check_action", { tool: "Bash", command: "rm -rf /" });
  const listed = await call(store, id, "ack_list_events", { eventType: "tool.denied" });
  assert.ok(listed.events.length >= 1);
  assert.equal(listed.events[0].eventType, "tool.denied");
  assert.equal(listed.events[0].workspaceId, "ws_a");
  assert.equal(listed.events[0].payload.command, undefined);
});

test("ingest from another component is workspace-visible, not cross-tenant", async () => {
  const store = new MemoryStore();
  const a = identityHeader("user_a", "ws_a");
  const b = identityHeader("user_b", "ws_a");
  const otherWs = identityHeader("user_c", "ws_other");
  await call(store, a, "ack_ingest_event", {
    eventType: "habit.injected",
    source: "character-kit",
    payload: { habitId: "verify_functionality_not_syntax" },
    user_id: "attacker",
  });
  const everyone = await call(store, b, "ack_list_events");
  assert.equal(everyone.events.length, 1);
  assert.equal(everyone.events[0].ownerUserId, "user_a");
  const isolated = await call(store, otherWs, "ack_list_events");
  assert.equal(isolated.events.length, 0);
});

test("telemetry registry stores versioned components, attributes, schemas, and interventions", async () => {
  const store = new MemoryStore();
  const identity = "workspace=w,user=u,installation=i,agent=agent";
  await call(store, identity, "ack_register_component", { componentId: "the-gate", version: "1.0.0", capabilities: ["policy.evaluate"] });
  await call(store, identity, "ack_register_attribute", { namespace: "gate", name: "policy.version", version: "1", dataType: "string" });
  await call(store, identity, "ack_register_event_schema", { eventType: "policy.evaluated", version: "2", schema: { type: "object" } });
  const intervention = await call(store, identity, "ack_record_intervention", { eventId: "evt-1", componentId: "the-gate", decision: "hold" });
  assert.equal(intervention.decision, "hold");
  assert.equal((await call(store, identity, "ack_list_components", {})).components.length, 1);
  assert.equal((await call(store, identity, "ack_list_attributes", {})).attributes.length, 1);
  assert.equal((await call(store, identity, "ack_list_event_schemas", {})).schemas.length, 1);
  assert.equal((await call(store, identity, "ack_list_interventions", {})).interventions.length, 1);
});

test("POST /events accepts a local ACK/Gate batch", async () => {
  const store = new MemoryStore();
  const res = await worker.fetch(new Request("https://ack.example/events", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-ack-test-identity": identityHeader("user_a"),
    },
    body: JSON.stringify({
      events: [
        { eventType: "session.started", sessionId: "s1" },
        { eventType: "not.a.real.type" },
      ],
    }),
  }), { ...env, ACK_STORE: store });
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.accepted, 1);
});
