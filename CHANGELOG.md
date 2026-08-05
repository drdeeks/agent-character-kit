# Changelog

Append-only, newest entry on top. Never rewrite a past entry.

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
