import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeHabitName, buildHabitYaml, VALID_LEVELS } from "../src/habits/build.js";
import yaml from "js-yaml";

// ─── normalizeHabitName ────────────────────────────────────────────────────

test("normalizeHabitName: kebab-case, spaces, and mixed case all collapse to the same snake_case form", () => {
  assert.equal(normalizeHabitName("Always Verify Before Ship"), "always_verify_before_ship");
  assert.equal(normalizeHabitName("always-verify-before-ship"), "always_verify_before_ship");
  assert.equal(normalizeHabitName("  --Always__Verify--  "), "always_verify");
});

// ─── buildHabitYaml ─────────────────────────────────────────────────────────

test("buildHabitYaml: produces valid, parseable YAML with kind:assertion and the real supplied fields", () => {
  const text = buildHabitYaml({
    name: "test_habit",
    prompt: "Did I test this?",
    logic: "Untested code is a claim, not a fact.",
    evidence: "The test suite was actually run and its output observed.",
    level: "must",
  });
  const parsed = yaml.load(text);
  assert.equal(parsed.name, "test_habit");
  assert.equal(parsed.prompt, "Did I test this?");
  assert.equal(parsed.enforcement.level, "must");
  assert.equal(parsed.behavior.kind, "assertion", "must always write assertion, never the old thin 'standard' default");
  assert.equal(parsed.behavior.evidence, "The test suite was actually run and its output observed.");
  assert.equal(parsed.behavior.assert, "Untested code is a claim, not a fact.");
  assert.equal(parsed.behavior.logic, "Untested code is a claim, not a fact.");
});

test("buildHabitYaml: rejects every missing required field individually, not just when all are missing", () => {
  const full = { name: "n", prompt: "p?", logic: "l", evidence: "e", level: "must" };
  for (const missing of ["name", "prompt", "logic", "evidence"]) {
    const args = { ...full, [missing]: "" };
    assert.throws(() => buildHabitYaml(args), new RegExp(missing), `missing ${missing} must throw`);
  }
  assert.throws(() => buildHabitYaml({ ...full, level: "not-a-real-level" }), /level must be one of/);
});

test("buildHabitYaml: accepts every valid enforcement level", () => {
  for (const level of VALID_LEVELS) {
    const text = buildHabitYaml({ name: "n", prompt: "p?", logic: "l", evidence: "e", level });
    assert.match(text, new RegExp(`level: "${level}"`));
  }
});

test("buildHabitYaml: never silently produces the old generic boilerplate evidence string", () => {
  const text = buildHabitYaml({
    name: "n", prompt: "p?", logic: "l",
    evidence: "specific, real evidence for this exact habit",
    level: "should",
  });
  assert.doesNotMatch(text, /The agent applies this habit consistently and can state WHY when held/);
});
