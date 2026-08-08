import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { extractAgentName, harnessRootName, resolveAgentName } from "../src/agent-identity.js";

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ack-identity-"));
}

// ─── extractAgentName ──────────────────────────────────────────────────────

test("extractAgentName: null/undefined dir is a safe no-op (root mode has nothing to scan yet)", () => {
  assert.equal(extractAgentName(null), null);
  assert.equal(extractAgentName(undefined), null);
});

test("extractAgentName: no identity files at all -> null", () => {
  const dir = tmpDir();
  try {
    assert.equal(extractAgentName(dir), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("extractAgentName: reads agent.json's name field first", () => {
  const dir = tmpDir();
  try {
    fs.writeFileSync(path.join(dir, "agent.json"), JSON.stringify({ name: "Research Assistant" }));
    fs.writeFileSync(path.join(dir, "SOUL.md"), "# Should Not Win\n");
    assert.equal(extractAgentName(dir), "research-assistant", "agent.json must win over SOUL.md when both exist");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("extractAgentName: malformed agent.json falls through to SOUL.md instead of throwing", () => {
  const dir = tmpDir();
  try {
    fs.writeFileSync(path.join(dir, "agent.json"), "{ not valid json");
    fs.writeFileSync(path.join(dir, "SOUL.md"), "# Fallback Name\n");
    assert.equal(extractAgentName(dir), "fallback-name");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("extractAgentName: SOUL.md frontmatter name: field wins over its own heading", () => {
  const dir = tmpDir();
  try {
    fs.writeFileSync(path.join(dir, "SOUL.md"), '---\nname: "Frontmatter Name"\n---\n# Heading Name\n');
    assert.equal(extractAgentName(dir), "frontmatter-name");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("extractAgentName: SOUL.md with no frontmatter falls back to its first # heading", () => {
  const dir = tmpDir();
  try {
    fs.writeFileSync(path.join(dir, "SOUL.md"), "Some preamble.\n\n# The Real Name\n\nMore text.\n");
    assert.equal(extractAgentName(dir), "the-real-name");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("extractAgentName: sanitizes to lowercase-alphanumeric-hyphen, safe for a socket filename", () => {
  const dir = tmpDir();
  try {
    fs.writeFileSync(path.join(dir, "agent.json"), JSON.stringify({ name: "  My Agent!! (v2)  " }));
    assert.equal(extractAgentName(dir), "my-agent-v2");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ─── harnessRootName ────────────────────────────────────────────────────────

test("harnessRootName: recognizes exactly the three known terminal harnesses", () => {
  assert.equal(harnessRootName("claude"), "claude");
  assert.equal(harnessRootName("hermes"), "hermes");
  assert.equal(harnessRootName("opencode"), "opencode");
  assert.equal(harnessRootName("generic"), null);
  assert.equal(harnessRootName("cursor"), null, "not implemented anywhere else in this codebase either -- must not silently pretend to support it");
});

// ─── resolveAgentName (full priority chain) ────────────────────────────────

test("resolveAgentName: identity file wins over everything else, including a known terminal harness", () => {
  const dir = tmpDir();
  try {
    fs.writeFileSync(path.join(dir, "agent.json"), JSON.stringify({ name: "Custom Claude Instance" }));
    return resolveAgentName({ ws: dir, harness: "claude", isDelegatedMultiAgent: false }).then((name) => {
      assert.equal(name, "custom-claude-instance");
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveAgentName: known terminal harness, single-harness run, no identity file -> harness name, no prompt", async () => {
  let askCalls = 0;
  const name = await resolveAgentName({
    ws: null,
    harness: "opencode",
    isDelegatedMultiAgent: false,
    askFn: async () => { askCalls++; return "should not be used"; },
  });
  assert.equal(name, "opencode");
  assert.equal(askCalls, 0, "the whole point of this branch is skipping the prompt for the common single-install case");
});

test("resolveAgentName: known terminal harness but IS a delegated multi-agent run -> asks instead of assuming", async () => {
  const name = await resolveAgentName({
    ws: null,
    harness: "claude",
    isDelegatedMultiAgent: true,
    askFn: async () => "typed-name",
  });
  assert.equal(name, "typed-name");
});

test("resolveAgentName: unknown harness with no identity file -> asks", async () => {
  const name = await resolveAgentName({
    ws: null,
    harness: "generic",
    isDelegatedMultiAgent: false,
    askFn: async () => "  My Custom Agent  ",
  });
  assert.equal(name, "my-custom-agent");
});

test("resolveAgentName: askFn returns blank/unsanitizable -> falls back to harness root name if any, else generic", async () => {
  const withHarness = await resolveAgentName({
    ws: null,
    harness: "generic", // no known root name
    isDelegatedMultiAgent: true, // forces the prompt path even though it's not a terminal harness
    askFn: async () => "   ",
  });
  assert.equal(withHarness, "generic", "last resort with nothing else to go on");
});

test("resolveAgentName: no askFn provided at all (non-interactive caller) never hangs, resolves to harness or generic", async () => {
  const name = await resolveAgentName({ ws: null, harness: "unknownharness", isDelegatedMultiAgent: true });
  assert.equal(name, "generic");
});
