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

// `ack config show/verify/write-env` used to only ever know about a single
// default workspace -- no awareness of the multi-agent registry status/
// doctor/repair already read. This proves --agent works end to end for all
// three subcommands, and that the no-flag path lists the registry too.
function setupRegistry() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ack-config-registry-"));
  const claudeWs = path.join(dir, "agents", "claude");
  const opencodeWs = path.join(dir, "agents", "opencode");
  fs.mkdirSync(path.join(claudeWs, ".agent"), { recursive: true });
  fs.mkdirSync(path.join(opencodeWs, ".agent"), { recursive: true });
  const registry = path.join(dir, "workspaces.json");
  fs.writeFileSync(registry, JSON.stringify([claudeWs, opencodeWs]));
  return { dir, claudeWs, opencodeWs, registry };
}

test("ack config show: no --agent lists the registered agents", () => {
  const { dir, registry } = setupRegistry();
  try {
    const out = execFileSync(process.execPath, [ACK, "config", "show"], {
      env: { ...process.env, ACK_WORKSPACES_REGISTRY: registry },
      encoding: "utf8",
    });
    assert.match(out, /Registered agents \(2, registry: /);
    assert.match(out, /claude\s+->/);
    assert.match(out, /opencode\s+->/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("ack config show --agent <name>: shows that specific agent's real resolved paths", () => {
  const { dir, claudeWs, registry } = setupRegistry();
  try {
    const out = execFileSync(process.execPath, [ACK, "config", "show", "--agent", "claude"], {
      env: { ...process.env, ACK_WORKSPACES_REGISTRY: registry },
      encoding: "utf8",
    });
    assert.match(out, /^Agent: claude$/m);
    assert.ok(out.includes(claudeWs), "must show claude's real workspace path, not a placeholder");
    assert.ok(out.includes(path.join(claudeWs, ".agent", "claude.sock")), "must show claude's own real socket path");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("ack config show --agent <unknown-name>: fails loudly, not silently", () => {
  const { dir, registry } = setupRegistry();
  try {
    assert.throws(() => {
      execFileSync(process.execPath, [ACK, "config", "show", "--agent", "nonexistent"], {
        env: { ...process.env, ACK_WORKSPACES_REGISTRY: registry },
        encoding: "utf8",
      });
    }, /Command failed/, "must exit non-zero for an unknown agent name");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("ack config verify: with no --agent, verifies EVERY registered agent individually", () => {
  const { dir, registry } = setupRegistry();
  try {
    const out = execFileSync(process.execPath, [ACK, "config", "verify"], {
      env: { ...process.env, ACK_WORKSPACES_REGISTRY: registry },
      encoding: "utf8",
    });
    assert.match(out, /=== agent: claude ===/);
    assert.match(out, /=== agent: opencode ===/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("ack config write-env --agent <name>: writes THAT agent's own real paths, not the default workspace's", () => {
  const { dir, opencodeWs, registry } = setupRegistry();
  const outFile = path.join(dir, "opencode.env");
  try {
    execFileSync(process.execPath, [ACK, "config", "write-env", "--agent", "opencode", outFile], {
      env: { ...process.env, ACK_WORKSPACES_REGISTRY: registry },
      encoding: "utf8",
    });
    const content = fs.readFileSync(outFile, "utf8");
    assert.match(content, new RegExp(`AGENT_WORKSPACE=${opencodeWs.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    assert.match(content, /ENFORCER_SOCKET=.*opencode\.sock/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
