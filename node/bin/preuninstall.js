#!/usr/bin/env node
/**
 * preuninstall.js — runs ONLY as npm's preuninstall lifecycle hook.
 *
 * Uses the same scoping guards postinstall.js used to (MOD-004, blueprint.md
 * FEAT-003) -- postinstall.js itself is gone now (removed 2026-08-07: it
 * never configured anything anyway per MOD-005, only printed a pointer
 * message, and npm never reliably streamed that message to the real
 * terminal). What this actually reverses is whatever `ack configure` set
 * up, so these guards -- is this a real global install, is this running
 * from an actual node_modules tree -- still have to hold before touching
 * anything.
 *
 * What it does when both guards hold:
 *   - Kills the daemon, monitor, and watchdog if they're actually running
 *     (PID file where one exists, process-pattern match as a fallback --
 *     the daemon itself never writes a PID file, only monitor/watchdog do,
 *     see blueprint.md KD register / Part I 1.5).
 *   - Strips BOTH PreToolUse and UserPromptSubmit ack.js-marked entries
 *     from ~/.claude/settings.json, using the exact same "bin/ack.js"
 *     marker writeClaudeHookConfig() writes with -- removes exactly what
 *     was added, leaves everything else in the file untouched.
 *   - Leaves workspace data (.agent/habits/, memory, constitution.yaml)
 *     completely untouched -- uninstall removes running processes and
 *     hook registration, not the user's data (FEAT-003 Purpose).
 *
 * Must no-op safely, not error, if nothing was ever installed (local dev,
 * or a machine where install failed partway) -- a PID file pointing at an
 * already-dead process is skipped silently, not treated as an error.
 */
import fs from "fs";
import os from "os";
import path from "path";
import { execSync } from "child_process";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function isGlobalInstall() {
  return process.env.npm_config_global === "true";
}

function isRealNodeModulesInstall() {
  return __dirname.split(path.sep).includes("node_modules");
}

const log = path.join(os.tmpdir(), "ack-preuninstall.log");
const write = (line) => {
  try { fs.appendFileSync(log, line + "\n"); } catch { /* best-effort */ }
};
const say = (line) => { console.log(line); write(line); };
const warn = (line) => { console.error(line); write(line); };

export function listProcesses() {
  // Portable across Linux/macOS: `ps ax -o pid=,command=` gives one line
  // per process, PID first, full command line after. No /proc dependency
  // (macOS has none), no shell metacharacters from untrusted input (every
  // pattern matched below is a hardcoded constant, not user input).
  try {
    const out = execSync("ps ax -o pid=,command=", { encoding: "utf8" });
    return out.split("\n").map((line) => {
      const m = line.match(/^\s*(\d+)\s+(.*)$/);
      return m ? { pid: Number(m[1]), command: m[2] } : null;
    }).filter(Boolean);
  } catch {
    return [];
  }
}

export function killByPidFile(pidFile, scriptMarker, label, procs) {
  if (!fs.existsSync(pidFile)) return killByPattern(scriptMarker, label, procs);
  let pid;
  try {
    pid = Number(fs.readFileSync(pidFile, "utf8").trim());
  } catch {
    return killByPattern(scriptMarker, label, procs);
  }
  if (!pid || Number.isNaN(pid)) return killByPattern(scriptMarker, label, procs);

  const proc = procs.find((p) => p.pid === pid);
  if (!proc) {
    // Stale PID file pointing at a process that's already dead -- skip
    // silently, this is not an error (FEAT-003 Error States).
    say(`[agent-character-kit] ${label}: PID file stale (process ${pid} not running), nothing to kill.`);
    return false;
  }
  if (!proc.command.includes(scriptMarker)) {
    // The PID was reused by an unrelated process since the file was
    // written -- do NOT kill it. This is exactly the defensive check a
    // trust-the-PID-file-blindly approach would skip.
    warn(`[agent-character-kit] ${label}: PID ${pid} no longer matches (reused by another process) -- skipping, falling back to pattern match.`);
    return killByPattern(scriptMarker, label, procs);
  }
  try {
    process.kill(pid, "SIGTERM");
    say(`[agent-character-kit] ${label}: killed (pid ${pid}, via PID file).`);
    return true;
  } catch (e) {
    warn(`[agent-character-kit] ${label}: failed to kill pid ${pid}: ${e.message}`);
    return false;
  }
}

export function killByPattern(scriptMarker, label, procs) {
  const matches = procs.filter((p) => p.command.includes(scriptMarker) && p.pid !== process.pid);
  if (!matches.length) {
    say(`[agent-character-kit] ${label}: not running, nothing to kill.`);
    return false;
  }
  let killedAny = false;
  for (const m of matches) {
    try {
      process.kill(m.pid, "SIGTERM");
      say(`[agent-character-kit] ${label}: killed (pid ${m.pid}, via process-pattern match).`);
      killedAny = true;
    } catch (e) {
      warn(`[agent-character-kit] ${label}: failed to kill pid ${m.pid}: ${e.message}`);
    }
  }
  return killedAny;
}

export function claudeSettingsPath() {
  return path.join(os.homedir(), ".claude", "settings.json");
}

export function stripClaudeHooks() {
  const p = claudeSettingsPath();
  if (!fs.existsSync(p)) {
    say("[agent-character-kit] settings.json: not present, nothing to strip.");
    return;
  }
  let settings;
  try {
    settings = JSON.parse(fs.readFileSync(p, "utf8"));
  } catch (e) {
    // A settings.json that fails to parse has been hand-edited or corrupted
    // since install -- leave it alone rather than guess (FEAT-003 Error
    // States: "a settings.json that's been hand-edited since install ...
    // leave it alone rather than guess").
    warn(`[agent-character-kit] settings.json: could not parse (${e.message}) -- leaving untouched.`);
    return;
  }
  if (!settings.hooks) {
    say("[agent-character-kit] settings.json: no hooks configured, nothing to strip.");
    return;
  }

  const stripAckEntries = (arr) => (arr || []).filter(
    (entry) => !(entry && Array.isArray(entry.hooks) &&
      entry.hooks.some((h) => h && typeof h.command === "string" && h.command.includes("bin/ack.js")))
  );

  const beforePre = (settings.hooks.PreToolUse || []).length;
  const beforePrompt = (settings.hooks.UserPromptSubmit || []).length;
  settings.hooks.PreToolUse = stripAckEntries(settings.hooks.PreToolUse);
  settings.hooks.UserPromptSubmit = stripAckEntries(settings.hooks.UserPromptSubmit);
  const afterPre = settings.hooks.PreToolUse.length;
  const afterPrompt = settings.hooks.UserPromptSubmit.length;

  if (settings.hooks.PreToolUse.length === 0) delete settings.hooks.PreToolUse;
  if (settings.hooks.UserPromptSubmit.length === 0) delete settings.hooks.UserPromptSubmit;

  if (beforePre === afterPre && beforePrompt === afterPrompt) {
    say("[agent-character-kit] settings.json: no ack.js-marked hook entries found, nothing to strip.");
    return;
  }

  fs.writeFileSync(p, JSON.stringify(settings, null, 2) + "\n");
  say(`[agent-character-kit] settings.json: stripped ${beforePre - afterPre} PreToolUse + ${beforePrompt - afterPrompt} UserPromptSubmit entr${(beforePre - afterPre + beforePrompt - afterPrompt) === 1 ? "y" : "ies"} (all other keys untouched).`);
}

function main() {
  if (!isGlobalInstall() || !isRealNodeModulesInstall()) {
    return; // silent no-op -- local dev uninstall, or not global
  }

  say("\n[agent-character-kit] preuninstall: reversing what `ack configure` set up...");

  const REPO = path.resolve(__dirname, "..", "..");
  const DAEMON_MARKER = path.join("node", "enforcer", "agent_enforcer_daemon.js");
  const MONITOR_MARKER = path.join("deploy", "ack_monitor.js");
  const WATCHDOG_MARKER = path.join("deploy", "ack_watchdog.js");

  const procs = listProcesses();

  // Daemon never writes its own PID file (KD register) -- pattern match only.
  killByPattern(DAEMON_MARKER, "daemon", procs);

  // Monitor/watchdog PID files live under the default workspace; a custom
  // --workspace install won't be found here, which is the same limitation
  // process-pattern matching (the fallback for both) doesn't have -- the
  // pattern match below covers that case regardless of workspace location.
  const defaultWs = path.join(os.homedir(), ".agent-character-kit", "workspace");
  killByPidFile(path.join(defaultWs, ".agent", "ack-monitor.pid"), MONITOR_MARKER, "monitor", procs);
  killByPidFile(path.join(defaultWs, ".agent", "ack-watchdog.pid"), WATCHDOG_MARKER, "watchdog", procs);

  stripClaudeHooks();

  say("[agent-character-kit] preuninstall: done. Workspace data (.agent/habits/, memory, constitution.yaml) left untouched.");
  write("ack preuninstall: done.");
}

main();
