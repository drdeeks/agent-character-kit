import assert from "node:assert/strict";
import { test } from "node:test";
import { evaluatePolicy, matchConstraint, matchesPattern } from "./engine.js";
import { CharacterKitCore } from "../plugin.js";

test("matchesPattern treats star as substring wildcard", () => {
  assert.equal(matchesPattern("rm -rf /", "rm -rf /"), true);
  assert.equal(matchesPattern("ls*", "ls -la"), true);
  assert.equal(matchesPattern("echo*", "cat /etc/passwd"), false);
});

test("matchConstraint deny mode is case-insensitive substring", () => {
  assert.equal(matchConstraint("rm -rf /", "Bash", "sudo rm -rf /"), true);
  assert.equal(matchConstraint("rm -rf /", "Bash", "ls"), false);
});

test("matchConstraint allow mode globs tool, command, or first token", () => {
  assert.equal(matchConstraint("ls*", "Bash", "ls -la", true), true);
  assert.equal(matchConstraint("echo*", "Bash", "cat /etc/passwd", true), false);
});

test("hard constraint denies rm -rf /", () => {
  const verdict = evaluatePolicy(
    { tool: "Bash", command: "rm -rf /" },
    { hardConstraints: ["rm -rf /"] }
  );
  assert.equal(verdict.effect, "deny");
  assert.equal(verdict.code, "CK_POLICY_DENIED");
});

test("empty policy allows ordinary commands", () => {
  const verdict = evaluatePolicy({ tool: "Bash", command: "ls" }, {});
  assert.equal(verdict.effect, "allow");
});

test("allow list denies unmatched commands", () => {
  const verdict = evaluatePolicy(
    { command: "rm file" },
    { allowList: ["ls*", "echo*"] }
  );
  assert.equal(verdict.effect, "deny");
});

test("core beforeTool is idempotent for the same toolCallId", async () => {
  const core = new CharacterKitCore({
    policy: { hardConstraints: ["rm -rf /"] },
  });
  const input = {
    context: { sessionId: "s1", runId: "r1", toolCallId: "t1" },
    tool: "Bash",
    command: "rm -rf /",
    params: { command: "rm -rf /" },
  };
  const first = await core.beforeTool(input);
  const second = await core.beforeTool(input);
  assert.equal(first.decision, "deny");
  assert.equal(second.decision, "deny");
  assert.equal(first, second);
});
