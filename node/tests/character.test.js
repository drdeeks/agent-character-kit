import { test } from "node:test";
import assert from "node:assert/strict";
import { processToolCall, processPromptSubmit, generateConfig, detectAckFromTranscript } from "../src/index.js";
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

// ─── Bootstrap/self-repair bypass (found live during Phase 2 testing) ────────

test("bootstrap bypass: daemon start command is allowed even when the enforcer stub would deny/throw", async () => {
  const enforcer = {
    validateTool: async () => { throw new Error("must never be called for a bootstrap command"); },
    toolTick: async () => { throw new Error("must never be called for a bootstrap command"); },
  };
  const { output, exitCode } = await processToolCall(
    { tool_name: "Bash", tool_input: { command: "node /x/node/enforcer/agent_enforcer_daemon.js" }, hook_event_name: "PreToolUse" },
    { framework: "claude", enforcer }
  );
  assert.equal(output.hookSpecificOutput.permissionDecision, "allow");
  assert.equal(exitCode, 0);
});

test("bootstrap bypass: ack doctor/repair/status/configure/install are allowed even when the enforcer is unreachable", async () => {
  const enforcer = { validateTool: async () => ({ allowed: false, error: true, reason: "down" }) };
  for (const sub of ["doctor", "repair", "status", "configure", "install"]) {
    const { output, exitCode } = await processToolCall(
      { tool_name: "Bash", tool_input: { command: `ack ${sub}` }, hook_event_name: "PreToolUse" },
      { framework: "claude", enforcer }
    );
    assert.equal(output.hookSpecificOutput.permissionDecision, "allow", `ack ${sub} should bypass`);
    assert.equal(exitCode, 0);
  }
});

test("bootstrap bypass: an ordinary command mentioning 'ack' in passing is NOT bypassed -- still fails closed", async () => {
  const enforcer = { validateTool: async () => ({ allowed: false, error: true, reason: "down" }) };
  const { output, exitCode } = await processToolCall(
    { tool_name: "Bash", tool_input: { command: "cat ack-notes.txt" }, hook_event_name: "PreToolUse" },
    { framework: "claude", enforcer }
  );
  assert.equal(output.hookSpecificOutput.permissionDecision, "deny",
    "the bypass regex is scoped to real ack subcommands (\\back\\s+(doctor|...)\\b), not any string containing 'ack'");
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

// ─── MOD-008: Claude transcript acknowledgment detector ───────────────────────

function writeTranscriptLine(filePath, obj) {
  fs.appendFileSync(filePath, JSON.stringify(obj) + "\n");
}

function assistantTextEntry(text) {
  // Matches the REAL schema, verified against an actual Claude Code
  // transcript file on this machine before writing detectAckFromTranscript
  // (not assumed): { type: "assistant", message: { role: "assistant",
  // content: [{ type: "text", text }] } }.
  return { type: "assistant", message: { role: "assistant", content: [{ type: "text", text }] } };
}

test("detectAckFromTranscript: detects a real work-attributed acknowledgment and logs it in ack_monitor.js's exact format", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ack-transcript-"));
  const transcript = path.join(dir, "session.jsonl");
  const ackLog = path.join(dir, "ack.jsonl");
  const origAckLog = process.env.ACK_ACK_LOG;
  process.env.ACK_ACK_LOG = ackLog;
  try {
    writeTranscriptLine(transcript, { type: "user", message: { role: "user", content: "hello" } });
    writeTranscriptLine(transcript, assistantTextEntry(
      "Habit: no_credential_leak because this exact fix in agent_enforcer_daemon.js never emits a real secret."
    ));

    detectAckFromTranscript(transcript, "test-session");

    assert.ok(fs.existsSync(ackLog), "must create the ack log");
    const lines = fs.readFileSync(ackLog, "utf8").trim().split("\n");
    assert.equal(lines.length, 1);
    const entry = JSON.parse(lines[0]);
    assert.equal(entry.session_id, "test-session");
    assert.match(entry.statement, /no_credential_leak/);
    assert.match(entry.statement, /because/i);
  } finally {
    process.env.ACK_ACK_LOG = origAckLog;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("detectAckFromTranscript: detects all four accepted connectors, not just Hermes's narrower single pattern", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ack-transcript-closers-"));
  const transcript = path.join(dir, "session.jsonl");
  const ackLog = path.join(dir, "ack.jsonl");
  const origAckLog = process.env.ACK_ACK_LOG;
  process.env.ACK_ACK_LOG = ackLog;
  try {
    writeTranscriptLine(transcript, assistantTextEntry(
      "Habit: due_diligence why: I actually ran the test suite before claiming this works."
    ));
    detectAckFromTranscript(transcript, "s1");
    const entry = JSON.parse(fs.readFileSync(ackLog, "utf8").trim());
    assert.match(entry.statement, /due_diligence/);
    assert.match(entry.statement, /why:/i);
  } finally {
    process.env.ACK_ACK_LOG = origAckLog;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("detectAckFromTranscript: no false positive on ordinary text mentioning the word 'habit'", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ack-transcript-noise-"));
  const transcript = path.join(dir, "session.jsonl");
  const ackLog = path.join(dir, "ack.jsonl");
  const origAckLog = process.env.ACK_ACK_LOG;
  process.env.ACK_ACK_LOG = ackLog;
  try {
    writeTranscriptLine(transcript, assistantTextEntry(
      "I have a habit of double-checking my work, but I'm not stating a formal acknowledgment here."
    ));
    detectAckFromTranscript(transcript, "s1");
    assert.equal(fs.existsSync(ackLog), false, "must not create a log entry for text that isn't a real acknowledgment statement");
  } finally {
    process.env.ACK_ACK_LOG = origAckLog;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("detectAckFromTranscript: only scans the MOST RECENT assistant turn, not the whole history", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ack-transcript-recency-"));
  const transcript = path.join(dir, "session.jsonl");
  const ackLog = path.join(dir, "ack.jsonl");
  const origAckLog = process.env.ACK_ACK_LOG;
  process.env.ACK_ACK_LOG = ackLog;
  try {
    // An OLD acknowledgment several turns back...
    writeTranscriptLine(transcript, assistantTextEntry(
      "Habit: due_diligence why: an old statement from several turns ago, should not be re-detected."
    ));
    writeTranscriptLine(transcript, { type: "user", message: { role: "user", content: "next question" } });
    // ...and the most recent turn has no acknowledgment at all.
    writeTranscriptLine(transcript, assistantTextEntry("Just a normal reply, no acknowledgment here."));

    detectAckFromTranscript(transcript, "s1");
    assert.equal(fs.existsSync(ackLog), false, "an old acknowledgment buried earlier in history must not be re-detected on every later turn");
  } finally {
    process.env.ACK_ACK_LOG = origAckLog;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("detectAckFromTranscript: never throws on a missing/nonexistent transcript path", () => {
  assert.doesNotThrow(() => detectAckFromTranscript("/nonexistent/path/session.jsonl", "s1"));
  assert.doesNotThrow(() => detectAckFromTranscript(undefined, "s1"));
  assert.doesNotThrow(() => detectAckFromTranscript(null, "s1"));
});

test("detectAckFromTranscript: never throws on a malformed (non-JSON) transcript line", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ack-transcript-malformed-"));
  const transcript = path.join(dir, "session.jsonl");
  try {
    fs.writeFileSync(transcript, "not valid json at all\n{\"partial\":\n");
    assert.doesNotThrow(() => detectAckFromTranscript(transcript, "s1"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("processPromptSubmit: calls the transcript detector when payload.transcript_path is present", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ack-e2e-prompt-"));
  const transcript = path.join(dir, "session.jsonl");
  const ackLog = path.join(dir, "ack.jsonl");
  const origAckLog = process.env.ACK_ACK_LOG;
  process.env.ACK_ACK_LOG = ackLog;
  try {
    writeTranscriptLine(transcript, assistantTextEntry(
      "Habit: shippable_pride matters because — I would ship this test as-is."
    ));
    await processPromptSubmit(
      { hook_event_name: "UserPromptSubmit", session_id: "e2e-session", transcript_path: transcript },
      { framework: "claude", enforcer: { pickPrompt: async () => ({ prompts: [] }) } }
    );
    assert.ok(fs.existsSync(ackLog), "processPromptSubmit must trigger real detection when transcript_path is in the payload");
    const entry = JSON.parse(fs.readFileSync(ackLog, "utf8").trim());
    assert.equal(entry.session_id, "e2e-session");
    assert.match(entry.statement, /shippable_pride/);
  } finally {
    process.env.ACK_ACK_LOG = origAckLog;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
