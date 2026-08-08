#!/usr/bin/env node
/**
 * postinstall.js — runs ONLY as npm's postinstall lifecycle hook.
 *
 * Proven by direct instrumentation (not assumed): npm does not give
 * lifecycle scripts a real TTY (process.stdin.isTTY / process.stdout.isTTY
 * are both `undefined` here even when the outer `npm install` itself runs
 * in a genuine interactive terminal), does not reliably stream a
 * cleanly-exiting script's stdout live to the user, and does not forward
 * custom CLI flags to lifecycle scripts at all. A live wizard cannot run
 * here, full stop — that's an npm platform constraint, not something this
 * script can work around.
 *
 * So this script does exactly one thing: install the package, then say
 * what's next. It NEVER configures anything — no settings.json edits, no
 * daemon start, no workspace creation — regardless of any environment
 * variable. `npm install -g` only ever installs; it is never also a setup
 * step. Configuration is a single, separate, deliberate command the user
 * runs themselves:
 *   - `ack configure`         — interactive, step-by-step (real TTY, since
 *                                it's a normal terminal command, not a
 *                                lifecycle hook)
 *   - `ack configure --yes`   — non-interactive, auto-detected sane
 *                                defaults, no prompts
 *   - (do nothing)            — package stays fully inert until you run
 *                                one of the above, whenever you want
 *
 * Scoped tightly to avoid the exact footgun this package hit before (see
 * CHANGELOG.md / git history): a script literally named "install" fired
 * on ANY `npm install`, including `cd node && npm install` for local repo
 * dev. Only proceeds when BOTH are true:
 *   1. This is genuinely a global install (npm_config_global === "true").
 *   2. This file is running from inside a real node_modules install tree,
 *      not this repo's own working tree.
 */
import fs from "fs";
import path from "path";
import os from "os";
import { fileURLToPath } from "url";
import { detectHarnesses } from "./install.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function isGlobalInstall() {
  // Fails closed toward "don't print anything" — never assume global from
  // an absent or ambiguous signal.
  return process.env.npm_config_global === "true";
}

function isRealNodeModulesInstall() {
  // A dev running `npm install` inside a clone of this repo has __dirname
  // resolve to .../agent-character-kit/node/bin — no node_modules
  // component anywhere in that path. A real packed/published install
  // always lands under some node_modules/ tree.
  return __dirname.split(path.sep).includes("node_modules");
}

function main() {
  if (!isGlobalInstall() || !isRealNodeModulesInstall()) {
    return; // silent no-op — local dev install, or not global
  }

  const harnesses = detectHarnesses();
  const log = path.join(os.tmpdir(), "ack-postinstall.log");
  const write = (line) => {
    try { fs.appendFileSync(log, line + "\n"); } catch { /* best-effort */ }
  };
  // console.log alone is NOT reliable here -- confirmed live, 2026-08-07:
  // a real `npm install -g` of a real tarball correctly ran this script
  // (proven by the tmp log below actually being written with this exact
  // run's content) but nothing showed up in the terminal at all. npm's
  // lifecycle-script stdout capture swallows it under real-world
  // conditions this repo's install/test harness never hit. The standard
  // workaround (used by other CLI packages with the same problem): write
  // straight to /dev/tty, bypassing npm's stdout pipe entirely. Falls
  // back silently if no controlling terminal exists (piped/CI installs) --
  // the tmp log is still the last-resort record either way.
  let tty = null;
  try { tty = fs.openSync("/dev/tty", "w"); } catch { /* no controlling tty -- fine */ }
  const say = (line) => {
    console.log(line);
    write(line);
    if (tty !== null) {
      try { fs.writeSync(tty, line + "\n"); } catch { /* best-effort */ }
    }
  };

  say(`\n[agent-character-kit] Installed. Detected: ${harnesses.join(", ")}.`);
  say(`[agent-character-kit] Nothing has been configured — the package install and setup are`);
  say(`[agent-character-kit] two separate, deliberate steps. When you're ready:`);
  say(`  ack configure          step-by-step interactive setup`);
  say(`  ack configure --yes    auto-detect and configure now, no prompts`);
  write("ack postinstall: done (install-only, no configuration).");
  if (tty !== null) {
    try { fs.closeSync(tty); } catch { /* best-effort */ }
  }
}

main();
