import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)));

test("Claude .mcp.json points at local ACK MCP HTTP", () => {
  const mcp = JSON.parse(readFileSync(path.join(root, ".mcp.json"), "utf8"));
  assert.equal(mcp.mcpServers.ack.type, "http");
  assert.equal(mcp.mcpServers.ack.url, "http://127.0.0.1:8754/mcp");
});

test("Claude plugin.json is ACK, not the Anthropic demo name", () => {
  const manifest = JSON.parse(
    readFileSync(path.join(root, ".claude-plugin", "plugin.json"), "utf8")
  );
  assert.equal(manifest.name, "agent-character-kit");
});
