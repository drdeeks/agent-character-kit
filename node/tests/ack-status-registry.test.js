import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, "..", "..");
const ACK = path.join(REPO, "node", "bin", "ack.js");

// `ack status` (and doctor/repair, which share checkAllSockets()) used to
// only ever check 3 fixed candidate paths -- no awareness that one enforcer
// can hold many independently-named agents (KD-21 follow-up). This proves
// the registry is actually read and each registered agent shows up
// individually, by name, with its own real socket path -- not folded into
// one opaque "root (systemd)" entry.
test("ack status: reads ACK_WORKSPACES_REGISTRY and reports each registered agent individually", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ack-status-registry-"));
  try {
    const claudeWs = path.join(dir, "agents", "claude");
    const opencodeWs = path.join(dir, "agents", "opencode");
    fs.mkdirSync(path.join(claudeWs, ".agent"), { recursive: true });
    fs.mkdirSync(path.join(opencodeWs, ".agent"), { recursive: true });
    const registry = path.join(dir, "workspaces.json");
    fs.writeFileSync(registry, JSON.stringify([claudeWs, opencodeWs]));

    const out = execFileSync(process.execPath, [ACK, "status", "--json"], {
      env: { ...process.env, ACK_WORKSPACES_REGISTRY: registry },
      encoding: "utf8",
    });
    const parsed = JSON.parse(out);

    assert.equal(parsed.registryPath, registry);
    assert.ok(parsed.results["agent: claude"], "claude must be reported as its own individual entry");
    assert.ok(parsed.results["agent: opencode"], "opencode must be reported as its own individual entry");
    assert.equal(
      parsed.results["agent: claude"].path,
      path.join(claudeWs, ".agent", "claude.sock"),
      "must be THIS agent's own real socket path, not a shared generic one"
    );
    assert.notEqual(
      parsed.results["agent: claude"].path,
      parsed.results["agent: opencode"].path,
      "two different agents must never resolve to the same socket path"
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("ack status: no registry found -> falls back to the old generic root-mode check, still works", () => {
  const out = execFileSync(process.execPath, [ACK, "status", "--json"], {
    env: { ...process.env, ACK_WORKSPACES_REGISTRY: "/no/such/file/exists.json" },
    encoding: "utf8",
  });
  const parsed = JSON.parse(out);
  assert.equal(parsed.registryPath, null);
  assert.ok(parsed.results["root (systemd)"], "fallback candidate must still be present when no registry exists");
});
