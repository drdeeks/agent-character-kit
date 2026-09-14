import assert from "node:assert/strict";
import { test } from "node:test";
import { createEventSink } from "./create-sink.js";
import { resolveEventSinkMode } from "./sink-mode.js";
import { CompositeSink, NoopSink, RemoteHttpSink, StoreSink } from "./sinks.js";
import { JsonlSink } from "./jsonl-sink.js";

test("daemon/codex/claude default to local JSONL", () => {
  for (const service of ["daemon", "codex", "claude", "hermes", "gate", "local"]) {
    assert.equal(resolveEventSinkMode({ service, env: {} }), "local", service);
  }
});

test("ChatGPT plugin defaults to D1", () => {
  for (const service of ["agnostic", "mcp-bridgelement", "chatgpt", "hosted", "chatgpt-ack-mcp", "plugin.chatgpt"]) {
    assert.equal(resolveEventSinkMode({ service, env: {} }), "d1", service);
  }
});

test("ACK_EVENT_SINK overrides the service default", () => {
  assert.equal(resolveEventSinkMode({ service: "chatgpt", env: { ACK_EVENT_SINK: "local" } }), "local");
  assert.equal(resolveEventSinkMode({ service: "daemon", env: { ACK_EVENT_SINK: "d1" } }), "d1");
  assert.equal(resolveEventSinkMode({ service: "daemon", env: { ACK_EVENT_SINK: "both" } }), "both");
});

test("createEventSink: chatgpt + store is StoreSink", () => {
  const sink = createEventSink({
    service: "chatgpt",
    env: {},
    store: {},
    identity: { workspaceId: "w", userId: "u", installationId: "i" },
  });
  assert.equal(sink instanceof StoreSink, true);
});

test("createEventSink: daemon + localDir is JsonlSink", () => {
  const sink = createEventSink({
    service: "daemon",
    env: {},
    localDir: "/tmp/ack-events",
  });
  assert.equal(sink instanceof JsonlSink, true);
});

test("createEventSink: both fans out", () => {
  const sink = createEventSink({
    service: "daemon",
    env: { ACK_EVENT_SINK: "both", ACK_EVENT_URL: "https://ack.example/events" },
    localDir: "/tmp/ack-events",
  });
  assert.equal(sink instanceof CompositeSink, true);
  assert.equal(sink.sinks.length, 2);
  assert.equal(sink.sinks[0] instanceof JsonlSink, true);
  assert.equal(sink.sinks[1] instanceof RemoteHttpSink, true);
});

test("createEventSink: d1 without URL/store falls back to local JSONL", () => {
  const sink = createEventSink({
    service: "daemon",
    env: { ACK_EVENT_SINK: "d1" },
    localDir: "/tmp/ack-events",
  });
  assert.equal(sink instanceof JsonlSink, true);
});

test("createEventSink: no targets is a no-op, not a throw", () => {
  const sink = createEventSink({ service: "chatgpt", env: {} });
  assert.equal(sink instanceof NoopSink, true);
});
