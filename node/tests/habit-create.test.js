import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, "..", ".."); // package root, regardless of CWD
const INSTALL = path.join(REPO, "node", "bin", "install.js");
const DAEMON = path.join(REPO, "node", "enforcer", "agent_enforcer_daemon.js");

function rpc(sock, method, params) {
  return new Promise((res, rej) => {
    const c = net.connect(sock, () => c.write(JSON.stringify({ method, params }) + "\n"));
    let buf = "";
    c.on("data", (d) => {
      buf += d.toString();
      if (buf.includes("\n")) { c.end(); try { res(JSON.parse(buf.split("\n")[0])); } catch (e) { rej(e); } }
    });
    c.on("error", rej);
    setTimeout(() => rej(new Error("timeout")), 5000);
  });
}

test("create-habit generates a valid habit file that the daemon indexes", { timeout: 20000 }, async () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "ackhabit-"));
  const sock = path.join(ws, ".agent", "enforcer.sock");

  // create the habit non-interactively -- MOD-009: evidence + level are now
  // required CLI values too, no field hardcoded/defaulted.
  const cr = spawn(process.execPath, [INSTALL, "--create-habit",
    "--workspace", ws,
    "--habit-name", "always-verify-before-ship",
    "--habit-prompt", "Did I actually verify this runs before claiming done?",
    "--habit-logic", "A thing that parses can still be wrong, so proof requires execution.",
    "--habit-evidence", "The change was actually run and the output pasted back, not just described.",
    "--habit-level", "must"], { stdio: ["ignore", "pipe", "pipe"] });
  let errOut = "";
  cr.stderr.on("data", (d) => (errOut += d));
  cr.stdout.on("data", (d) => (errOut += d));
  await new Promise((r) => cr.on("exit", r));

  const file = path.join(ws, ".agent", "habits", "always_verify_before_ship.yaml");
  if (!fs.existsSync(file)) {
    console.log("CREATE-HABIT OUTPUT:", errOut);
  }
  assert.ok(fs.existsSync(file), "habit yaml should be written");
  const text = fs.readFileSync(file, "utf8");
  assert.ok(/name: "always_verify_before_ship"/.test(text), "name normalized to snake_case");
  assert.ok(/prompt: "Did I actually verify this runs before claiming done\?"/.test(text), "prompt field present");
  assert.ok(/kind: "assertion"/.test(text), "MOD-009: must write kind: assertion, not the old thin 'standard' default");
  assert.ok(/evidence: "The change was actually run/.test(text), "MOD-009: must write the real supplied evidence, not the old generic boilerplate string");
  assert.ok(!/The agent applies this habit consistently and can state WHY when held/.test(text), "the old hardcoded generic evidence string must never appear");
  assert.ok(/level: "must"/.test(text), "MOD-009: must write the real supplied enforcement level, not a hardcoded 'reminder'");

  // MOD-009: the CLI must reject the old, now-incomplete invocation instead
  // of silently defaulting the missing fields.
  const incomplete = spawn(process.execPath, [INSTALL, "--create-habit",
    "--workspace", ws,
    "--habit-name", "should-fail",
    "--habit-prompt", "x?", "--habit-logic", "y"], { stdio: ["ignore", "pipe", "pipe"] });
  let incompleteErr = "";
  incomplete.stderr.on("data", (d) => (incompleteErr += d));
  const incompleteCode = await new Promise((r) => incomplete.on("exit", r));
  assert.notEqual(incompleteCode, 0, "must exit non-zero when evidence/level are missing");
  assert.match(incompleteErr, /habit-evidence.*habit-level|habit-level.*habit-evidence/s);
  assert.equal(fs.existsSync(path.join(ws, ".agent", "habits", "should_fail.yaml")), false,
    "must not write a file when required fields are missing");

  // boot the daemon pointing at this workspace; the new habit must be known
  const env = { ...process.env, AGENT_WORKSPACE: ws, ENFORCER_SOCKET: sock, HOME: os.homedir() };
  fs.mkdirSync(path.join(ws, ".agent", "habits"), { recursive: true });
  const child = spawn(process.execPath, [DAEMON], { env, detached: true, stdio: "ignore" });
  child.unref();
  const start = Date.now();
  while (!fs.existsSync(sock) && Date.now() - start < 3000) await new Promise((r) => setTimeout(r, 50));

  // the new habit should be acknowledged (known) by the daemon
  const ack = await rpc(sock, "submit_ack", {
    session_id: "hb",
    statement: "Habit: always_verify_before_ship why: it applies because the daemon loaded it from the freshly created habit file",
  });
  assert.equal(ack.ok, true, "daemon should know the newly created habit");

  try { process.kill(-child.pid, "SIGKILL"); } catch {}
  fs.rmSync(ws, { recursive: true, force: true });
});
