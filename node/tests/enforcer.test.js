import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";

function writeWS() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aik-enf-"));
  fs.mkdirSync(path.join(dir, ".agent", "habits"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".agent", "constitution.yaml"),
    "agent:\n  id: t\ncore_values:\n  - be excellent\nhard_constraints:\n  - \"rm -rf /\"\n  - \"git push --force\"\n");
  fs.writeFileSync(path.join(dir, ".agent", "enforcer.yaml"),
    "allow:\n  - \"ls\"\n  - \"git status\"\n");
  return dir;
}

test("daemon denies by allow-list when command not listed", async () => {
  const ws = writeWS();
  const prev = process.env.AGENT_WORKSPACE;
  process.env.AGENT_WORKSPACE = ws;
  try {
    const { Enforcer } = await import("../enforcer/enforcer_daemon.js");
    const enf = new Enforcer();
    const r1 = enf.executeTool("Bash", { command: "ls" });
    const r2 = enf.executeTool("Bash", { command: "rm file" });
    const r3 = enf.executeTool("Bash", { command: "rm -rf /" });
    assert.equal(r1.denied, false);
    assert.equal(r2.denied, true);
    assert.equal(r3.denied, true);
  } finally {
    process.env.AGENT_WORKSPACE = prev;
  }
});

test("every tool call is audited (allow leaves a trail)", async () => {
  const ws = writeWS();
  const prev = process.env.AGENT_WORKSPACE;
  process.env.AGENT_WORKSPACE = ws;
  try {
    const { Enforcer } = await import("../enforcer/enforcer_daemon.js");
    const enf = new Enforcer();
    enf.executeTool("Bash", { command: "ls" });
    const log = path.join(ws, ".agent", "logs", "enforcer-audit.jsonl");
    assert.ok(fs.existsSync(log), "audit log should exist");
    const lines = fs.readFileSync(log, "utf-8").trim().split("\n");
    assert.equal(lines.length, 1);
    const entry = JSON.parse(lines[0]);
    assert.equal(entry.tool, "Bash");
    assert.equal(entry.decision, "allow");
    assert.ok(entry.identity_hash);
  } finally {
    process.env.AGENT_WORKSPACE = prev;
  }
});
