import assert from "node:assert/strict";
import { test } from "node:test";
import { createStore } from "./index.js";
import { D1Store } from "./storage/d1.js";
import { MemoryStore } from "./storage/memory.js";
import { identityFromParts, resolveIdentity } from "./auth.js";

test("store factory prefers injected store, then D1, with MemoryStore fallback", () => {
  const injected = new MemoryStore();
  assert.equal(createStore({ ACK_STORE: injected }), injected);
  const db = { prepare() {} };
  assert.ok(createStore({ ACK_DB: db }) instanceof D1Store);
  assert.ok(createStore({}) instanceof MemoryStore);
});

test("provider and default agent are configurable with universal defaults", () => {
  const request = new Request("https://ack.example/mcp", {
    headers: { "cf-access-authenticated-user-email": "Person@example.com", "x-ack-workspace-id": "ws" },
  });
  const identity = resolveIdentity(request, { ACK_PROVIDER: "claude", ACK_DEFAULT_AGENT: "writer" });
  assert.equal(identity.provider, "claude");
  assert.equal(identity.agentId, "writer");
  assert.equal(identity.userId, "user_claude_person-example-com");
  const legacy = identityFromParts({ workspaceId: "w", userId: "u", installationId: "i" });
  assert.equal(legacy.provider, "agnostic");
  assert.equal(legacy.agentId, "default-agent");
});
