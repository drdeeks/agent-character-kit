/**
 * `ack audit` — read enforcer / events / companion JSONL (no tail -f).
 */

import fs from "fs";
import os from "os";
import path from "path";
import { resolveWorkspace, resolveAckLog, resolveAgentByName } from "./workspace.js";

export const AUDIT_SOURCES = ["enforcer", "events", "companion", "ack"];

export function auditPaths(ws) {
  const agentDir = path.join(ws, ".agent");
  return {
    enforcer: path.join(agentDir, "logs", "enforcer-audit.jsonl"),
    eventsDir: path.join(agentDir, "logs", "events"),
    companion: path.join(os.homedir(), "var", "log", "agent-enforcer", "tool-audit.jsonl"),
    ack: path.join(agentDir, "ack.jsonl"),
  };
}

export function parseJsonlLines(text) {
  const rows = [];
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try { rows.push(JSON.parse(t)); }
    catch { rows.push({ raw: t }); }
  }
  return rows;
}

export function readJsonlFile(file) {
  if (!file || !fs.existsSync(file)) return [];
  return parseJsonlLines(fs.readFileSync(file, "utf8"));
}

export function readEventsDir(dir) {
  if (!dir || !fs.existsSync(dir)) return [];
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl")).sort();
  const rows = [];
  for (const f of files) rows.push(...readJsonlFile(path.join(dir, f)));
  return rows;
}

export function isDenied(row) {
  if (!row || typeof row !== "object") return false;
  if (row.decision === "deny" || row.denied === true) return true;
  if (row.payload && row.payload.denied === true) return true;
  return false;
}

export function collectAuditRows({ ws, source = "enforcer", deniedOnly = false, ackLog } = {}) {
  const paths = auditPaths(ws);
  if (ackLog) paths.ack = ackLog;
  let rows = [];
  const src = source || "enforcer";
  if (src === "all") {
    rows = [
      ...readJsonlFile(paths.enforcer),
      ...readEventsDir(paths.eventsDir),
      ...readJsonlFile(paths.companion),
      ...readJsonlFile(paths.ack),
    ];
  } else if (src === "events") {
    rows = readEventsDir(paths.eventsDir);
  } else if (src === "companion") {
    rows = readJsonlFile(paths.companion);
  } else if (src === "ack") {
    rows = readJsonlFile(paths.ack);
  } else {
    rows = readJsonlFile(paths.enforcer);
  }
  if (deniedOnly) rows = rows.filter(isDenied);
  return { paths, rows };
}

export function runAudit(opts = {}) {
  let ws = resolveWorkspace();
  if (opts.agent) {
    const agent = resolveAgentByName(opts.agent);
    if (!agent) {
      console.error(`No registered agent named '${opts.agent}'.`);
      process.exit(1);
    }
    ws = agent.ws;
  }
  const source = opts.source || "enforcer";
  if (source !== "all" && !AUDIT_SOURCES.includes(source)) {
    console.error(`Unknown source '${source}' (use: ${AUDIT_SOURCES.join("|")}|all)`);
    process.exit(1);
  }
  const limit = Math.max(1, parseInt(opts.limit, 10) || 20);
  const ackLog = opts.agent ? path.join(ws, ".agent", "ack.jsonl") : resolveAckLog();
  const { paths, rows } = collectAuditRows({ ws, source, deniedOnly: !!opts.denied, ackLog });
  const slice = rows.slice(-limit);

  if (opts.json) {
    console.log(JSON.stringify({ workspace: ws, source, count: slice.length, total: rows.length, paths, rows: slice }, null, 2));
    return;
  }

  console.log(`=== ACK audit (${source}) ===`);
  console.log("Workspace:", ws);
  if (source === "enforcer" || source === "all") console.log("Enforcer log:", paths.enforcer, fs.existsSync(paths.enforcer) ? "✓" : "missing");
  if (source === "events" || source === "all") console.log("Events dir:", paths.eventsDir, fs.existsSync(paths.eventsDir) ? "✓" : "missing");
  if (source === "companion" || source === "all") console.log("Companion log:", paths.companion, fs.existsSync(paths.companion) ? "✓" : "missing");
  if (source === "ack" || source === "all") console.log("Ack log:", paths.ack, fs.existsSync(paths.ack) ? "✓" : "missing");
  console.log(`Showing ${slice.length} of ${rows.length} entries.\n`);
  if (slice.length === 0) {
    console.log("No entries. Make a gated tool call, or try --source events|companion|ack|all.");
    return;
  }
  for (const row of slice) {
    const ts = row.ts || row.timestamp || "";
    const kind = row.kind || row.type || "";
    const decision = row.decision || (row.denied === true || row.payload?.denied ? "deny" : "");
    const reason = row.reason || row.payload?.reason || "";
    const tool = row.tool || "";
    console.log([ts, kind, decision, tool, reason].filter(Boolean).join("  "));
  }
}
