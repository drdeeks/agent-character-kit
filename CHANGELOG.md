# Changelog

Append-only, newest entry on top. Never rewrite a past entry.

## 1.4.0 — 2026-08-07

**Fixed (security-relevant):**
- The enforcer's unix socket was locked to `0600` (owner-only), which made
  root-mode's stated design ("agent can use it, can't tamper with it")
  impossible to actually use — a non-root agent could never connect to a
  root-owned owner-only socket. Fixed to `0660`/`2750` (group-restricted via
  a new shared `ack-clients` group); `ACK_AUTH_TOKEN` remains the real
  authorization check. Same bug was independently duplicated in a second
  socket-server implementation (multi-workspace mode) — fixed there too.
- `package.json`'s `start` script pointed at a nonexistent path
  (`bin/ack.js` instead of `node/bin/ack.js`) — `npm start` has been broken
  since this script existed. Fixed and verified live.

**Added:**
- A real third privilege option: a dedicated, unprivileged service user
  (default `ack-enforcer`) as an alternative to full root — same real
  security boundary (different uid than the agent) without granting root.
  Both systemd deploy scripts now accept `ACK_SERVICE_USER`.
- The interactive `ack configure` wizard's privilege question — previously
  a silent binary root/no-root prompt — is now an explicit 3-way choice
  with real recommendations: system service (recommended), dedicated
  service user (recommended if root is undesired), trust-the-agent
  (explicitly labeled highly not recommended).

**Known gap:** none of the privilege-mode work above has been live-verified
end to end — no sudo access during development (see blueprint KD-17).
Syntax-checked only; needs real verification with real sudo.

**Update, later the same day:** the gap above is closed. drdeek ran a real
root-mode deploy, a full teardown (systemd units, service processes, npm
global package, workspace, Claude Code hooks — everything), and a fresh
reinstall, all with real sudo. Found and fixed live during that pass:
`deploy-agent-enforcer.sh` never installed the daemon's own npm
dependencies (KD-18); `ack repair` checked only one socket before
auto-activating a duplicate daemon (KD-20); `status` was silently gated
behind `ACK_AUTH_TOKEN` even though a bare CLI invocation has no token of
its own, which was the real reason KD-20's first fix looked like it didn't
work (KD-26).

**Also fixed, same day (post-install/uninstall UX, all found via drdeek's
own live testing, not review):**
- The acknowledgment grammar's "resonates true because X" closer read as
  an abstract truth-claim, not attribution to real work — replaced with a
  `<habit> <connector> <real work attribution>` structure; the reason must
  now reference a real file/change, a past action actually taken, or a
  stated future effect. Verified via full git archaeology that this
  formula was described before but never actually implemented anywhere in
  this project's history.
- The Python companion's optional `vectors` extra (numpy +
  sentence-transformers) is now a real opt-in prompt in `ack configure`,
  only shown when the Python companion is actually selected; root mode
  auto-runs the real `pip3 install` (with a PEP 668 `--break-system-packages`
  retry) instead of only printing the command.
- `.npmignore` had been sitting at the repo root the whole time, silently
  inert — npm only reads an ignore file from the actual package directory
  being packed (`node/`, or root depending on which `package.json` is in
  play). A real dev-session audit log had been shipping in every published
  tarball as a result. Moved to `node/.npmignore`, verified via a real
  `npm pack --dry-run` before/after.
- Removed the `postinstall` lifecycle script entirely. Its only job was
  printing a pointer to `ack configure`, and npm never reliably streamed
  that script's stdout to the real terminal — confirmed live: the script
  genuinely ran (its own fallback log proved it), but nothing appeared in
  the terminal. Tried writing straight to `/dev/tty` as a workaround; it
  worked, but drdeek's call was to remove the script instead of carrying
  that workaround forward — `ack status`'s existing first-run nudge (now
  the primary path, not a fallback) and the command list `ack` itself
  prints cover the same ground without a lifecycle script's stdout
  reliability problems, and without triggering npm's separate (and, as of
  npm 11.18.0, permanently unsuppressable in this release) `allow-scripts`
  advisory warning at all.

## 1.3.0 — 2026-08-07

**Changed:**
- `npm install -g` now NEVER configures anything, under any signal —
  supersedes the 1.2.1 entry below, whose described auto-configure-by-default
  postinstall behavior was itself replaced (blueprint CL-0005/MOD-005)
  before 1.2.1 actually shipped it, then corrected again today
  (CL-0007): the `ACK_YES=1` bypass that could still make postinstall
  auto-configure has been removed entirely. `npm install -g` only ever
  installs the package and prints what to run next; setup is always a
  separate, deliberate step.
- The `install` CLI command is renamed to `configure` (`ack configure`),
  matching the standard package-manager pattern (install via npm, then a
  separate `configure` step, e.g. `aws configure`). `ack install` still
  works as a backward-compatible alias.
- `ack configure` (no flags) is the real interactive step-by-step wizard.
  `ack configure --yes` is non-interactive, auto-detected sane defaults.
  Running nothing leaves the package fully inert.

**Fixed:**
- `ack.js`'s command handler force-appended `--yes` onto every
  `install.js` invocation regardless of what was actually passed, so the
  genuine interactive wizard already implemented in `install.js`
  (readline-based, gated on `opts.yes`) was unreachable through the CLI —
  `ack configure` silently ran non-interactively every time. Fixed; a new
  end-to-end test spawns the real `ack.js` binary and confirms `ack
  configure --yes` reaches `install.js` and starts a live daemon.

Also includes the accumulated Phase 0/1 work landed since 1.2.1: the
locational habit-file nudge, `UserPromptSubmit` hook wiring, `preuninstall.js`,
the `ACK_AUTH_TOKEN` spawn-env fix, daemon/monitor/watchdog liveness
verification surfaced as an install failure instead of a silent partial
success, the Claude-transcript acknowledgment detector, and the collapsed
single habit-creator module (fixing a real 3-way duplicate implementation).
See `.blueprint/blueprint.md` CL-0003 through CL-0007 for full detail.

## 1.2.1 — 2026-08-05

**Fixed:**
- `postinstall.js` now does a fully non-interactive, auto-detected setup on
  `npm install -g`: detects which harnesses are actually present (Claude,
  Hermes, OpenCode; falls back to "generic"), wires a companion for each
  (merging Claude's PreToolUse hook automatically), and starts the
  daemon/monitor/watchdog for real — `ack status` is alive immediately after
  install, no manual follow-up required. Replaces an earlier interactive
  postinstall wizard design, which was proven impossible: npm does not give
  lifecycle scripts a real TTY (confirmed by direct instrumentation), so a
  live prompt-and-wait wizard can never run there, on any package.
- `install.js`'s non-interactive (`--yes`) path now accepts a `harnesses`
  array alongside the existing single `harness` string, so postinstall can
  set up every detected harness in one `main()` call sharing one
  workspace/daemon/monitor/watchdog instead of spawning duplicates.
- `ack status` now surfaces the `looksNeverConfigured()` fallback (previously
  dead code) for the case where lifecycle scripts were disabled
  (`--ignore-scripts`, or an org-wide `allow-scripts` policy) and postinstall
  never ran at all.
- Root-mode auto-setup deliberately stays excluded from the unattended
  postinstall path (needs a sudo password an unattended script must never
  assume) — still requires the interactive `ack install`, which gets a real
  terminal since it's a normal CLI invocation, not a lifecycle script.

Scoped tightly to avoid the exact footgun this package hit before (a script
literally named `install` that fired on any `npm install`, including local
dev): only proceeds when `npm_config_global === "true"` AND running from
inside a real `node_modules` install tree. Verified both directions live —
local dev install is a silent no-op, a real `npm install -g` auto-detects
every harness present on the test machine, stands up a genuinely running
daemon (not just configured-but-dormant), and correctly merges Claude's real
`~/.claude/settings.json` PreToolUse hook.

## 1.2.0 — 2026-08-05

**Fixed:**
- `ack install`'s interactive root-mode prompt said "Requires sudo now" but
  never actually ran anything different — choosing root mode only changed a
  summary line at the end; the daemon/monitor/watchdog were still spawned as
  same-UID Node child processes either way. Root mode now actually runs
  `sudo bash deploy/deploy-agent-enforcer.sh` at that point in the flow,
  aborting cleanly with the real error if it fails.

**Added:**
- Multi-harness support: the interactive installer now loops asking "which
  harness(es)?" instead of taking exactly one, wiring a companion for each.
  Harnesses sharing the same workspace share one daemon/monitor/watchdog
  (provisioned once, not duplicated) — only the companion wiring repeats per
  harness.
- Existing-workspace discovery (`discoverAgentWorkspaces`): per harness, the
  installer can scan a directory for `SOUL.md` / `.agent/constitution.yaml`
  markers and offer discovered workspaces to attach to, instead of only ever
  creating a fresh one. Bounded depth (6), skips `node_modules`/`.git`/build
  dirs, stops descending once a marker is found.
- `CHANGELOG.md` itself (this file) — first entry, per the convention
  documented in `AGENTS.md` § Version tracking.

**Tests:** added `discoverAgentWorkspaces` unit tests (marker discovery,
skip-dirs, no-descend-into-found-workspace, empty/nonexistent root). Full
suite (17 tests) passes. New interactive flow (root-mode execution,
multi-harness loop, workspace sharing/dedup, scan-based discovery) proven
end-to-end via real pty-driven runs (`expect`) — piped/non-TTY stdin is
**not** a valid way to test this installer's multi-prompt flow (Node's
readline silently drops queued lines between `question()` calls against a
non-TTY pipe; confirmed as a piped-stdin artifact, not a logic bug, by
reproducing the same code correctly under a real pty).

## 1.1.0 and earlier

Not recorded — this changelog starts from 1.2.0 forward, per AGENTS.md's own
guidance not to block a release on backfilling pre-existing history.
