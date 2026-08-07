#!/usr/bin/env node
/**
 * postinstall.js — runs ONLY as npm's postinstall lifecycle hook.
 *
 * Proven by direct instrumentation (not assumed): npm does not give
 * lifecycle scripts a real TTY (process.stdin.isTTY / process.stdout.isTTY
 * are both `undefined` here even when the outer `npm install` itself runs
 * in a genuine interactive terminal) and does not reliably stream a
 * cleanly-exiting script's stdout live to the user. A live back-and-forth
 * wizard cannot run here, full stop — that's an npm platform constraint,
 * not something this script can work around. So this does the opposite:
 * a fully non-interactive, auto-detected, safe-by-construction setup that
 * needs no TTY and no prompt to be useful immediately after install.
 * `ack install` (a normal CLI invocation, which DOES get a real TTY) stays
 * the fully interactive, step-by-step-confirmed path for anyone who wants
 * something other than the defaults below.
 *
 * Scoped tightly to avoid the exact footgun this package hit before (see
 * CHANGELOG.md / git history): a script literally named "install" fired
 * on ANY `npm install`, including `cd node && npm install` for local repo
 * dev. Only proceeds when BOTH are true:
 *   1. This is genuinely a global install (npm_config_global === "true").
 *   2. This file is running from inside a real node_modules install tree,
 *      not this repo's own working tree.
 *
 * What it does when both hold, entirely unattended:
 *   - User-mode only. Root/system-wide needs a sudo password, which an
 *     unattended install script must never prompt for or assume — that
 *     stays behind the user explicitly running `ack install` (interactive)
 *     or `ack install --root --yes` (explicit, still their call).
 *   - Auto-detects which harnesses are actually present on this machine
 *     (Claude: ~/.claude/settings.json, Hermes: ~/.hermes/, OpenCode:
 *     ~/.config/opencode/) and wires a companion for each one found,
 *     including merging Claude's PreToolUse hook automatically. Falls
 *     back to a single "generic" companion if none are detected, so the
 *     daemon is still reachable rather than silently unconfigured.
 *   - Starts the daemon (+ monitor + watchdog) now, for real, so `ack
 *     status` is alive immediately after install finishes — not just
 *     configured-but-dormant.
 */
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function isGlobalInstall() {
  // Fails closed toward "don't auto-run" — never assume global from an
  // absent or ambiguous signal.
  return process.env.npm_config_global === "true";
}

function isRealNodeModulesInstall() {
  // A dev running `npm install` inside a clone of this repo has __dirname
  // resolve to .../agent-character-kit/node/bin — no node_modules
  // component anywhere in that path. A real packed/published install
  // always lands under some node_modules/ tree.
  return __dirname.split(path.sep).includes("node_modules");
}

function detectHarnesses() {
  const home = os.homedir();
  const candidates = [
    { harness: "claude", marker: path.join(home, ".claude", "settings.json") },
    { harness: "hermes", marker: path.join(home, ".hermes") },
    { harness: "opencode", marker: path.join(home, ".config", "opencode") },
  ];
  const found = candidates.filter((c) => fs.existsSync(c.marker)).map((c) => c.harness);
  return found.length ? found : ["generic"];
}

async function main() {
  if (!isGlobalInstall() || !isRealNodeModulesInstall()) {
    return; // silent no-op — local dev install, or not global
  }

  const harnesses = detectHarnesses();
  const log = path.join(os.tmpdir(), "ack-postinstall.log");
  const write = (line) => {
    try { fs.appendFileSync(log, line + "\n"); } catch { /* best-effort */ }
  };
  // console.log/error here reach the user's actual terminal during
  // `npm install -g` -- npm streams lifecycle-script stdout/stderr live by
  // default. The tmp log above stays too (useful after the terminal's
  // scrolled away), but it must never be the ONLY place this is recorded --
  // that was the bug: setup could silently fail (or silently need a manual
  // follow-up, e.g. root mode) and nothing ever told the person who just
  // ran the install.
  const say = (line) => { console.log(line); write(line); };
  const warn = (line) => { console.error(line); write(line); };

  say(`\n[agent-character-kit] postinstall: detected ${harnesses.join(", ")} -- setting up automatically...`);

  const isRootUser = typeof process.getuid === "function" && process.getuid() === 0;

  const { main: installMain } = await import("./install.js");
  try {
    // One main() call, one seenWorkspaces de-dupe scope: all detected
    // harnesses share a single workspace/daemon/monitor/watchdog (they all
    // resolve to the same default workspace path below), only the
    // companion wiring repeats per harness.
    await installMain({
      workspace: null, // install.js's own default: ~/.agent-character-kit/workspace
      socket: "unix",
      harnesses,
      root: false,
      yes: true,
      monitor: true,
      watchdog: true,
      companion: true,
      python: false,
      start: true,
      writeClaudeConfig: true,
    });
    say(`[agent-character-kit] ✓ set up ${harnesses.join(", ")} successfully. \`ack status\` is live now -- nothing further to install.`);
    if (isRootUser) {
      say(`[agent-character-kit] Note: installed in USER mode even though this ran as root/sudo -- root/system-wide`);
      say(`  daemon setup is a separate, explicit step (needs your sudo password, which an unattended`);
      say(`  install script must never assume): run \`ack install --root\` if you want that instead.`);
    }
    say(`[agent-character-kit] To customize (different workspace, harness, or options): \`ack install\`.`);
  } catch (e) {
    warn(`[agent-character-kit] ✗ automatic setup FAILED: ${e.message}`);
    warn(`[agent-character-kit] Nothing is configured. Run \`ack install\` to set up manually (interactive,`);
    warn(`  will explain each step), or \`ack doctor\` for a full diagnostic of what's missing.`);
  }
  write("ack postinstall: done.");
}

main();
