# ACK plugin-structure review (2026-09-13)

> Historical snapshot of kit **1.6.0**. Live kit is **1.7.0** (`CHANGELOG.md`, `AGENTS.md`). Version stamps in this file are not current.

Scope: harness plugin packaging only (OpenAI Agent Plugins 1.0.0, Claude Code,
Hermes). Live tree compared to `AGENTS.md`, `docs/refactor-plan.md`,
`docs/adapters/*.md`, `docs/protocol/*.md`, `node/enforcer/agent_enforcer_daemon.js`,
and `node/bin/ack.js`. Daemon runtime was not rewritten. Nothing was published
to npm.

Live socket remains the 1.6.0 daemon. `packages/core` `CharacterKitCore` is
additive v2 code, not the live enforcer.

---

## Accurate

### OpenAI Agent Plugins 1.0.0 identity (`plugins/openai/`)

- Root `plugins/openai/plugin.json` matches
  `https://agent-plugins.org/schemas/1.0.0/plugin.schema.json`: required
  `$schema` + `name`, `additionalProperties` false at the root, host extras
  only under `extensions.com.openai`. Name `agent-character-kit` satisfies the
  kebab-case pattern. Version `1.6.0` matches the kit stamp.
- No `skills` field on the portable manifest. Skills are discovered from
  `plugins/openai/skills/` (`character-enforcement` and `configure-character`,
  each with `name` + `description` frontmatter).
- `.codex-plugin/plugin.json` is a Codex fallback (skills + hooks paths), not
  the Agent Plugins 1.0.0 document. Paths `./skills/` and `./hooks/hooks.json`
  are correct if Codex resolves them from the plugin root (parent of
  `.codex-plugin/`), which matches the current OpenAI scaffold.
- `extensions.com.openai.hooks` is `./hooks/hooks.json`. That file exists and
  wires `PreToolUse` + `SessionStart`.
- `.agents/plugins/marketplace.json` exists at the ACK repo root. Entry
  `source.path` is `./plugins/openai`, `./`-prefixed and relative to the
  marketplace root (repo root), not relative to `.agents/plugins/`. Policy
  `installation` / `authentication` and `category` are present.
- `plugins/openai/src/` is a Chat Completions mapper (`createOpenAiAdapter`),
  not the installable plugin identity. README and adapter doc say this.
- No `mcp.json`. Adapter and README correctly say the daemon is still unix/tcp,
  not streamable HTTP. Apps SDK widget packaging is correctly disclaimed.

### OpenAI / Claude installable hooks (gate path)

Live hook files no longer construct local `hardConstraints`. They import the
existing `ack hook` implementation:

- `plugins/openai/hooks/pre-tool-use.js` → `processToolCall` in
  `node/src/hooks/character.js`
- `plugins/openai/hooks/session-start.js` → `processPromptSubmit`
- `plugins/claude/hooks/pre-tool-use.js` → `processToolCall` (framework
  `claude`)
- `plugins/claude/hooks/user-prompt-submit.js` → `processPromptSubmit`

`processToolCall` asks `EnforcerClient.validateTool` (`execute_tool` RPC) then
`toolTick`. Unreachable daemon maps to `allowed: false`. `processPromptSubmit`
asks `pickPrompt`. That is the live companion path, not a second policy engine.

Claude layout matches Claude Code conventions: only
`plugins/claude/.claude-plugin/plugin.json` lives under `.claude-plugin/`;
`hooks/` and `skills/` sit beside it. Manifest `name` is the only required
Claude field; `hooks/hooks.json` is auto-loaded (the manifest correctly does
not re-point `hooks` at the default file).

`docs/example-plugin-claude/` is gone from `docs/`. The Anthropic demo is in
`.trash/docs-superseded-2026-09-13/example-plugin-claude/`. Adapter
`docs/adapters/claude.md` states that move. Relative links in
`docs/adapters/*.md`, `docs/protocol/plugin.md`, `plugins/openai/README.md`,
and `plugins/claude/README.md` all resolve.

### Skills coverage (product surface)

OpenAI and Claude skill *bodies* (references) are byte-identical. SKILL.md
files differ only by a Claude-Code phrase in `description`.

Together they still cover:

- Habits CRUD and YAML fields — `skills/*/configure-character/references/habits.md`
- Allow/deny + hard constraints — `references/policy.md`
- Hold frequency, required acks, commit thresholds — `references/frequency.md`
- Workspace / env / reload / privilege modes — `references/workspace.md`
- Hold/ack grammar — `skills/*/character-enforcement/references/acknowledge.md`

Frequency table keys that exist on the live daemon match
`node/enforcer/agent_enforcer_daemon.js`:

| YAML key | Env | Default on daemon |
|---|---|---|
| `hold_every_n_calls` | `ACK_HOLD_EVERY_N_CALLS` | 5 |
| `required_acks` | `ACK_REQUIRED_ACKS` | 2 |
| `min_ack_reason_chars` | `ACK_MIN_ACK_REASON_CHARS` | 12 |
| `max_ack_reason_history` | `ACK_MAX_ACK_REASON_HISTORY` | 10 |
| `max_habit_name_history` | `ACK_MAX_HABIT_NAME_HISTORY` | 10 |
| `file_change_threshold` | `ACK_FILE_CHANGE_THRESHOLD` | 5 |
| `commit_every_n_cycles` | `ACK_COMMIT_EVERY_N_CYCLES` | 4 |
| `commit_min_chars` | `ACK_COMMIT_MIN_CHARS` | 150 |
| `search_tools` | `ACK_SEARCH_TOOLS` | `search_files,read_file,web_search,web_extract,glob,grep,read` |

`ack habit list|create|delete` and `ack manage` exist on `node/bin/ack.js`.
`ack hook` takes framework as a positional argument (`claude`, not
`--framework`). Policy.md's deny probe uses that shape.
`git commit` is skipped by the allow-list in `executeTool` (hard constraints
and secret-leak still apply). `reload` RPC exists; there is no `ack reload`
flag. `inject_enabled` is Hermes plugin config (`python/hermes_plugin/config.yaml`),
not an `enforcer.yaml` key.

### Hermes installed companion

`python/hermes_plugin/__init__.py` is still the installed Hermes companion.
`pre_tool_call` uses `EnforcerClient.validate_tool` plus `tool_tick` RPC and
blocks when the socket is down. That gate is P1-clean.

---

## Inaccurate/stale

### Adapter / README vs live package contents

- `docs/adapters/openai.md` "What this package contains" lists only
  `skills/character-enforcement/`. Live tree and `plugins/openai/README.md`
  also ship `skills/configure-character/` (habits, allow/deny, frequency,
  workspace).
- `plugins/claude/README.md` says policy stays in "the ACK core and daemon."
  Live Claude hooks do not call `CharacterKitCore`. They call
  `node/src/hooks/character.js` → daemon. `docs/adapters/claude.md` is the
  accurate wording ("Local `CharacterKitCore` is not on this path").
- `docs/adapters/hermes.md` and `plugins/hermes/src/index.js` comment claim
  the Node adapter is "the same mapping" so Hermes does not get a second
  engine. Live `createHermesAdapter` uses `createCompanion` →
  `CharacterKitCore` / `PolicyEngine` in-process. It does not open the
  daemon socket. The Python plugin is the daemon client; the Node module is
  not the same mapping.
- `plugins/openai/README.md` says `src/` "still must not evaluate
  constitution." `createOpenAiAdapter` always constructs `CharacterKitCore`
  via `createCompanion`. Empty policy currently allows every command and
  never fail-closes on a dead daemon.

### Skill references vs CLI / daemon

**`references/habits.md` (OpenAI and Claude copies)**

- Claims `ack habit create` of an existing name "overwrites after
  confirmation unless `--yes`." Live `createHabitInteractive` in
  `node/bin/ack.js` does the opposite: if the file exists and a name was
  passed, it prints "Habit already exists" and `process.exit(1)`. There is
  no `--yes` on `ack habit create`. `ack habit delete` is the command with
  `-y/--yes`.
- `ack configure --create-habit` is documented as needing `--habit-name`,
  `--habit-prompt`, `--habit-logic`. Live `node/bin/install.js` requires
  those plus `--habit-evidence` and `--habit-level`. Existing files throw
  `habit already exists` (no overwrite).

**`references/policy.md`**

- "Embedded defaults already include `rm -rf /` and similar destructive
  shapes." Live `DEFAULT_CONSTITUTION.hard_constraints` is only `rm -rf /`.
  Opinionated shapes (`git push --force`, `chmod 777`) are habits, not
  embedded hard constraints (`AGENTS.md` / README / daemon comments).
- "Your list merges on top; it does not wipe the embedded character unless
  you replace the whole file with an empty constraints list." Live load is
  shallow `Object.assign({}, DEFAULT_CONSTITUTION, fileConstitution)`. Any
  on-disk `hard_constraints:` key **replaces** the array. A file that only
  lists `git push --force` drops the embedded `rm -rf /`.
- Deny probe `node node/bin/ack.js hook claude` only works from the kit
  checkout. After a marketplace or Claude-plugin copy, `ack hook claude` (if
  on `PATH`) is the real command.

**`references/acknowledge.md` vs `references/frequency.md` vs daemon**

- Frequency table includes `web_extract` in `search_tools` (matches daemon
  default string).
- Acknowledge.md omits `web_extract` from the exempt-tool list
  (`search_files`, `read_file`, `web_search`, `glob`, `grep`, `read` only).

**`references/workspace.md`**

- Layout puts `.env` at `$AGENT_WORKSPACE/.agent/.env`. `ack configure` /
  `ack config write-env` write `$AGENT_WORKSPACE/.env`. The daemon *reads*
  `$AGENT_WORKSPACE/.agent/.env` first, then CWD, then repo root. The skill
  documents the load path the installer does not write.
- "root-mode: systemd units; only this is a real privilege boundary."
  `AGENTS.md` treats **service-user-mode** as the same write/kill boundary
  without full root. Root-mode is not the only real boundary.
- Interactive surfaces omit `ack config set` (live subcommand:
  `workspace|socket|ack-log`).

**`references/frequency.md`**

Hold/commit knobs are correct. These live `enforcer.yaml` / env keys are
unread in the skill table even though the daemon parses them:

- `heartbeat_stale_seconds` / `ACK_HEARTBEAT_STALE_SECONDS` (default 600)
- `validation_interval_ms` / `ACK_VALIDATION_INTERVAL_MS` (default 30000)
- `audit_max_command_chars` / `ACK_AUDIT_MAX_COMMAND_CHARS` (default 500)

### Hermes companion docs vs files

- `python/hermes_plugin/plugin.yaml` `version` is `1.0.0`. Module
  `ACK_VERSION` is `1.6.0`.
- `plugin.yaml` `hooks` lists only `pre_tool_call`. `register()` also binds
  `pre_llm_call`.
- `python/hermes_plugin/config.yaml` comments still say default
  `inject_log` / `ack_log` live under `/tmp/...`. Live `__init__.py`
  defaults those to `$AGENT_WORKSPACE/.agent/ack-inject-log.jsonl` and
  `ack.jsonl`.
- `python/hermes_plugin/README.md` still uses `$HOME/.hermes/plugins/...`
  and a `$HOME/.openclaw/workspace/.agent/constitution.yaml` example (kit
  default workspace is `$HOME/.agent-character-kit/workspace`). It points at
  `FOREVER-SYSTEM.md`, which is not in this repo root. Verify section
  "fails CLOSED when constitution unloadable" conflicts with the daemon's
  embedded defaults (no constitution file is not a hard fail).

### Refactor-plan leftovers (not live plugin files, but SoT drift)

`docs/refactor-plan.md` §0 and §6.2 still talk about
`docs/example-plugin-claude/` as a current layout source and about moving
`python/hermes_plugin/` into `plugins/hermes/`. The example is already in
`.trash/`. `plugins/hermes/` is a Node adapter; the installed companion is
still `python/hermes_plugin/`.

---

## Protocol P1 violations

P1: plugins must ask the daemon (or a companion that talks to the daemon).
They must not evaluate constitution / habits / allow-deny as a second engine.

### Clean (ask-and-obey)

| Path | Behavior |
|---|---|
| `plugins/openai/hooks/pre-tool-use.js` | `processToolCall` → `execute_tool` + `tool_tick` |
| `plugins/openai/hooks/session-start.js` | `processPromptSubmit` → `pick_prompt` |
| `plugins/claude/hooks/pre-tool-use.js` | same as OpenAI PreToolUse |
| `plugins/claude/hooks/user-prompt-submit.js` | `processPromptSubmit` → `pick_prompt` |
| `python/hermes_plugin/` `pre_tool_call` | `validate_tool` + `tool_tick`; fail-closed |

No remaining hook in `plugins/openai/hooks/` or `plugins/claude/hooks/`
builds a local `hardConstraints` list or decides allow/deny without RPC.

### Still a second engine

**`plugins/openai/src/index.js` (`createOpenAiAdapter`)**

Not the ChatGPT/Codex package identity, but it is the OpenAI *runtime mapper*
named in adapter docs. It calls `createCompanion(options)` →
`packages/core/src/plugin.js` `CharacterKitCore` →
`packages/core/src/policy/engine.js` `evaluatePolicy` (local
`hardConstraints` / `denyList` / `allowList`). No `EnforcerClient`. Empty
policy ⇒ allow. Dead daemon ⇒ still allow. That is in-process policy, not
RPC.

**`plugins/hermes/src/index.js` (`createHermesAdapter`)**

Same factory. `preToolCall` is `companion.beforeTool` against the in-memory
engine. Comment "so Hermes does not get a second engine" is false.

**`packages/companion/src/index.js`**

Package description says "ask the core, obey, never evaluate policy." The
factory instantiates `CharacterKitCore`, which *is* the evaluator. Until
Phase 3 cutover, "core" is not the live daemon.

**`python/hermes_plugin/` injection channel (not allow/deny)**

`_on_pre_llm_call` does **not** call `pick_prompt`. It reads habit YAML from
disk (`_collect_habits`) and rotates in process (`_HABIT_CYCLE`). The daemon
comment in `agent_enforcer_daemon.js` says rotation must live in the daemon
so CLI-per-call hosts actually rotate; Hermes *could* track locally, but
routing everyone through `pick_prompt` is the stated one-source rule.
`character.js` already documents that the Python companion still does local
rotation. Gate is P1-clean; injection is a second habit engine.

**Not a plugin hook, but adjacent:** `python/agent_character_kit/enforcer.py`
class `Enforcer` still mirrors daemon policy in-process. The Hermes plugin
gate uses `EnforcerClient`, not that class.

---

## Missing

### Packaging / installability

- `plugins/hermes/README.md` — adapter doc exists; the plugin directory has
  no README. `plugins/openai/README.md` and `plugins/claude/README.md` do.
- `plugins/claude/package.json` — Claude hooks are ESM (`import`). They
  resolve `"type": "module"` only by walking up to the kit root
  `package.json`. Root `workspaces` lists `plugins/openai` and
  `plugins/hermes`, not `plugins/claude`. A copied Claude plugin tree has
  no package identity and no declared dependency on the hook implementation.
- Hook commands are `node hooks/pre-tool-use.js` (and session/prompt
  siblings) with no `${CLAUDE_PLUGIN_ROOT}` / plugin-root prefix. They
  assume cwd is the plugin directory.
- OpenAI and Claude hooks import
  `../../../node/src/hooks/character.js`. That only works inside this
  monorepo. A Codex marketplace install of `./plugins/openai` alone cannot
  load `node/src/hooks/character.js` or `@drdeeks/character-kit-*`. The
  portable package is not self-contained.
- Claude plugin has no `.mcp.json` and no `commands/` (optional in
  `docs/refactor-plan.md` §6.2). Honest, but the plan's listed layout is
  not fully present.
- No `PostToolUse` wiring. Refactor-plan host-event table includes it;
  live `hooks/hooks.json` files do not.

### Skills / docs gaps

- `docs/adapters/openai.md` does not mention `configure-character`.
- Frequency skill omits three daemon-parsed `enforcer.yaml` keys listed
  under Inaccurate/stale.
- OpenAI `SessionStart` hook calls `processPromptSubmit(..., { framework:
  "claude" })` then overwrites `hookEventName` to `SessionStart`. Codex
  SessionStart payload/output shape is not documented in
  `docs/adapters/openai.md`. If Codex ignores Claude
  `hookSpecificOutput.additionalContext`, the reminder channel is silent.
- Hermes Node adapter has no fail-closed-on-unreachable-daemon behavior
  and no README stating that it is **not** the installed companion.

---

## Recommended fixes (concrete file paths)

Do not publish. Prefer docs/path fixes unless a one-line import path is
wrong. Runtime policy must stay in the daemon.

### P1 — stop the second engine on mapper adapters

- `plugins/openai/src/index.js` — `createOpenAiAdapter` should call
  `processToolCall` / `processPromptSubmit` (or `EnforcerClient`) the same
  way `plugins/openai/hooks/pre-tool-use.js` does. Do not pass `policy:
  { hardConstraints: ... }` into `createCompanion`.
- `plugins/hermes/src/index.js` — same: `preToolCall` must RPC
  `execute_tool` + `tool_tick`; `preLlmCall` must RPC `pick_prompt`. Rewrite
  the file comment that claims this is not a second engine.
- `docs/adapters/openai.md` (Runtime mapper section) and
  `docs/adapters/hermes.md` — say explicitly that live `src/` adapters still
  instantiate `CharacterKitCore` until those files change.
- `packages/companion/src/index.js` — either wrap `EnforcerClient` or stop
  advertising "never evaluate policy" while constructing `PolicyEngine`.

### P1 — Hermes injection

- `python/hermes_plugin/__init__.py` `_on_pre_llm_call` — replace
  `_collect_habits` / `_HABIT_CYCLE` with the existing `pick_prompt` RPC
  (same as `node/src/hooks/character.js` `pickHabitPrompts`). Keep
  fail-open-on-injection (reminder channel must not block).

### Docs that do not match live files

- `docs/adapters/openai.md` — add `skills/configure-character/` to the
  package list; document Codex `SessionStart` output shape actually emitted
  by `plugins/openai/hooks/session-start.js`.
- `plugins/claude/README.md` — drop "ACK core" as a policy owner; point at
  `node/src/hooks/character.js` + daemon, matching `docs/adapters/claude.md`.
- `plugins/openai/skills/configure-character/references/habits.md` and the
  identical Claude copy — replace the overwrite/`--yes` sentence with:
  existing name exits 1; delete uses `ack habit delete <name> --yes`;
  `--create-habit` needs `--habit-name --habit-prompt --habit-logic
  --habit-evidence --habit-level`.
- `plugins/openai/skills/configure-character/references/policy.md` and
  Claude copy — state shallow replace of `hard_constraints`; embedded list
  is only `rm -rf /`; probe command `ack hook claude`.
- `plugins/openai/skills/character-enforcement/references/acknowledge.md`
  and Claude copy — add `web_extract` to the exempt-tool list so it matches
  `references/frequency.md` and the daemon default string.
- `plugins/openai/skills/configure-character/references/workspace.md` and
  Claude copy — `.env` written to `$AGENT_WORKSPACE/.env`; daemon also
  checks `$AGENT_WORKSPACE/.agent/.env`; service-user-mode is a real
  boundary; mention `ack config set`.
- `plugins/openai/skills/configure-character/references/frequency.md` and
  Claude copy — add the three extra daemon keys or state they are
  watchdog/audit-only and unused by the hold loop.
- `python/hermes_plugin/plugin.yaml` — `version: "1.6.0"`; add
  `pre_llm_call` to `hooks`.
- `python/hermes_plugin/config.yaml` — comments must match
  `$AGENT_WORKSPACE/.agent/` defaults, not `/tmp`.
- `python/hermes_plugin/README.md` — install dir `$HOME/.hermes/plugins/agent-character-kit`;
  workspace `$AGENT_WORKSPACE` (default `$HOME/.agent-character-kit/workspace`);
  remove the missing `FOREVER-SYSTEM.md` pointer.
- Add `plugins/hermes/README.md` stating: installed companion is
  `python/hermes_plugin/`; `src/index.js` is a Node mapper and currently
  not a daemon client.

### Packaging so marketplace / Claude install actually runs the RPC hooks

- `plugins/openai/hooks/hooks.json` and
  `plugins/claude/hooks/hooks.json` — prefix commands with the host plugin
  root (`${CLAUDE_PLUGIN_ROOT}/hooks/pre-tool-use.js` on Claude).
- Stop importing `../../../node/src/hooks/character.js` from a portable
  package. Either:
  - ship a tiny hook that execs `node $AGENT_WORKSPACE/...` / `ack hook <host>`, or
  - vendor a daemon-only client inside `plugins/openai/hooks/` and
    `plugins/claude/hooks/` with no `PolicyEngine`.
- `plugins/claude/package.json` — `"type": "module"`, version `1.6.0`, and
  add `plugins/claude` to root `package.json` `workspaces` if it should
  resolve the same as OpenAI/Hermes.
- Root `package.json` `workspaces` — today `plugins/openai` and
  `plugins/hermes` only.

### Schema / manifest (optional, already mostly valid)

- `plugins/openai/plugin.json` — keep host fields inside
  `extensions.com.openai`. Do not add root `skills` / `hooks`.
- `plugins/claude/.claude-plugin/plugin.json` — optional `version: "1.6.0"`
  for parity; do not add a `hooks` key pointing at the default
  `hooks/hooks.json` (duplicate-load).

---

## Skills checklist (habits, frequency, allow/deny, workspace)

| Topic | Present in both OpenAI and Claude skills? | Matches live CLI / daemon? |
|---|---|---|
| Habits create/list/delete + YAML fields | Yes | Create flags yes; overwrite/`--yes` no; `--create-habit` missing evidence/level |
| Frequency / required acks / commit thresholds | Yes | Hold/commit table yes; three extra yaml keys omitted |
| Allow/deny + hard constraints | Yes | Allow-list + git-commit exception yes; constitution merge semantics no |
| Workspace / env / reload / modes | Yes | Default workspace path yes; `.env` location and "only root is a boundary" no |
| Hold/ack grammar | Yes | Connectors and work-attribution yes; `web_extract` missing from acknowledge.md |

---

## Verdict

Installable OpenAI and Claude **hooks** now speak v0 RPC through
`node/src/hooks/character.js`. That P1 hole is closed on those four files.
The remaining second engine is the **OpenAI Chat Completions mapper**, the
**Hermes Node adapter**, and **Hermes Python injection**. Skill references
still cover the four required topics but several CLI/daemon claims are
wrong. The Agent Plugins 1.0.0 manifest and repo marketplace path are
valid; the portable package is not runnable outside this checkout because
hooks import the monorepo daemon client.
