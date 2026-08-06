# Changelog

Append-only, newest entry on top. Never rewrite a past entry.

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
