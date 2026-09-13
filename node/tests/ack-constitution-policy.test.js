import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const ACK = path.join(REPO, "node", "bin", "ack.js");

function runAck(ws, args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [ACK, ...args], {
      env: { ...process.env, AGENT_WORKSPACE: ws, ENFORCER_SOCKET: path.join(ws, ".agent", "enforcer.sock") },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("exit", (code) => resolve({ code, out }));
  });
}

test("ack constitution add/remove and policy deny/set write YAML", { timeout: 15000 }, async () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "ack-char-"));
  const add = await runAck(ws, ["constitution", "add", "DROP TABLE"]);
  assert.equal(add.code, 0, add.out);
  const cons = yaml.load(fs.readFileSync(path.join(ws, ".agent", "constitution.yaml"), "utf8"));
  assert.ok(cons.hard_constraints.includes("rm -rf /"));
  assert.ok(cons.hard_constraints.includes("DROP TABLE"));

  const deny = await runAck(ws, ["policy", "deny", "add", "chmod 777"]);
  assert.equal(deny.code, 0, deny.out);
  const hold = await runAck(ws, ["policy", "set", "hold-every", "7"]);
  assert.equal(hold.code, 0, hold.out);
  const pol = yaml.load(fs.readFileSync(path.join(ws, ".agent", "enforcer.yaml"), "utf8"));
  assert.deepEqual(pol.deny, ["chmod 777"]);
  assert.equal(pol.hold_every_n_calls, 7);

  const show = await runAck(ws, ["constitution", "show", "--json"]);
  assert.equal(show.code, 0, show.out);
  const parsed = JSON.parse(show.out);
  assert.ok(parsed.hard_constraints.includes("DROP TABLE"));

  const rm = await runAck(ws, ["constitution", "remove", "DROP TABLE"]);
  assert.equal(rm.code, 0, rm.out);
  const cons2 = yaml.load(fs.readFileSync(path.join(ws, ".agent", "constitution.yaml"), "utf8"));
  assert.equal(cons2.hard_constraints.includes("DROP TABLE"), false);
});
