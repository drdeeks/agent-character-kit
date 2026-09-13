import assert from "node:assert/strict";
import { test } from "node:test";
import { ERROR_CODES, parseIncoming, createEnvelope, PROTOCOL_VERSION } from "./index.js";

test("parseIncoming accepts v1 envelopes", () => {
  const env = createEnvelope({
    type: "beforeTool",
    requestId: "req-1",
    context: { sessionId: "s", runId: "r" },
    payload: { tool: "Bash" },
  });
  const parsed = parseIncoming(env);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.version, PROTOCOL_VERSION);
});

test("parseIncoming accepts v0 RPC", () => {
  const parsed = parseIncoming({ method: "execute_tool", params: { tool: "Bash" } });
  assert.equal(parsed.ok, true);
  assert.equal(parsed.version, "0");
  assert.equal(parsed.envelope.type, "execute_tool");
});

test("parseIncoming rejects unknown objects", () => {
  const parsed = parseIncoming({ hello: "nope" });
  assert.equal(parsed.ok, false);
  assert.equal(parsed.error.code, ERROR_CODES.CK_PROTOCOL_INVALID);
});
