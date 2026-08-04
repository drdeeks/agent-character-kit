import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const REPO = path.resolve(process.cwd());
const SRC = path.join(REPO, "python", "example_workspace", ".agent", "habits");

// The decision-logic habits extracted from the user's named sources:
//   /home/ubuntu/qwen-cloud-2026/FOREVER-SYSTEM.md  (full 10-section protocol)
//   /home/ubuntu/qwen-cloud-2026/drdeeks-skills/skill-creator/references/standards.md
// These are part of the DEFAULT bundled set (seeded by install.js).
const EXTRACTED = [
  // FOREVER-SYSTEM.md (faithful to the full protocol, not a summary)
  "single_source_of_truth", "layered_not_rewritten", "fail_closed_tamper_evident",
  "affirm_character_each_action", "track_defects_openly", "test_of_forever",
  "rename_as_layer_op", "check_duplication_before_debug",
  "drift_signal_detection", "registered_plugin_not_string", "audit_not_silent",
  "binding_map_one_core", "character_hash_visible", "forever_one_idea",
  // skill-creator standards.md (§5/§6/§10/§4)
  "idempotent_operations", "documented_rollback", "graceful_degradation",
  "timeout_and_retry", "lossless_consolidation", "safe_file_permissions",
  "one_concern_per_file",
];

// Reads habit `name:` fields directly from the seeded YAML files. This is
// deliberately NOT going through the daemon's tool_tick RPC — the hold
// response no longer exposes habit names (by design: the agent must
// search/read the habit files itself, see agent_enforcer_daemon.js
// toolTick / HABIT_POLICY.md §4), so that channel can't be used to verify
// the bundled set anymore. Reading the files directly is the correct check:
// it verifies what ships, independent of what the daemon chooses to reveal.
function namesFromDir(dir) {
  const names = [];
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith(".yaml") && !f.endsWith(".yml")) continue;
    const txt = fs.readFileSync(path.join(dir, f), "utf8");
    const m = txt.match(/^name:\s*"?([^"\n]*)/m);
    if (m) names.push(m[1].trim());
  }
  return names;
}

test("default bundled habits include the 15 extracted decision-logic habits", () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "ackdefault-"));
  fs.mkdirSync(path.join(ws, ".agent", "habits"), { recursive: true });
  for (const f of fs.readdirSync(SRC)) {
    fs.copyFileSync(path.join(SRC, f), path.join(ws, ".agent", "habits", f));
  }

  const known = namesFromDir(path.join(ws, ".agent", "habits"));

  assert.ok(known.length >= 32, `expected >=32 default habits, got ${known.length}`);
  for (const name of EXTRACTED) {
    assert.ok(known.includes(name), `extracted habit missing from default set: ${name}`);
  }
});
