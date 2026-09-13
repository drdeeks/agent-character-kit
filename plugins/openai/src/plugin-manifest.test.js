import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

test("portable plugin.json matches Agent Plugins 1.0.0", () => {
  const manifest = JSON.parse(readFileSync(path.join(root, "plugin.json"), "utf8"));
  assert.equal(
    manifest.$schema,
    "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json"
  );
  assert.equal(manifest.name, "agent-character-kit");
  assert.equal(typeof manifest.version, "string");
  assert.ok(manifest.extensions["com.openai"]);
  assert.equal(manifest.extensions["com.openai"].hooks, "./hooks/hooks.json");
  assert.equal(manifest.skills, undefined);
});

test("Codex fallback points at skills and hooks", () => {
  const compat = JSON.parse(
    readFileSync(path.join(root, ".codex-plugin", "plugin.json"), "utf8")
  );
  assert.equal(compat.skills, "./skills/");
  assert.equal(compat.hooks, "./hooks/hooks.json");
});

test("character-enforcement skill has required frontmatter", () => {
  const skill = readFileSync(
    path.join(root, "skills", "character-enforcement", "SKILL.md"),
    "utf8"
  );
  assert.match(skill, /^---\nname: character-enforcement\n/);
  assert.match(skill, /\ndescription: /);
});

test("configure-character skill covers habit and policy customization", () => {
  const skill = readFileSync(
    path.join(root, "skills", "configure-character", "SKILL.md"),
    "utf8"
  );
  assert.match(skill, /^---\nname: configure-character\n/);
  assert.match(skill, /habits/);
  assert.match(skill, /frequency/);
  const refs = [
    "habits.md",
    "policy.md",
    "frequency.md",
    "workspace.md",
  ];
  for (const name of refs) {
    const body = readFileSync(
      path.join(root, "skills", "configure-character", "references", name),
      "utf8"
    );
    assert.ok(body.length > 200, name);
  }
});
