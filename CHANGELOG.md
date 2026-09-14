# Changelog

Append-only, newest entry on top. Never rewrite a past entry.

## Unreleased

**Added — service-aware event sinks (2026-09-13):**

Local daemon/Codex/Claude/Hermes/Gate services default to JSONL. ChatGPT
hosted defaults to D1. `ACK_EVENT_SINK=local|d1|both` overrides the default;
D1 can use the in-process store or `ACK_EVENT_URL`. `both` fans out. If a
requested D1 target is unavailable locally, JSONL is retained. Root npm
package files now include the hosted Worker and D1 migration.

**Added — telemetry / elementary RL events print to hosted D1
(2026-09-13):**

`enforcement_events` migration, `ack_ingest_event`, `ack_list_events`,
and `POST /events`. Hosted check/ack already emit canonical facts.
Workspace-scoped gather for RL datasets. No rewards in the writer.

## 1.9.0 — 2026-09-13

npm: `@drdeeks/character-kit@1.9.0`. Same kit, not a 2.0.0 socket cutover.
Watchtower adapter still uses the four frozen v0 NDJSON RPCs.

**Added — hosted ChatGPT MCP Worker (`apps/chatgpt-ack-mcp`)
(2026-09-13):**

Implements `GPT-INTEGRATION-SPEC.md` without replacing the local daemon.
ChatGPT users do not need `install.sh` or localhost MCP. Identity comes
from the authenticated connection, never from `user_id` args. D1 schema
in `migrations/0001_init.sql`; tests use MemoryStore. Enforcement is
`packages/core` `evaluatePolicy`. Fail-closed storage/worker failures
return `unavailable`. Shared `packages/config-schema` and
`packages/mcp-contract`. No `@modelcontextprotocol/sdk`, no Apps SDK
widget, no nested `mcp-server/src`. OAuth/D1 deploy is not live until
Worker secrets and a D1 database id exist.

## 1.8.0 — 2026-09-13

npm: `@drdeeks/character-kit@1.8.0`. Same kit, not a 2.0.0 socket cutover.
Watchtower adapter still uses the four frozen v0 NDJSON RPCs.

**Changed — kit stamp 1.8.0
(2026-09-13):**

Bump `VERSION`, `node/src/version.js`, root/`node`/`packages/*`/`plugins/*`
`package.json`, OpenAI `plugin.json` + `.codex-plugin/plugin.json`, Hermes
`ACK_VERSION` / `plugin.yaml` / `pyproject.toml`, README, `install.sh`,
`AGENTS.md`. This stamp is the unpublished 1.7.0 tree plus Codex interface
metadata and the `js-yaml` 4.3.2 / 3.15.2 CVE patch. Detailed bullets stay
under 1.7.0 (append-only). Do not rewrite that section.

## 1.7.0 — 2026-09-13

npm: `@drdeeks/character-kit@1.7.0`. Same kit, not a 2.0.0 socket cutover.
Watchtower adapter still uses the four frozen v0 NDJSON RPCs.

**Changed — Codex `.codex-plugin/plugin.json` interface metadata
(2026-09-13):**

Author, homepage, repository, and `interface` (displayName, descriptions,
developerName, category, capabilities, website/privacy/terms URLs,
defaultPrompt). `PRIVACY.md` and `TERMS.md` live in `plugins/openai/`.
Skill descriptions start with `Use when`. Directory stays `openai`;
manifest name stays `agent-character-kit`. No coverage artifacts, no
Apps SDK widgets.

**Fixed — `js-yaml` DoS CVEs from the Socket scan
(2026-09-13):**

Direct `js-yaml` `^4.1.0` / lock `4.3.0` → `^4.3.2` / `4.3.2`.
Nested `gray-matter` `js-yaml` `3.15.0` → `3.15.2`.
Closes `GHSA-2883-xcg3-v3hh` (`CVE-2026-84375`) and `GHSA-5p4m-2wfm-xmqj`.
Re-scan `4182b7f9-dcdb-4585-acaa-f0ef6e8997b1` is healthy; those highs are
gone. Not patched: PyPI lockfile (policy ignore), `gray-matter` unmaintained.
`npm test` 145/145; `npm run test:python` ALL PASS.

**Changed — Socket.dev full scan of this tree
(2026-09-13):**

`socket scan create --report --tmp` scan
`40e7ae29-b54b-4c12-b641-c190eb3f30b1`. Org policy healthy. No malware.
High CVEs on `js-yaml` 4.3.0 and 3.15.0 (`GHSA-2883-xcg3-v3hh`,
`GHSA-5p4m-2wfm-xmqj`); policy action monitor. Not patched in this commit.

**Changed — live docs match 1.7.0; historical reviews stay dated
(2026-09-13):**

`docs/refactor-plan.md` kit-in-scope is 1.7.0. Dated `docs/reviews/` and
the telemetry plan keep their 1.6.0 findings and say so at the top.
`npm pack` SoT is root `files[]` (188 files in dry-run, tests excluded).
`npm run test:python` runs parity + Hermes plugin tests.

**Changed — OpenAI plugin MCP tools match the current plugin guide
(2026-09-13):**

MCP stays on the ACK daemon (`ACK_MCP_HTTP`, `POST /mcp`). No nested
`mcp-server/src`, no `@modelcontextprotocol/sdk` second engine, no Apps
SDK widgets. Each tool now has title, description, inputSchema,
outputSchema, and safety annotations. Reads and writes stay separate.
`tools/call` returns `structuredContent` plus readable `content`. Plugin
`mcp-server/README.md` is a pointer. Auth remains bearer `ACK_AUTH_TOKEN`
on loopback (not OAuth 2.1).

**Fixed — Enforcer `heartbeat` after the packages/daemon move
(2026-09-13):**

`heartbeat()` referenced `ACK_VERSION` which no longer existed in
`enforcer.js`. The JSONL server caught the throw and returned
`{ error: "invalid request" }`. Watchtower `sendHeartbeat` failed-closed.
Import `VERSION` from `node/src/version.js`. Live-proved with
`createCharacterKitClient` from `plugins/watchtower-adapter`:
`execute_tool`, `get_habit`, `submit_ack`, `heartbeat`.

**Fixed — `events.js` syntax
(2026-09-13):**

`policyReleasedEvent` was missing a `}` (`node --check` failed). Duplicate
named `export { EventType, ... }` removed; functions already export at
definition.

**Changed — `install.sh` and npm pack for 1.7.0
(2026-09-13):**

Curl installer still `npm i -g @drdeeks/character-kit` then `ack configure`.
Comments name 1.7.0. Root `files[]` includes `install.sh`.

**Changed — kit tree passes forever-validation
(2026-09-13):**

Example habit YAML no longer embeds unfinished-stub, draft, PEM, or assignment samples.
Manage/install tests use short `/tmp/ack/...` and `/var/lib/ack/...`
paths. Directory scan: 0 errors.

**Added — `ack constitution` and `ack policy`
(2026-09-13):**

CLI writes the same workspace YAML as the MCP config tools, then reloads
if the daemon is up. `constitution show|add|remove` edits
`hard_constraints`. `policy show`, `policy deny/allow add|remove`, and
`policy set hold-every|required-acks` edit `enforcer.yaml`. README and
AGENTS.md match the `packages/daemon` + `packages/cli` layout.
`postinstall.js` imports `detectHarnesses` from a tiny module so npm
install does not load `install.js` / `gray-matter`.

**Added — config MCP tools and localhost /config menu
(2026-09-13):**

MCP tools `list_habits`, `write_habit`, `delete_habit`,
`get_character_config`, `set_character_config` write workspace YAML then
`reload`. They do not evaluate policy. Watchtower v0 methods unchanged.
GET `/config` on `ACK_MCP_HTTP` is a small HTML menu (habits, hard
constraints, allow/deny, hold frequency). Not an Apps SDK widget.

**Added — plugin mcp.json pointers to ACK MCP HTTP
(2026-09-13):**

OpenAI `mcp.json` (Agent Plugins `streamable-http`) and Codex `.mcp.json`
plus Claude `.mcp.json` (`type: http`) point at
`http://127.0.0.1:8754/mcp`. Daemon still needs `ACK_MCP_HTTP`. Gate stays
`ack hook`. No Apps SDK widgets.

**Added — opt-in MCP streamable HTTP on the daemon
(2026-09-13):**

Set `ACK_MCP_HTTP` (`tcp://127.0.0.1:8754`, `host:port`, or a port) to
serve POST JSON-RPC at `/mcp` (`initialize`, `tools/list`, `tools/call`
over the same v0 methods). Off by default. Unix/tcp NDJSON unchanged.
Watchtower still uses the four frozen v0 RPCs. No Apps SDK widgets, no
plugin `mcp.json` yet. Auth is `Authorization: Bearer` / `X-Ack-Token`
mapped onto `ACK_AUTH_TOKEN`.

**Added — `ack reload` and `ack audit`
(2026-09-13):**

`ack reload` calls the existing daemon `reload` RPC and prints
`character_hash`. `ack audit` reads last-N JSONL from enforcer-audit,
events, companion tool-audit, or ack.jsonl (`--source`, `--denied`,
`--limit`, `--json`). Closes the AGENTS.md "no CLI for audit trail" gap
as read-only last-N, not tail/search. Same kit.

**Changed — Enforcer class and workspace registry live in packages/daemon
(2026-09-13):**

`Enforcer` / `EnforcerWithConfig` / `resolveConfig` moved to
`packages/daemon/src/enforcer.js`. `resolveWorkspaces` /
`registerWorkspace` moved to `registry.js`. `agent_enforcer_daemon.js`
is now env-load + socket bootstrap (~230 lines) and still re-exports
`Enforcer` + `ACK_VERSION`. Watchtower v0 methods unchanged.

**Changed — unix/tcp JSONL listen lives in packages/daemon
(2026-09-13):**

Single-workspace and multi-workspace servers now share
`attachJsonlRpc` + `listenEnforcerSocket` (0660 socket, 0750 dir,
ACK_CLIENT_GROUP chown, stale-unix unlink). Watchtower v0 methods
unchanged. Enforcer class still in `agent_enforcer_daemon.js`.

**Changed — v0 RPC table lives in packages/daemon
(2026-09-13):**

`dispatchV0` moved to `packages/daemon/src/dispatch-v0.js`. Unix and
multi-workspace servers still call it. Method names unchanged. Watchtower
still uses `execute_tool`, `get_habit`, `submit_ack`, `heartbeat`.

**Changed — CLI command bodies live in packages/cli
(2026-09-13):**

Same `ack` binary. Implementations moved from `node/src/cli/` to
`packages/cli/src/` (`@drdeeks/character-kit-cli`). `node/bin/ack.js`
still owns commander + `configure`. Old `node/src/cli/` is in `.trash/`.
Not a separate product.

**Changed — ack repair and ack manage live in node/src/cli
(2026-09-13):**

`ack repair` is `node/src/cli/repair.js`. `ack manage` is `manage.js`.
`node/bin/ack.js` is now the commander shell plus `ack configure` (still
delegates to `install.js`). Same kit, same commands.

**Changed — ack doctor and daemon-process helpers live in node/src/cli
(2026-09-13):**

`ack doctor` is `node/src/cli/doctor.js`. Process/socket helpers
(`findEnforcerDaemons`, `reviveDaemon`, `cleanupStaleResources`, …) are
`daemons.js`. PASS/FAIL printers are `report.js`. `ack repair` and
`ack manage` still run from `node/bin/ack.js` and import those helpers.
Same kit, same commands.

**Changed — ack habit + stdin ask live in node/src/cli
(2026-09-13):**

`ack habit` create/list/delete and the line-buffered `ask()` prompt moved
to `node/src/cli/habit.js` and `ask.js`. `ack manage` / `repair` import
those. Commander still in `node/bin/ack.js`.

**Changed — ack config/status share node/src/cli helpers
(2026-09-13):**

`ack config` (show/verify/set/write-env) and `ack status` run from
`node/src/cli/`. Path/socket/registry helpers live in `workspace.js`.
`ack doctor` / `repair` / `manage` still in `node/bin/ack.js` and import
those helpers. Same kit, same commands.

**Changed — `ack hook` body lives in node/src/cli/hook.js
(2026-09-13):**

Same stdin gate / `--config` wiring. Commander stays in `node/bin/ack.js`.
First CLI split inside this kit, not a new product.

**Docs — "packages/" means folders inside this kit
(2026-09-13):**

Monitor and watchdog stay ACK components (`deploy/ack_monitor.js`,
`deploy/ack_watchdog.js`). A later split into `packages/monitor` and
`packages/watchdog` is only a repo-folder / npm-workspace move under
`@drdeeks/character-kit`. Not a new product, not Federation Watchtower.
`packages/core` / `events` / `protocol` already work the same way.

**Added — daemon emits packages/events JSONL (Phase 2)
(2026-09-13):**

`pick_prompt` now logs `habit.injected` (count only, no prompt text).
`execute_tool` / hold / ack also write `tool.*` and `acknowledgment.*` to
`.agent/logs/events/YYYY-MM-DD.jsonl`. Sink failure never changes the v0
response. Watchtower wire is unchanged.

**Changed — unix and multi-workspace daemons share dispatchV0
(2026-09-13):**

One v0 method table for both socket servers. Method names unchanged.
Watchtower still uses `execute_tool`, `get_habit`, `submit_ack`,
`heartbeat`. `register_workspace` stays multi-workspace only. `status`
still skips auth.

**Docs — Watchtower adapter is a frozen v0 consumer
(2026-09-13):**

Sibling `../watchtower-adapter` speaks NDJSON `execute_tool`, `get_habit`,
`submit_ack`, `heartbeat`. It does not use `pick_prompt` or `tool_tick`.
Those four method names stay. See `docs/adapters/watchtower.md`.

**Changed — Codex/Claude hooks exec `ack hook` instead of importing node/
(2026-09-13):**

Plugin hook scripts spawn `node/bin/ack.js` in the monorepo, or `ack` on
PATH after install. They no longer import `../../../node/src/hooks/character.js`.
`ack hook` treats `SessionStart` as injection (same as UserPromptSubmit).
Root `exports["./hooks"]` still exposes the JS API for mappers.

**Docs — OpenAI Apps SDK is not the ACK plugin
(2026-09-13):**

OpenAI's `build-chatgpt-app` skill is MCP + widget UI. ACK's
`plugins/openai` remains Agent Plugins 1.0.0 + Codex hooks. Adapter and
plugin README now name all three surfaces so we do not scaffold a ChatGPT
App by mistake.

**Changed — daemon deny/allow goes through evaluatePolicy
(2026-09-13):**

`executeTool` hard-constraint / deny-list / allow-list now call
`packages/core` `evaluatePolicy` (same `matchConstraint` rules). `git
commit` still bypasses the allow-list after denies. Habit guards, workspace
integrity, hold, and acks stay in the daemon.

**Changed — habit injection is prompt text only
(2026-09-13):**

`pick_prompt` no longer returns logic/evidence. Pre-LLM formatters
(`pickHabitPrompts`, Hermes `_on_pre_llm_call`) inject a short header plus
2–3 prompt bullets. Reasoning stays in `.agent/habits/*.yaml`. Hold text
stays terse (`acknowledge 2 habits.`). Restart the daemon to pick this up.

**Fixed — Hermes injection and companion advertising (P1)
(2026-09-13):**

`python/hermes_plugin/_on_pre_llm_call` now calls daemon `pick_prompt`
(same rotation as `pickHabitPrompts`). Reminder channel stays fail-open.
Python `EnforcerClient.pick_prompt` matches the Node client. Companion
package no longer claims it never evaluates policy: default core is
in-process `CharacterKitCore` for tests; production hosts pass a
daemon-backed `options.core` or use `processToolCall`.

**Fixed — plugin skill docs vs live CLI/daemon (structure review)
(2026-09-13):**

Habit create does not overwrite; configure --create-habit needs evidence
and level; on-disk hard_constraints replaces the embedded array; installer
`.env` is `$AGENT_WORKSPACE/.env`; service-user-mode is a real boundary;
search-tool exemption includes `web_extract`.

**Fixed — npm pack allowlist, ignore files, and published name
(2026-09-13):**

Root `files[]` now ships `VERSION`, drops `node/tests/` and nested
`node/package.json`, and keeps plugins/packages/Hermes/deploy. Root
`.npmignore` exists (tests, env, sockets, audit logs, reviews). Inert
`node/.npmignore` moved to `.trash/npmignore-superseded-2026-09-13/`.
`AGENTS.md` install line is `npm i -g @drdeeks/character-kit`. Root
`exports` expose `./protocol`, `./core`, `./companion`, `./events`.

**Changed — daemon deny/allow matching lives in packages/core
(2026-09-13):**

`agent_enforcer_daemon.js` `_matches` now calls `matchConstraint` from
`@drdeeks/character-kit-core`. Behavior is unchanged: deny/hard-constraint
is case-insensitive substring; allow-list is glob on tool, command, or
first token. Hold, acks, and habit guards stay in the daemon until the
rest of Phase 3.

**Fixed — OpenAI/Claude plugin hooks no longer evaluate policy locally
(2026-09-13):**

`plugins/openai/hooks` and `plugins/claude/hooks` were calling
`CharacterKitCore` with a hardcoded `rm -rf /` list. That was a second
engine (protocol P1). They now import `processToolCall` /
`processPromptSubmit` from `node/src/hooks/character.js` and ask the live
daemon, same path as `ack hook`.

**Added — full configure context in plugin skills
(2026-09-13):**

OpenAI and Claude skills were hold-ack only. They now split:
- `character-enforcement` — hold, acknowledgment grammar, fail-closed
- `configure-character` — add/update/delete habits, allow/deny and hard
  constraints, hold frequency / required acks / commit thresholds,
  workspace files, reload, privilege modes

Details live in each skill's `references/` (OpenAI skill packaging).
Numbers match the live daemon (`hold_every_n_calls=5`, `required_acks=2`,
and the rest of the env/YAML table).

**Added — OpenAI Agent Plugins 1.0.0 package layout
(2026-09-13):**

Reviewed OpenAI's current plugin docs (package + skills) and the Apps SDK
examples repo. ChatGPT/Codex plugins are Agent Plugins packages, not Chat
Completions interceptors. Apps SDK examples are MCP widget servers
(`_meta.ui.resourceUri`); ACK does not ship that.

`plugins/openai/` now has:
- portable root `plugin.json` (`agent-plugins.org` schema 1.0.0,
  `extensions.com.openai` for hooks and interface)
- `.codex-plugin/plugin.json` compatibility fallback
- `skills/character-enforcement/SKILL.md`
- Codex `hooks/hooks.json` (`PreToolUse`, `SessionStart`)
- repo marketplace `.agents/plugins/marketplace.json`

The Chat Completions mapper stays in `plugins/openai/src/` for custom
OpenAI-compatible HTTP hosts. No `mcp.json` until the daemon exposes
streamable HTTP.

**Added — v2 Phase 0 host-neutral packages and provider plugins
(2026-09-13):**

Live runtime is still 1.6.0 (`node/enforcer/agent_enforcer_daemon.js` and
v0 NDJSON RPC). This is additive, not a 2.0.0 cut. Plan:
`docs/refactor-plan.md`. Tracking: `AGENTS.md` (file map + v2 status).

New npm workspaces:
- `@drdeeks/character-kit-protocol` — v0/v1 envelope, `ToolDecision`,
  `Requirement`, error codes, capability negotiation
- `@drdeeks/character-kit-core` — `PolicyEngine` (DENY > HOLD > ALLOW),
  in-memory `StateStore`, `CharacterKitCore` plugin surface
- `@drdeeks/character-kit-events` — canonical enforcement events, JSONL
  sink, redaction (no RL reward)
- `@drdeeks/character-kit-companion` — thin factory, no policy
- `@drdeeks/character-kit-openai` — Chat Completions adapter
- `@drdeeks/character-kit-hermes` — Hermes-shaped Node adapter
- `plugins/claude/` — real Claude Code plugin (PreToolUse +
  UserPromptSubmit + skill)

Docs: `docs/protocol/` and `docs/adapters/` are the living contracts.
Superseded design files (`REFACTOR_PLAN.md`, `openai-character-kit.md`,
Anthropic `example-plugin-claude/`) moved to
`.trash/docs-superseded-2026-09-13/`.

Tests added: hard-constraint deny of `rm -rf /`, v0/v1 `parseIncoming`,
idempotent `beforeTool`. `forever-validation.py` PASS on the new/updated
files. Full `npm test` still has three `postinstall.test.js` failures
(`gray-matter` missing in the fake global copy).

Not in this change: daemon cutover (Phase 3), CLI split, monitor/watchdog
packages, version bump to 2.0.0.

**Added — `ack manage`: interactive menu for viewing/editing every agent
(2026-08-12, 0ee7233):**

There was no re-enterable way to see every registered agent and change one
without re-running the whole `ack configure` wizard from scratch. `ack
manage` lists every agent (registry-backed, or the single default workspace
when no registry exists) with live daemon status, then per agent: full
status report, list/create/delete habits, start/stop/restart the daemon,
re-run `ack configure` scoped to that workspace, and remove an agent from
the registry. Daemon start/restart poll the socket to confirm real
liveness instead of trusting a spawned pid or systemctl's exit code.
Root-mode daemon control is labeled as affecting the ONE shared
`agent-enforcer.service`, not just the selected agent. Also added `ack
habit delete`. Menu-choice parsing and agent-list building are pure,
unit-tested functions (`node/src/manage-menu.js`); covered end-to-end by
`node/tests/ack-manage.test.js` (real spawned-process walks checking actual
file/registry/daemon state).

Fixed `ack.js`'s `ask()` stdin helper in the same pass: it resolved on a
single raw `data` event and `.trim()`'d the whole chunk, so multiple
answers landing in one chunk (piped input, fast typing/paste) silently
collapsed into one garbage answer. Now properly line-buffers.

**Fixed — ack/inject logs no longer default to `/tmp` (2026-08-12, d9866a4):**

`character.js`, both `ack_monitor.js`/`.py`, and `hermes_plugin/__init__.py`
defaulted the ack-detection and habit-injection logs to `/tmp/...` —
tmpfs on many distros, doesn't survive a reboot, not a real
always-retrievable record. Now resolve into the persistent
`<workspace>/.agent/` directory instead. Also: `agent_enforcer_daemon.js`'s
`_audit()` now logs every `tool_tick` and `submit_ack` outcome (holds,
denial reasons, unknown-habit, reused-ack, cycle-complete) to
`enforcer-audit.jsonl`, not just tool-call allow/deny decisions.

**Fixed — root-owned registry silently broke plain-user `ack configure`
(2026-08-12, bad9207):**

`resolveWorkspaces()` set `hasRegistry=true` as soon as the registry file
*existed*, before attempting to read it — so a root-owned registry left
over from an unrelated root-mode deploy (unreadable, EACCES, to a plain
user) still forced a single-user `ack configure` into multi-workspace
socket naming, which nothing in `ack.js`'s status/liveness checks looks
for — every liveness check reported the daemon dead even though it was
alive and correct. `hasRegistry` now only flips after a successful
read+parse. Full suite went from 94/104 to 104/104 passing once fixed.

## 1.5.0 — 2026-08-07

**Added — real multi-agent support (KD-21, 5 commits: b7a62bc, 152e5eb,
74ee90d, 5c1381b, and this doc/version pass):**

One enforcer daemon now holds every agent on a machine, not one shared
generic instance indistinguishable between them. drdeek's spec, refined
through several corrections during the build: "how do you know if you have
12 agents running at the same time on one sock which one is doing what? It
would get gridlock."

- **Real per-agent identity resolution** (`node/src/agent-identity.js`,
  new): a real name for each agent's socket, resolved in order —
  `agent.json`'s `name` field, then `SOUL.md` (YAML frontmatter `name:`,
  else its first `#` heading), then (for a known terminal harness —
  claude/hermes/opencode — not being used in a delegated multi-agent setup)
  the harness's own name with no prompt, then a direct interactive prompt,
  then `"generic"` as the last resort. Read-only — never writes to an
  identity file, never used in any enforcement decision.
- **Agents nest under one shared enforcer root**, not their own top-level
  workspace: `<enforcer-root>/agents/<agent-name>/`, each with fully
  independent `constitution.yaml`/`enforcer.yaml`/`habits/` — genuine
  per-agent tailoring (lighten/tighten enforcement per agent), not shared
  rules with per-agent naming as a coat of paint.
- **Sockets are named per agent**, not a shared literal `enforcer.sock`
  every workspace used indistinguishably — `<agent-name>.sock`, consistent
  from the very first agent registered onward (multi-workspace mode is now
  forced by the mere existence of the registry, not just "more than one
  workspace," so agent #1's socket path never silently changes later when
  agent #2 gets added).
- **`deploy-agent-enforcer.sh`** now registers each deployed agent in a
  shared registry (`/var/lib/agent-character-kit/workspaces.json`,
  idempotent), and auto-restarts the enforcer + monitor when a new agent
  joins an already-populated registry (`systemctl enable --now` is a no-op
  on an already-active unit, so without this a new agent's socket would
  silently never appear).
- **The monitor is now agent-aware**: one process, but it tails every
  registered agent's own ack log independently and credits that agent's
  own socket — proven via a real end-to-end test (a real spawned daemon +
  real spawned monitor + a real 2-agent registry), including an explicit
  cross-contamination check.
- **`ack status`/`doctor`/`repair`** now report each registered agent
  individually instead of folding everything into one opaque "root
  (systemd)" entry.
- **The watchdog needed no changes** — confirmed it already only checks
  "is *the* monitor process alive" / "is *the* enforcer process alive" via
  process-pattern matching, with zero per-agent assumptions baked in.

**Fixed, found while building the above:**
- `deploy-agent-enforcer.sh` looked parameterized by `$AGENT_WORKSPACE`
  but every seeding path actually hardcoded the literal string
  `$VAR_DIR/workspace` — passing a different `AGENT_WORKSPACE` per agent
  would have silently seeded the same shared path every time regardless.
- The registry path was originally derived from `dirname($AGENT_WORKSPACE)`,
  which for a nested agent path resolves one directory off from the fixed
  location `ack status` and the daemon actually default to checking when no
  explicit env var is set (the normal case for a human running commands by
  hand, not through systemd's env). Introduced a real fixed `ACK_VAR_ROOT`.
- `deploy-ack-services.sh` independently re-writes the same monitor/
  watchdog unit files `deploy-agent-enforcer.sh` already wrote (real
  pre-existing duplication between the two scripts) — would have silently
  clobbered the registry env line since the documented flow runs both in
  sequence. Worked around by injecting the same env line in both places;
  untangling the duplication itself is still open.

**32 new tests this pass, all confirmed passing individually, not just by
aggregate count. 87/87 full suite passing.**

**Known gaps, explicitly not done:** `ack config` has no registry
awareness yet. The Python monitor/watchdog equivalents (Hermes-only path)
weren't updated to match the Node monitor's rewrite. Repair can now *see*
which specific agent is down but doesn't yet selectively heal just that
one. Real systemd/sudo verification of the full chain still needs a human
— everything above is proven against real spawned processes in tests, not
against actual systemd.

**Update, later the same day (10cf9c5, e6402cf, 8ed70c5):** three of the
five gaps above are closed. `deploy/ack_monitor.py` ported to the same
multi-agent design as `ack_monitor.js` — verified live (real spawned
daemon + monitor against a real 2-agent registry, cross-contamination
check included) before the automated test was even written; 4/4 Python
suite passing. `deploy-agent-enforcer.sh`/`deploy-ack-services.sh`'s
duplication untangled for real, not just worked around — the enforcer
script no longer writes or enables the monitor/watchdog units at all,
since it never installed their binaries in the first place;
`deploy-ack-services.sh` is now their sole owner. `ack config
show/verify/write-env` all gained a real `--agent <name>` option,
registry-aware, verified live before the 5 new tests were written (`ack
config set` deliberately left alone — pure passthrough, no per-agent
resolution to hook into). Still open: repair's selective per-agent
healing, and real systemd/sudo verification of the whole chain.

**Update, later the same day (7b0b703): fail-safe audit of every
interactive prompt/flag in `install.js` + `ack.js`.** Triggered by drdeek
live-catching the harness-selection menu silently wiring all detected
harnesses on blank Enter with no visible warning (fixed earlier same day,
6d08403). Same bug class found and fixed in 5 more places: the
privilege-mode prompt (blank Enter used to default to `"1"`/root+sudo,
the MOST privileged option — now requires explicit 1/2/3, no default at
all); the "no harness detected" fallback (blank input silently picked
`"generic"` with zero warning — now explains and requires a y/N
confirmation); `configure --all` (despite its own "Everything"
description, only ever installed ONE harness — now loops over all
detected harnesses, matching `--yes`); `repair --reinstall` (overwrote
existing habit files with zero confirmation — now lists exactly which
files get clobbered and requires y/N, with a `--yes` escape hatch for
scripted use); `--harness` help text (falsely implied cursor/gemini get
the same auto-detection/auto-naming as claude/hermes/opencode — they
don't, only hook generation). 103/103 Node + 4/4 Python passing.

**Update, later the same day (8be35f6): root cause of a live root-mode
install self-lockout, found and fixed.** drdeek ran a real root-mode
install (claude harness) to test the audit above; it wired the
PreToolUse/UserPromptSubmit hooks into his own live `$HOME/.claude/settings.json`
as designed, then every subsequent tool call in that same session started
failing — `"Enforcer unavailable: enforcer socket not found"` — fail-closed
by design, so killing the daemon or deleting the socket didn't help either;
recovery required manually stripping the hook keys back out of
`settings.json` (`jq del(.hooks.PreToolUse, .hooks.UserPromptSubmit)`).
Root cause, found by reading the deploy script directly rather than
guessing: `deploy-agent-enforcer.sh` correctly set up the socket's
directory (`RUN_DIR`, setgid + the `ack-clients` client group) but a
second, unrelated `install -d` on `$AGENT_WORKSPACE/.agent` — the same
path as `RUN_DIR` in the current per-agent architecture — ran right after
and silently clobbered it back to `root:$SERVICE_GROUP`/0750, no setgid.
The socket always came up `root:root`, unreachable by the agent's own uid
no matter how many times the client group was granted or the session
restarted. Fixed: reordered the two `install -d` calls so `RUN_DIR`'s
cross-uid setup always wins; added a daemon-side `chownSync`-to-client-group
on every socket bind (`agent_enforcer_daemon.js`, new `secureSocketFile()`
helper) as defense in depth, independent of directory-setgid semantics,
threaded through via a new `ACK_CLIENT_GROUP` env var on the systemd unit.
Also fixed in the same pass: the misleading error message itself
(`client.js`'s `fs.existsSync()` pre-check swallowed every stat error —
ENOENT, EACCES, anything — into the same generic "socket not found" text,
which is why a real permission-denied got reported as a missing file and
cost real diagnostic time; now connects directly and reports the real
`err.code`); the install summary's false "daemon + monitor + watchdog
already running via systemd" claim (never checked, and
`deployRootIfNeeded()` never actually deployed `deploy-ack-services.sh` at
all — acknowledgments silently never got credited; now actually deploys
monitor/watchdog if not already active, checked via `systemctl is-active`,
and reports real state either way); stale pre-multi-agent Workspace/Ack-log
paths in the summary (ignored `inst.ws`, the correct per-agent path, in
favor of `process.env.AGENT_WORKSPACE` or a hardcoded single-workspace
fallback left over from before the per-agent redesign). Also trimmed the
privilege-mode prompt from a 24-line wall of text repeating in full on
every single run to 5 lines with the same real information, after drdeek
called out over-explaining the least consequential part of the wizard
while under-explaining what the install summary actually did — full detail
pushed to AGENTS.md instead of inlined every time. 104/104 Node tests
passing. Still open, unchanged from above: repair's selective per-agent
healing, and a *fresh* real systemd/sudo verification of the corrected
socket-permission code specifically (the bug above was found via a real
systemd deploy; the fix itself has not yet been re-verified against one).

**Update, next day (2026-08-08, `eee4f95`/`9105f41`/`b752479`/`422f7fd`):
the socket-permission fix above was wrong, and it took 4 more commits —
each one live-tested by drdeek, each one catching a real remaining bug —
to actually get it right.** Full trace, honestly:
- `eee4f95` — a real, separate bug found first: redeploying never
  restarted an already-running daemon (`systemctl enable --now` is a no-op
  on an already-active unit), so no code fix could ever take effect on a
  redeploy without an unrelated manual restart. Fixed: redeploy now always
  restarts.
- `8be35f6`'s fix was **wrong**, not just untested. It derived the
  cross-uid directory from `RUN_DIR="$(dirname "$ENFORCER_SOCKET")"`,
  assuming that equals `$AGENT_WORKSPACE/.agent`. Only true if
  `ENFORCER_SOCKET` is explicitly set to match — nothing in the real call
  chain does that, and the daemon never even reads it once a registry
  exists (routes to `startMultiWorkspaceDaemon()` instead, which computes
  socket paths from the workspace itself). Confirmed live: fresh daemon
  restart, socket still `root:root`.
- `9105f41` — fixed the file's group correctly this time (`root
  ack-clients`, confirmed via `sudo ls -la`), by applying the setup
  directly to `$AGENT_WORKSPACE/.agent` instead of `RUN_DIR`. Still
  incomplete: a plain `ls` (no sudo) still failed — the file's group was
  right, but *traversal* into its ancestor directories wasn't.
- `b752479` — fixed traversal on `$VAR_DIR`/`$AGENT_WORKSPACE`
  (`0710`, client-group execute-only). Still incomplete: `namei -l`
  on the real path showed the actual remaining block was at
  `$ACK_VAR_ROOT` (`/var/lib/agent-character-kit`) — a separate, higher
  ancestor, since `$AGENT_WORKSPACE` is nested three levels under it, not
  one.
- `422f7fd` — the real, complete fix: walks every directory level from
  `$ACK_VAR_ROOT` down to `$AGENT_WORKSPACE`, granting client-group
  traversal regardless of nesting depth. Also caught two more real
  clobbers auditing the rest of the script: a `chown -R` that reset the
  `.agent` directory's own group every deploy (now non-recursive, targets
  only the two config files it's meant to secure), and a second redundant
  `install -d` on `$ACK_VAR_ROOT` later in the script (registry setup)
  that re-clobbered the fix every single run.
- **Confirmed working, for real, live:** `ls -la` (no sudo) on the socket
  succeeded — `srw-rw---- 1 root ack-clients .../claude.sock`. One
  intermediate false alarm ("No such file or directory") turned out to be
  a pure timing race (`ls` ran ~55ms after the daemon started, before its
  async socket bind finished) — confirmed via `sudo find` and the
  daemon's own "listening on..." log, not just assumed.

104/104 tests passing throughout — none of these four bugs could have
been caught by the JS test suite, since all four live entirely in
`deploy-agent-enforcer.sh`'s bash/filesystem logic, which nothing in
`node/tests/` executes for real. **Lesson kept in memory
(`rigor_no_half_assing`): for anything with a real shell/deploy-script
component, code-reading confidence is not verification, even when the
reasoning is careful and unit tests stay green — only an actual run
against real system state proves it.** Root-mode install is genuinely
trustworthy again as of `422f7fd`.

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
`$HOME/.claude/settings.json` PreToolUse hook.

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
