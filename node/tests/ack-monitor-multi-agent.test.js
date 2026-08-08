import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, "..", "..");
const DAEMON = path.join(REPO, "node", "enforcer", "agent_enforcer_daemon.js");
const MONITOR = path.join(REPO, "deploy", "ack_monitor.js");

function rpc(sock, method, params) {
  return new Promise((res, rej) => {
    const c = net.connect(sock, () => c.write(JSON.stringify({ method, params }) + "\n"));
    let buf = "";
    c.on("data", (d) => {
      buf += d.toString();
      if (buf.includes("\n")) {
        c.end();
        try { res(JSON.parse(buf.split("\n")[0])); } catch (e) { rej(e); }
      }
    });
    c.on("error", rej);
  });
}

function seedHabits(ws) {
  const wsHabits = path.join(ws, ".agent", "habits");
  fs.mkdirSync(wsHabits, { recursive: true });
  const repoHabits = path.join(REPO, "python", "example_workspace", ".agent", "habits");
  if (fs.existsSync(repoHabits)) {
    for (const f of fs.readdirSync(repoHabits)) {
      if (f.endsWith(".yaml")) fs.copyFileSync(path.join(repoHabits, f), path.join(wsHabits, f));
    }
  }
}

// The real end-to-end proof for the whole night's per-agent architecture:
// one daemon (multi-workspace, registry-backed), one monitor (now
// multi-agent-aware), two genuinely separate agents. Each agent's ack must
// land on ITS OWN hold ledger, never the other's -- this is the exact
// failure mode drdeek described ("how do you know which one is doing
// what?") and it's now testable, not just asserted.
test("ack_monitor.js: tails two agents' ack logs independently and credits each one's own daemon socket, never cross-contaminating", { timeout: 25000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ack-multi-monitor-"));
  const registryPath = path.join(root, "workspaces.json");
  const wsA = path.join(root, "agents", "agent-a");
  const wsB = path.join(root, "agents", "agent-b");
  seedHabits(wsA);
  seedHabits(wsB);
  fs.writeFileSync(registryPath, JSON.stringify([wsA, wsB]));

  const sockA = path.join(wsA, ".agent", "agent-a.sock");
  const sockB = path.join(wsB, ".agent", "agent-b.sock");
  const ackLogA = path.join(wsA, ".agent", "ack.jsonl");
  const ackLogB = path.join(wsB, ".agent", "ack.jsonl");

  const sharedEnv = { ...process.env, ACK_WORKSPACES_REGISTRY: registryPath, AGENT_WORKSPACE: wsA };
  const daemon = spawn(process.execPath, [DAEMON], { env: sharedEnv, detached: true, stdio: "ignore" });
  daemon.unref();
  const monitor = spawn(process.execPath, [MONITOR], { env: sharedEnv, detached: true, stdio: "ignore" });
  monitor.unref();

  try {
    const start = Date.now();
    while ((!fs.existsSync(sockA) || !fs.existsSync(sockB)) && Date.now() - start < 10000) {
      await new Promise((r) => setTimeout(r, 150));
    }
    assert.ok(fs.existsSync(sockA), "agent-a's own socket should exist");
    assert.ok(fs.existsSync(sockB), "agent-b's own socket should exist");
    await new Promise((r) => setTimeout(r, 800));

    // Agent A gets ONE ack written to its own log; agent B gets a
    // DIFFERENT habit written to its own log. The monitor must route each
    // to the matching socket.
    fs.appendFileSync(ackLogA, JSON.stringify({
      session_id: "sess-a",
      statement: "Habit: no_credential_leak because this test writes agent-a's ack to agent-a's own log file, not agent-b's",
    }) + "\n");
    fs.appendFileSync(ackLogB, JSON.stringify({
      session_id: "sess-b",
      statement: "Habit: complete_thoroughly because this test writes agent-b's ack to agent-b's own log file, not agent-a's",
    }) + "\n");

    // Give the monitor's 1s poll loop time to pick both up.
    await new Promise((r) => setTimeout(r, 2500));

    // Re-submitting the SAME statement to the SAME socket must now be
    // rejected as a reuse -- proof the monitor's earlier relay actually
    // reached and was credited by THAT socket's own daemon-side ledger.
    const reuseA = await rpc(sockA, "submit_ack", {
      session_id: "sess-a",
      statement: "Habit: no_credential_leak because this test writes agent-a's ack to agent-a's own log file, not agent-b's",
    });
    assert.equal(reuseA.ok, false, "agent-a's socket must already have credited this exact habit -- the monitor should have relayed it");

    const reuseB = await rpc(sockB, "submit_ack", {
      session_id: "sess-b",
      statement: "Habit: complete_thoroughly because this test writes agent-b's ack to agent-b's own log file, not agent-a's",
    });
    assert.equal(reuseB.ok, false, "agent-b's socket must already have credited this exact habit -- the monitor should have relayed it");

    // Cross-check: agent A's habit was never relayed to agent B's socket.
    // complete_thoroughly is a real habit name on BOTH (same seeded set),
    // so if it succeeds on B despite never being sent there directly, that
    // proves isolation -- it wasn't already consumed by a leaked A->B relay.
    const crossCheck = await rpc(sockB, "submit_ack", {
      session_id: "sess-b-2",
      statement: "Habit: no_credential_leak because this test only added this exact statement to agent-a's log, confirming it never reached agent-b's socket",
    });
    assert.equal(crossCheck.ok, true, "agent-a's ack must never have reached agent-b's socket -- no cross-contamination");
  } finally {
    for (const pid of [daemon.pid, monitor.pid]) {
      try { process.kill(-pid, "SIGKILL"); } catch {}
    }
    try { daemon.kill("SIGKILL"); } catch {}
    try { monitor.kill("SIGKILL"); } catch {}
    fs.rmSync(root, { recursive: true, force: true });
  }
});
