import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildAgentList, parseMainMenuChoice, parseAgentMenuChoice } from "../src/manage-menu.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, "..", "..");
const ACK = path.join(REPO, "node", "bin", "ack.js");

// ─── Pure logic: buildAgentList / parseMainMenuChoice / parseAgentMenuChoice ──
// Kept unit-testable without a real interactive session, same reasoning as
// parseHarnessMenuChoice in bin/install.js -- these decide what the menu
// SHOWS and MEANS; the readline orchestration in bin/ack.js is exercised
// separately below via a real spawned process.

test("buildAgentList: falls back to a single 'default' entry when no registry exists", () => {
  const agents = buildAgentList({
    registryPath: null,
    registryAgents: [],
    defaultWs: "/tmp/ack/ws",
    defaultSock: "/tmp/ack/ws/.agent/enforcer.sock",
    defaultAckLog: "/tmp/ack/ws/.agent/ack.jsonl",
  });
  assert.equal(agents.length, 1);
  assert.equal(agents[0].name, "default");
  assert.equal(agents[0].rootMode, false);
});

test("buildAgentList: registry-backed agents get <ws>/.agent/<name>.{sock,jsonl}, matching the daemon's own formula", () => {
  const agents = buildAgentList({
    registryPath: "/tmp/ack/ws.json",
    registryAgents: ["/tmp/ack/claude", "/tmp/ack/opencode"],
    defaultWs: "unused", defaultSock: "unused", defaultAckLog: "unused",
  });
  assert.equal(agents.length, 2);
  assert.equal(agents[0].name, "claude");
  assert.equal(agents[0].sock, "/tmp/ack/claude/.agent/claude.sock");
  assert.equal(agents[0].ackLog, "/tmp/ack/claude/.agent/ack.jsonl");
  assert.equal(agents[0].rootMode, false);
});

test("buildAgentList: rootMode is derived from the registry path (/var/lib -- root deploy only)", () => {
  const agents = buildAgentList({
    registryPath: "/var/lib/ack/ws.json",
    registryAgents: ["/var/lib/ack/claude"],
    defaultWs: "unused", defaultSock: "unused", defaultAckLog: "unused",
  });
  assert.equal(agents[0].rootMode, true);
});

test("parseMainMenuChoice: numeric picks, add, refresh, quit, and rejects out-of-range/garbage", () => {
  assert.deepEqual(parseMainMenuChoice("1", 3), { action: "select", index: 0 });
  assert.deepEqual(parseMainMenuChoice("3", 3), { action: "select", index: 2 });
  assert.equal(parseMainMenuChoice("4", 3).action, "invalid", "out of range must not silently clamp");
  assert.equal(parseMainMenuChoice("0", 3).action, "invalid");
  assert.equal(parseMainMenuChoice("a", 3).action, "add");
  assert.equal(parseMainMenuChoice("A", 3).action, "add", "case-insensitive");
  assert.equal(parseMainMenuChoice("r", 3).action, "refresh");
  assert.equal(parseMainMenuChoice("q", 3).action, "quit");
  assert.equal(parseMainMenuChoice("", 3).action, "quit", "blank Enter at the top menu must be a safe no-op (quit), never silently pick agent 1");
  assert.equal(parseMainMenuChoice("banana", 3).action, "invalid");
  assert.equal(parseMainMenuChoice("1x", 3).action, "invalid", "must not loosely parseInt a trailing-garbage string as 1");
});

test("parseAgentMenuChoice: maps every documented number + letter shortcuts, rejects unknown input", () => {
  const expected = {
    "1": "status", "2": "habits", "3": "habit-create", "4": "habit-delete",
    "5": "daemon-start", "6": "daemon-stop", "7": "daemon-restart",
    "8": "reconfigure", "9": "remove",
  };
  for (const [k, v] of Object.entries(expected)) {
    assert.equal(parseAgentMenuChoice(k).action, v, `choice "${k}"`);
  }
  assert.equal(parseAgentMenuChoice("b").action, "back");
  assert.equal(parseAgentMenuChoice("").action, "back", "blank Enter in a submenu must be a safe no-op (back), never re-trigger the last action");
  assert.equal(parseAgentMenuChoice("q").action, "quit");
  assert.equal(parseAgentMenuChoice("0").action, "invalid");
  assert.equal(parseAgentMenuChoice("10").action, "invalid");
});

// ─── Real end-to-end walk through `ack manage` ─────────────────────────────
// Spawns the actual CLI with piped stdin, one answer per line, and checks
// real filesystem effects -- not just that the process exits 0. This is the
// same class of test as habit-create.test.js and ack-configure.test.js:
// functional proof, not a syntax/shape check.

function runManage(lines, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [ACK, "manage"], {
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stdout += d));
    child.on("exit", (code) => resolve({ code, stdout }));
    // Feed one line at a time on a short interval -- proves the fixed
    // line-buffered ask() handles sequential answers correctly even when
    // Node flushes writes faster than the child can fully process each
    // console.log block between prompts (the exact scenario that exposed
    // the original single-"data"-event ask() bug: multiple answers
    // arriving in one chunk used to collapse into one garbage answer).
    let i = 0;
    const feed = () => {
      if (i >= lines.length) { child.stdin.end(); return; }
      child.stdin.write(lines[i] + "\n");
      i++;
      setTimeout(feed, 30);
    };
    feed();
  });
}

function killByWorkspaceEnv(ws) {
  for (const pidDir of fs.readdirSync("/proc").filter((n) => /^\d+$/.test(n))) {
    try {
      const environ = fs.readFileSync(`/proc/${pidDir}/environ`, "utf8");
      if (environ.includes(`AGENT_WORKSPACE=${ws}\0`)) process.kill(Number(pidDir), "SIGKILL");
    } catch { /* process gone, or unreadable -- fine, skip */ }
  }
}

test("ack manage: list -> select agent -> status report -> back -> quit", { timeout: 20000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ack-manage-status-"));
  const ws = path.join(root, "agents", "testagent");
  try {
    spawnSync(process.execPath, [ACK, "configure", "--yes", "--workspace", ws,
      "--harness", "generic", "--no-claude-config", "--no-monitor", "--no-watchdog", "--no-start"],
      { encoding: "utf8" });
    const registry = path.join(root, "workspaces.json");
    fs.writeFileSync(registry, JSON.stringify([ws]));

    const { code, stdout } = await runManage(["1", "1", "b", "q"], { ACK_WORKSPACES_REGISTRY: registry });

    assert.equal(code, 0);
    assert.match(stdout, /testagent/, "agent must be listed by its registry name");
    assert.match(stdout, new RegExp(`Workspace:\\s+${ws.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`), "status report must show this exact agent's real workspace path");
    assert.match(stdout, /constitution:\s+✓/, "constitution.yaml was created by configure -- report must reflect that");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("ack manage: create a habit through the menu actually writes the YAML file, list shows it, delete removes it", { timeout: 20000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ack-manage-habit-"));
  const ws = path.join(root, "agents", "testagent");
  try {
    spawnSync(process.execPath, [ACK, "configure", "--yes", "--workspace", ws,
      "--harness", "generic", "--no-claude-config", "--no-monitor", "--no-watchdog", "--no-start"],
      { encoding: "utf8" });
    const registry = path.join(root, "workspaces.json");
    fs.writeFileSync(registry, JSON.stringify([ws]));
    const habitFile = path.join(ws, ".agent", "habits", "manage_menu_test_habit.yaml");
    assert.equal(fs.existsSync(habitFile), false, "sanity: habit must not pre-exist");

    const { code, stdout } = await runManage([
      "1",                                             // select testagent
      "3",                                             // create habit
      "manage-menu-test-habit",                        // name
      "Did the manage menu actually write this file?",  // prompt
      "Proves the interactive create path, not just the CLI flag path.", // logic
      "The file exists on disk with the fields we typed.", // evidence
      "should",                                          // level
      "2",                                              // list habits
      "4",                                              // delete habit
      "manage-menu-test-habit",                          // which one
      "y",                                               // confirm delete
      "b", "q",
    ], { ACK_WORKSPACES_REGISTRY: registry });

    assert.equal(code, 0, `manage should exit 0. output:\n${stdout}`);
    assert.match(stdout, /Created:.*manage_menu_test_habit\.yaml/, "create must report the real file path");
    assert.match(stdout, /manage_menu_test_habit: Did the manage menu actually write this file\?/, "list must show the newly created habit's real prompt (name normalized to snake_case, same as habit-create.test.js)");
    assert.match(stdout, /Deleted:.*manage_menu_test_habit\.yaml/, "delete must report the real file path");
    assert.equal(fs.existsSync(habitFile), false, "habit file must actually be gone after delete");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("ack manage: start daemon actually verifies liveness (not just a spawned pid), stop actually kills it", { timeout: 20000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ack-manage-daemon-"));
  const ws = path.join(root, "agents", "testagent");
  try {
    spawnSync(process.execPath, [ACK, "configure", "--yes", "--workspace", ws,
      "--harness", "generic", "--no-claude-config", "--no-monitor", "--no-watchdog", "--no-start"],
      { encoding: "utf8" });
    const registry = path.join(root, "workspaces.json");
    fs.writeFileSync(registry, JSON.stringify([ws]));

    const { code, stdout } = await runManage(["1", "5", "6", "b", "q"], { ACK_WORKSPACES_REGISTRY: registry });
    assert.equal(code, 0, `manage should exit 0. output:\n${stdout}`);
    assert.match(stdout, /Confirmed alive\./, "start must poll the socket and report real liveness, not just echo the spawned pid");
    assert.match(stdout, /Stopped\./, "stop must report success");
  } finally {
    killByWorkspaceEnv(ws); // belt-and-suspenders in case "Stopped." didn't actually land
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("ack manage: remove agent from registry actually rewrites the registry file on disk", { timeout: 20000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ack-manage-remove-"));
  const wsA = path.join(root, "agents", "agenta");
  const wsB = path.join(root, "agents", "agentb");
  fs.mkdirSync(path.join(wsA, ".agent"), { recursive: true });
  fs.mkdirSync(path.join(wsB, ".agent"), { recursive: true });
  const registry = path.join(root, "workspaces.json");
  fs.writeFileSync(registry, JSON.stringify([wsA, wsB]));
  try {
    const { code, stdout } = await runManage(["1", "9", "y", "n", "q"], { ACK_WORKSPACES_REGISTRY: registry });
    assert.equal(code, 0, `manage should exit 0. output:\n${stdout}`);
    assert.match(stdout, /Removed\. 1 agent\(s\) remain/, "must confirm the removal and the real remaining count");
    const remaining = JSON.parse(fs.readFileSync(registry, "utf8"));
    assert.deepEqual(remaining, [wsB], "agenta must actually be gone from the registry file, agentb untouched");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
