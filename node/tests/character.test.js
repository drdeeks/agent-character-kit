import { test } from "node:test";
import assert from "node:assert/strict";
import { processToolCall, processPromptSubmit, generateConfig } from "../src/index.js";
import { DocumentIndexer } from "../src/knowledge/indexer.js";
import fs from "fs";
import os from "os";
import path from "path";

// ─── Identity hook ───────────────────────────────────────────────────────────

test("hook formats Claude allow decision", async () => {
  const { output, exitCode } = await processToolCall(
    { tool_name: "Bash", tool_input: { command: "ls" }, hook_event_name: "PreToolUse" },
    {
      framework: "claude",
      enforcer: {
        validateTool: async () => ({ allowed: true }),
        toolTick: async () => ({ hold: false }),
      },
    }
  );
  assert.equal(output.hookSpecificOutput.permissionDecision, "allow");
  assert.equal(exitCode, 0);
});

test("hook fails CLOSED when enforcer unreachable", async () => {
  const { output, exitCode } = await processToolCall(
    { tool_name: "Bash", tool_input: { command: "rm -rf /" }, hook_event_name: "PreToolUse" },
    { framework: "claude", enforcer: { validateTool: async () => ({ allowed: false, error: true, reason: "down" }) } }
  );
  assert.equal(output.hookSpecificOutput.permissionDecision, "deny");
  assert.equal(exitCode, 2);
});

test("hook denies an allowed call that the daemon HOLDS (habit ack required)", async () => {
  // Regression: processToolCall must actually call toolTick and surface a
  // hold as a denial — this used to be wired for Hermes only.
  const { output, exitCode } = await processToolCall(
    { tool_name: "Bash", tool_input: { command: "ls" }, hook_event_name: "PreToolUse", session_id: "s1" },
    {
      framework: "claude",
      enforcer: {
        validateTool: async () => ({ allowed: true }),
        toolTick: async () => ({ hold: true, reason: "acknowledge 2 habits." }),
      },
    }
  );
  assert.equal(output.hookSpecificOutput.permissionDecision, "deny");
  assert.equal(output.hookSpecificOutput.permissionDecisionReason, "acknowledge 2 habits.");
  assert.equal(exitCode, 2);
});

test("processPromptSubmit injects rotating habit prompts, never a habit name", async () => {
  const { output } = await processPromptSubmit(
    { hook_event_name: "UserPromptSubmit", session_id: "s1" },
    {
      framework: "claude",
      enforcer: {
        pickPrompt: async () => ({
          prompts: [
            { prompt: "Did I validate this?", logic: "Claims aren't facts.", evidence: "" },
          ],
        }),
      },
    }
  );
  const ctx = output.hookSpecificOutput.additionalContext;
  assert.match(ctx, /Did I validate this\?/);
  assert.doesNotMatch(ctx, /name/i);
});

test("processPromptSubmit returns empty output when there's nothing to inject", async () => {
  const { output, exitCode } = await processPromptSubmit(
    { hook_event_name: "UserPromptSubmit", session_id: "s1" },
    { framework: "claude", enforcer: { pickPrompt: async () => ({ prompts: [] }) } }
  );
  assert.deepEqual(output, {});
  assert.equal(exitCode, 0);
});

test("generateConfig emits claude/cursor/gemini blocks", () => {
  const claude = generateConfig("claude");
  const cursor = generateConfig("cursor");
  const gemini = generateConfig("gemini");
  assert.ok(claude.hooks.PreToolUse);
  assert.ok(cursor.hooks.preToolUse);
  assert.ok(gemini.hooks.BeforeTool);
});

// ─── Indexer: discovery + frontmatter + links ─────────────────────────────────

function makeWorkspace() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aik-test-"));
  fs.writeFileSync(path.join(dir, "notes.md"), "# Notes\nSee [[guide]].\n");
  fs.writeFileSync(path.join(dir, "guide.md"), "# Guide\nthe authentication flow lives here\n");
  fs.writeFileSync(path.join(dir, "code.py"), "x = 1\n");
  return dir;
}

test("indexer discovers broad file types and injects frontmatter", async () => {
  const dir = makeWorkspace();
  const idx = new DocumentIndexer(dir);
  await idx.init();
  const res = await idx.indexDirectory(dir, {});
  assert.equal(res.indexed, 3);
  const yaml = fs.readFileSync(path.join(dir, "knowledge", "documents", "notes.yaml"), "utf-8");
  assert.match(yaml, /^---[\s\S]*?id:/);
  assert.match(yaml, /category:/);
});

test("indexer documents wiki links", async () => {
  const dir = makeWorkspace();
  const idx = new DocumentIndexer(dir);
  await idx.init();
  await idx.indexDirectory(dir, {});
  const notes = Object.values(idx.index.documents).find((d) => d.path.endsWith("notes.md"));
  assert.ok(notes.links.includes("guide"));
  assert.ok(Object.keys(idx.index.links).length >= 1);
});

test("indexer excludes agent-internal files (SOUL.md, constitution)", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aik-excl-"));
  fs.writeFileSync(path.join(dir, "SOUL.md"), "# Soul\n");
  fs.mkdirSync(path.join(dir, ".agent"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".agent", "constitution.yaml"), "agent:\n  id: x\n");
  fs.writeFileSync(path.join(dir, "userdoc.md"), "real corpus doc\n");
  const idx = new DocumentIndexer(dir);
  await idx.init();
  const res = await idx.indexDirectory(dir, {});
  assert.equal(res.indexed, 1);
  assert.ok(Object.keys(idx.index.documents).some((k) => k.endsWith("userdoc")));
});
