import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const REPO = path.resolve(process.cwd());
const DAEMON = path.join(REPO, "node", "enforcer", "agent_enforcer_daemon.js");
const SRC = path.join(REPO, "python", "example_workspace", ".agent", "habits");

// The 15 decision-logic habits extracted from forever-system.md + skill-creator
// standards.md. They are part of the DEFAULT bundled set (seeded by install.js).
const EXTRACTED = [
  "single_source_of_truth", "layered_not_rewritten", "fail_closed_tamper_evident",
  "affirm_character_each_action", "track_defects_openly", "test_of_forever",
  "rename_as_layer_op", "check_duplication_before_debug", "idempotent_operations",
  "documented_rollback", "graceful_degradation", "timeout_and_retry",
  "lossless_consolidation", "safe_file_permissions", "one_concern_per_file",
];

function rpc(sock, method, params) {
  return new Promise((res, rej) => {
    const c = net.connect(sock, () => c.write(JSON.stringify({ method, params }) + "\n"));
    let buf = "";
    c.on("data", (d) => {
      buf += d;
      if (buf.includes("\n")) { c.end(); try { res(JSON.parse(buf.split("\n")[0])); } catch (e) { rej(e); } }
    });
    c.on("error", rej);
  });
}

test("default bundled habits include the 15 extracted decision-logic habits", async () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "ackdefault-"));
  fs.mkdirSync(path.join(ws, ".agent", "habits"), { recursive: true });
  for (const f of fs.readdirSync(SRC)) {
    fs.copyFileSync(path.join(SRC, f), path.join(ws, ".agent", "habits", f));
  }
  const sock = path.join(ws, ".agent", "enforcer.sock");
  const d = spawn(process.execPath, [DAEMON], {
    env: { ...process.env, AGENT_WORKSPACE: ws, ENFORCER_SOCKET: sock }, stdio: "ignore",
  });

  let known = [];
  try {
    await new Promise((r) => setTimeout(r, 700));
    for (let i = 1; i <= 5; i++) {
      const r = await rpc(sock, "tool_tick", { session_id: "default-test", tool: "terminal" });
      if (r.hold) { known = r.habits || []; break; }
    }
  } finally {
    d.kill();
  }

  assert.ok(known.length >= 32, `expected >=32 default habits, got ${known.length}`);
  for (const name of EXTRACTED) {
    assert.ok(known.includes(name), `extracted habit missing from default set: ${name}`);
  }
});
