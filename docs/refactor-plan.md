# Agent Character Kit — Unified Refactor Plan

> **Status:** In progress — v2 host-neutral layout landing on 1.x, not a 2.0.0 socket cut  
> **Created:** 2026-09-13  
> **Replaces:** `.trash/docs-superseded-2026-09-13/REFACTOR_PLAN.md` (2026-09-12 monolith-split draft)  
> **Kit version in scope:** 1.9.0 (plan started against 1.6.0)  
> **Single source of runtime truth remains:** `AGENTS.md`

This plan is the contract for splitting ACK into a host-neutral core plus
provider plugins, without growing a second enforcement engine.

---

## 0. Sources reviewed

| Document | Role in this plan |
|---|---|
| `AGENTS.md` | Runtime constitution: CORE vs COMPANION, fail-closed, one daemon, character ≠ identity, hold + injection, privilege modes |
| `README.md` | Honest framing: conscience not cage; bootstrap break-glass |
| `docs/HABIT_POLICY.md` | Habits outrank other layers; ACK is the habit/character system only |
| `.trash/docs-superseded-2026-09-13/openai-character-kit.md` | Missing host-neutral plugin, OpenAI adapter, protocol envelope, requirements, errors, capabilities (absorbed here) |
| `.trash/docs-superseded-2026-09-13/REFACTOR_PLAN.md` | Package split, PolicyEngine, StateStore, EventBus — kept, then completed |
| `docs/RL_INTEGRATION.md` | Canonical event model, hierarchical IDs, counterfactuals, derived rewards |
| `docs/loop-enforcement-telemetry-plan.md` | Grounded 1.6.0 telemetry gaps (four uncorrelated JSONL logs) |
| `docs/agent-character-injection-design.md` | Two injection channels: proven tool-response + unproven pre-LLM |
| `docs/example-plugin-claude/` | Claude Code plugin *layout* (`.claude-plugin/`, skills, MCP). Content is Anthropic’s generic example, not ACK |

The 2026-09-12 plan split the monolith. It did **not** absorb the OpenAI kit
contracts, did **not** treat Claude/Hermes as real host plugins, and only
sketched events — it did not take `RL_INTEGRATION.md` as the event contract.

---

## 1. Why this refactor exists

Today ACK is a working enforcement loop trapped in a flat tree:

- `node/enforcer/agent_enforcer_daemon.js` (~1371 lines) owns policy, hold
  state, sockets, multi-agent registry, and audit writes.
- `node/bin/ack.js` (~1483 lines) owns CLI, hook JSON, path resolution.
- Companions are examples (`python/hermes_plugin/`, `ack hook claude`), not
  versioned host plugins.
- `docs/example-plugin-claude/` is a Claude Code *template*, author Anthropic,
  name `example-plugin`. It does not wire PreToolUse / UserPromptSubmit to ACK.
- Four JSONL logs exist with almost no shared IDs (`enforcer-audit`,
  `tool-audit`, `ack`, `ack-inject`). `pick_prompt` is not audit-logged.
- `package.json` still advertises knowledge/memory/semantic search. That
  contradicts `HABIT_POLICY.md` §3 and `AGENTS.md` (character only).

The destination is not “more files.” It is:

1. One **protocol** every host speaks.
2. One **core** that decides allow / hold / deny.
3. Many **thin plugins** (OpenAI, Claude, Hermes, later OpenCode/Cursor).
4. A **telemetry stream** that can later feed RL without ACK knowing about RL.

---

## 2. Non-negotiable protocol statements

These are the contracts. Implementation that violates them is out of scope.

### P1. One engine

There is exactly one enforcement engine: the daemon. Plugins, CLI, Python
clients, MCP servers, and OpenAI adapters **ask and obey**. They do not
evaluate constitution, habits, or allow/deny lists locally.

### P2. Character is not identity

ACK never writes `SOUL.md`, `agent.json`, or system prompts. Identity files
are read only to *name* an agent for workspace isolation. Enforcement
decisions never use identity text as a rule.

### P3. Fail-closed

Unreachable daemon, invalid config, unknown protocol version, missing
session context, or capability mismatch → **block**. Silent degrade is a
bug. The only exception is the existing bootstrap allowlist
(`ack doctor` / `ack repair` / `ack configure` / daemon start) so a dead
daemon can be recovered from inside a gated session.

### P4. Conscience, not cage

ACK is a deterrent and reminder. It is explicitly not a security boundary.
Privilege modes (user / service-user / root) change *who can kill the
daemon*, not the honesty of that sentence. Docs and plugin manifests must
keep saying this.

### P5. Habits are the product

Per `HABIT_POLICY.md`: habits + hold acknowledgments + constitution hard
constraints + enforcer allow/deny. Memory, knowledge index, and semantic
search stay library-only / separate skill. Do not fold them into v2 core.

### P6. Two reminder channels, one gate

- **Gate (blocking):** `beforeTool` → allow | hold | deny. Hold requires
  structured acknowledgments (and sometimes a commit). Habit *names* are
  not handed out in the hold reason.
- **Injection (non-blocking):** rotating habit prompts (prompt text only, not
  names or YAML reasoning) on the pre-LLM channel *and* on the tool-response channel
  (`agent-character-injection-design.md`). Keep both. Do not treat
  pre-LLM as proven delivery.

### P7. Host-neutral core, host-specific plugins

Core never imports OpenAI SDK types, Claude hook JSON, or Hermes plugin
APIs. Plugins translate host events into the `CharacterKitPlugin` interface
and translate `ToolDecision` / `ModelOutput` back.

### P8. Additive protocol

Keep the v0 NDJSON RPC (`execute_tool`, `get_habit`, `heartbeat`,
`submit_ack`, `tool_tick`, `pick_prompt`, …) so the sibling Watchtower
adapter (`../../watchtower-adapter`) and current companions keep working.
Add a versioned v1 envelope. Do not break v0 in this refactor.

### P9. Events are facts, rewards are later

Enforcement emits canonical events. Dataset builders and reward functions
live outside ACK (`RL_INTEGRATION.md`). ACK must not compute RL reward.
Telemetry failure must not become an allow, and must not take down the
gate (buffer locally).

### P10. Structured decisions, not prose contracts

Holds, denials, and acks are objects (`Requirement`, `ToolDecision`,
`PluginError`). Human-readable `reason` is for the agent. Plugins must not
parse prose to know what to do.

### P11. Deterministic aggregation

Policy effects combine as **DENY > HOLD > ALLOW**. First matching hard
constraint still short-circuits to DENY. Custom evaluators returning
`null` mean “skip.”

### P12. Per-agent isolation

One daemon process may serve many agents. Each agent has its own nested
workspace, socket, constitution, habits, hold ledger, and ack log. No
shared ruleset with a coat of paint.

---

## 3. Target architecture

```
                    Host runtime
          (OpenAI / Claude / Hermes / …)
                         │
                         ▼
              plugins/<host>/  (thin adapter)
                         │  CharacterKitPlugin + ProtocolEnvelope v1
                         ▼
              packages/core     (policy, requirements, state, lifecycle)
                         │
                         ▼
              packages/daemon   (v0 RPC + v1 envelope, sockets, registry)
                         │
          ┌──────────────┼──────────────┐
          ▼              ▼              ▼
    packages/cli   packages/monitor  packages/watchdog
          │
          ▼
    packages/events   (canonical EnforcementEvent → JSONL / remote sink)
                         │
                         ▼     (out of ACK)
                   trajectory / RL / eval builders
```

**Dependency rule:** arrows point down only. `core` never imports a plugin.
`events` never imports daemon internals. Plugins depend on `core` +
`companion` client only.

### 3.1 Package map

```
agent-character-kit/
├── packages/
│   ├── protocol/          # envelopes, JSON Schema, error codes, v0↔v1 map
│   ├── core/              # plugin impl, policies, state, requirements
│   ├── daemon/            # socket server, RPC registry, workspace registry
│   ├── cli/               # ack
│   ├── companion/         # generic client (createCompanion)
│   ├── events/            # loop-events emitter + local JSONL sink
│   ├── monitor/           # same ack-monitor process; folder only
│   └── watchdog/          # same ack-watchdog process; folder only
├── plugins/
│   ├── openai/            # Responses/Chat Completions adapter
│   ├── claude/            # real Claude Code plugin (not the Anthropic demo)
│   ├── hermes/            # moved python/hermes_plugin
│   └── opencode/          # later; ack hook already covers generic
├── python/                # EnforcerClient only (no second engine)
├── deploy/                # systemd / install (paths updated last)
├── docs/
│   ├── refactor-plan.md   # this file
│   ├── protocol/          # extracted contracts (after Phase 0)
│   └── HABIT_POLICY.md
└── backup-pre-refactor/   # snapshot of 1.6.0 tree
```

### 3.2 What each plugin is allowed to do

| Plugin | Host events in | Core calls | Host events out |
|---|---|---|---|
| `openai` | Responses/Chat Completions, tool calls, streaming | `beforeModel`, `beforeTool`, `submitAcknowledgment` | developer/system instructions, tool rejection, structured hold |
| `claude` | `PreToolUse`, `UserPromptSubmit`, `PostToolUse` | same | `permissionDecision`, `additionalContext`, skill/slash surfaces |
| `hermes` | `pre_tool_call`, `pre_llm_call` | same | allow/deny + injected prompt |
| generic `ack hook` | stdin hook JSON | same | framework hook JSON |

If a host cannot intercept tools, the plugin **rejects** tool-enforcement
mode via capability negotiation (`CK_PROTOCOL_INVALID` / unsupported
capability). It does not pretend.

---

## 4. Host-neutral contracts

Author these as TypeScript interfaces in `packages/protocol` (compile to JS
+ `.d.ts`). Runtime stays Node ≥ 18 ESM. This resolves the 2026-09-11
“JS not TS” note: **contracts are TS, shipped JS is compiled.**

### 4.1 Plugin surface

```ts
interface CharacterKitPlugin {
  initialize(context: RuntimeContext): Promise<void>;
  beforeModel(input: ModelInput): Promise<ModelOutput>;
  beforeTool(input: ToolInput): Promise<ToolDecision>;
  submitAcknowledgment(input: AcknowledgmentInput): Promise<AcknowledgmentResult>;
  shutdown(): Promise<void>;
}

interface PluginLifecycle {
  onSessionStart(context: RuntimeContext): Promise<void>;
  onModelRequest(input: ModelInput): Promise<ModelOutput>;
  onToolRequest(input: ToolInput): Promise<ToolDecision>;
  onAcknowledgment(input: AcknowledgmentInput): Promise<AcknowledgmentResult>;
  onSessionEnd(context: RuntimeContext): Promise<void>;
  onError(error: PluginError): Promise<void>;
}
```

`CharacterKitPlugin` is what hosts call. `PluginLifecycle` is the same
loop with session bookends. Implement once; adapters bind both.

### 4.2 Runtime context (required on every request)

```ts
interface RuntimeContext {
  sessionId: string;
  runId: string;
  agentId?: string;
  workspaceId?: string;
  toolCallId?: string;
  parentRunId?: string;
  episodeId?: string;   // RL / telemetry hierarchy
  taskId?: string;
  timestamp: string;
}
```

No global hold/ack maps keyed only by “the process.” Session/run scoping
is mandatory (`openai-character-kit.md` §3, `RL_INTEGRATION.md` §3).

### 4.3 Decisions and requirements

Replace boolean `allowed` as the *external* contract. Internal
`PolicyVerdict` may still exist; it must map to:

```ts
type PolicyEffect = "allow" | "hold" | "deny";

interface Requirement {
  id: string;
  type: "acknowledgment" | "commit" | "commit-message" | "state-recovery" | "operator-confirmation";
  status: "pending" | "satisfied" | "rejected";
  metadata?: Record<string, unknown>;
}

interface ToolDecision {
  decision: PolicyEffect;
  reason?: string;
  requirements?: Requirement[];
  retryable: boolean;
  code?: string;
  stateVersion: string;
  injected?: ModelOutput;  // tool-response injection channel
}
```

Aggregation: DENY > HOLD > ALLOW.

### 4.4 Injection contract

```ts
interface ModelOutput {
  messages?: Message[];
  instructions?: string;
  metadata?: { injected: boolean; injectionIds?: string[] };
}
```

Core emits semantic content (habit prompts without names). The OpenAI
plugin chooses developer vs system vs tool-result. The Claude plugin
chooses `hookSpecificOutput.additionalContext`. Hermes chooses
`pre_llm_call` payload. Core does not format host messages.

### 4.5 Protocol envelope (v1)

```ts
interface ProtocolEnvelope<T> {
  protocol: "character-kit";
  version: "1";
  type: string;
  requestId: string;
  context: RuntimeContext;
  payload: T;
}

interface ProtocolResponse<T> {
  protocol: "character-kit";
  version: "1";
  requestId: string;
  ok: boolean;
  payload?: T;
  error?: PluginError;
}
```

v0 NDJSON `{ method, params, token }` remains on the socket. Daemon
accepts both; v1 is preferred for new plugins.

### 4.6 Error taxonomy

Stable codes (do not reuse as English strings):

```
CK_CONFIG_INVALID
CK_SESSION_INVALID
CK_STATE_UNAVAILABLE
CK_DAEMON_UNAVAILABLE
CK_PROTOCOL_INVALID
CK_ACK_REQUIRED
CK_ACK_INVALID
CK_TOOL_BLOCKED
CK_POLICY_DENIED
CK_REQUEST_TIMEOUT
CK_VERSION_UNSUPPORTED
CK_CAPABILITY_UNSUPPORTED
```

```ts
interface PluginError {
  code: string;
  message: string;
  retryable: boolean;
  requestId?: string;
  details?: Record<string, unknown>;
}
```

### 4.7 Capability negotiation

```ts
interface RuntimeCapabilities {
  supportsDeveloperMessages: boolean;
  supportsToolInterception: boolean;
  supportsStreaming: boolean;
  supportsStructuredOutputs: boolean;
  supportsContinuation: boolean;
}
```

OpenAI plugin: if the host has no tool interception, refuse tool-gate mode
instead of “best effort.” Claude plugin: PreToolUse is required for the
gate; UserPromptSubmit is required for pre-LLM injection (absence = that
channel off, tool-response injection still on).

### 4.8 Idempotency

```ts
interface IdempotencyKey {
  sessionId: string;
  runId: string;
  eventId: string;
}
```

Duplicate event → prior `ToolDecision`. Duplicate ack → deterministic
`AcknowledgmentResult`. Concurrent tool calls for one session: serialize
hold-state mutations (or isolate with explicit `toolCallId` +
`stateVersion`). Stale `stateVersion` → reject.

### 4.9 Config object

One validated `CharacterKitConfig` (habits, acknowledgments,
accountability, enforcement, storage, protocol). Env > file > embedded
default. Unknown fields fail closed in strict mode; warn in compat mode.
Reload via existing `reload` RPC, wired to `ack reload`.

---

## 5. Policy pipeline (core)

```
request
  → context validation
  → session/state lookup
  → policy evaluation
      ├── hard constraints (constitution)
      ├── allow/deny list (enforcer.yaml)
      ├── habit guards (secret-leak, etc.)
      ├── cadence / hold
      ├── acknowledgment
      ├── accountability (commit thresholds)
      └── fail-closed / daemon-health
  → DENY > HOLD > ALLOW
  → state transition
  → events
  → ToolDecision
```

Extract from current daemon (line ranges from the 2026-09-12 plan still
apply as a map, not as frozen numbers): `_matches`, `_leaksSecret`,
`_evalHabit`, hold tick, ack validation, prompt rotation.

**Do not** encode holds as “acknowledge N habits” with no machine
requirements. The agent-facing `reason` stays terse (no habit names). The
plugin-facing `requirements[]` carries ids/types.

---

## 6. Provider plugins

### 6.1 OpenAI (`plugins/openai/`)

This is the missing scope from `openai-character-kit.md`.

```
plugins/openai/
├── request-mapper.ts
├── response-mapper.ts
├── tool-hook.ts
├── model-hook.ts
├── conversation-state.ts
└── error-mapper.ts
```

Must handle: model input conversion, tool-call interception, injection
placement, structured hold as a continuation (not a hallucinated chat
line), blocked-action mapping, request/session ids, streaming, OpenAI
error shape. Core remains SDK-free.

Ship as `@drdeeks/character-kit-openai` or `plugins/openai` inside the
workspace. Same daemon.

### 6.2 Claude (`plugins/claude/`)

Replace `docs/example-plugin-claude/` content. **Keep the layout**:

```
plugins/claude/
├── .claude-plugin/plugin.json    # name: agent-character-kit
├── .mcp.json                     # optional MCP → ack status/habit list
├── hooks/                        # PreToolUse, UserPromptSubmit → companion
├── skills/character-enforcement/SKILL.md
└── commands/                     # thin wrappers around `ack` if needed
```

The current example’s `plugin.json` is Anthropic’s demo. New manifest
must describe ACK, point hooks at `packages/companion` / `ack hook claude`,
and list capabilities honestly (not foolproof, fail-closed).

### 6.3 Hermes (`plugins/hermes/`)

Move `python/hermes_plugin/` here. Keep `python/agent_character_kit/` as
the socket client. Delete any path that re-implements policy (the old
`aik-py` CLI was already removed for this reason).

### 6.4 Later hosts

Cursor / Gemini / OpenCode keep using `ack hook <name>` until they earn a
directory. Do not create empty plugin stubs.

---

## 7. Telemetry and RL (from RL_INTEGRATION)

### 7.1 Split of duties

| Layer | Owns | Must not own |
|---|---|---|
| ACK core/daemon | Enforcement decisions, hold state | Reward, training labels |
| `packages/events` | Canonical `EnforcementEvent`, local JSONL, remote sink *interface* | Trajectory formatting |
| Dataset builders (outside this repo or later package) | RL / SFT / eval extracts | Ability to allow a tool |

### 7.2 Minimum event vocabulary (ACK-emitted)

Lifecycle: `session.started`, `session.ended`  
Model: `model.requested` (from plugin), `habit.injected`  
Actions: `tool.requested`, `tool.allowed`, `tool.held`, `tool.denied`, `tool.completed`  
Character: `acknowledgment.requested|submitted|accepted|rejected|reused`  
Policy: `policy.evaluated`, `policy.held`, `policy.released`, `policy.denied`  
Infra: `enforcer.connected|disconnected|recovered`, `protocol.error`

Every event carries `eventId`, `sessionId`, `runId`, `sequence`,
`schemaVersion`, plus optional `episodeId` / `taskId` / `agentId` supplied
by the companion. `pick_prompt` must emit `habit.injected`.

### 7.3 Counterfactuals

Companion emits proposed action (`tool.requested`) before the daemon
decides. Daemon emits `policy.*`. Companion emits `tool.completed` /
abandoned. Do not collapse proposed vs enforced vs subsequent into one
“blocked” line.

### 7.4 Privacy

Default: ids, codes, hashes, durations. Prompts, tool args, file bodies,
credentials — redacted / hashed / artifact-ref. Never log ack *content*
in the clear in default mode.

### 7.5 Local-first

Append-only JSONL, date-partitioned. Remote sink is an interface
(`loop-enforcement-telemetry-plan.md` decision 4). Idempotent `eventId`
on retry. If the sink is down, enforcement continues.

Extractable later as `@drdeeks/loop-events`. For v2, live in
`packages/events` so ACK does not wait on a second repo.

---

## 8. Content restructure (docs + tree)

| Now | After |
|---|---|
| `AGENTS.md` | Keep as operator/runtime SoT. Add a pointer to `docs/refactor-plan.md` and `docs/protocol/` |
| `docs/REFACTOR_PLAN.md` | Moved to `.trash/docs-superseded-2026-09-13/` — do not leave stubs in `docs/` |
| `docs/openai-character-kit.md` | Moved to `.trash/docs-superseded-2026-09-13/` after absorption into §4–6 |
| `docs/RL_INTEGRATION.md` | Keep as event/RL doctrine; this plan implements the ACK slice |
| `docs/example-plugin-claude/` | Move/replace with `plugins/claude/`; leave a README pointer |
| `docs/HABIT_POLICY.md` | Unchanged authority |
| `node/corpus/` | Remain library-only; out of v2 core (HABIT_POLICY §3) |
| Root `package.json` keywords `knowledge, memory, semantic-search` | Drop from character-kit package identity |

Docs after Phase 0 should be readable as:

```
docs/
  HABIT_POLICY.md
  refactor-plan.md          ← this file
  protocol/
    plugin.md               ← CharacterKitPlugin
    envelope.md             ← v0 + v1
    errors.md
    events.md               ← ACK event subset
  adapters/
    openai.md
    claude.md
    hermes.md
    watchtower.md          ← sibling bridge; not a harness plugin yet
```

One idea, one file. No second “enterprise plan.”

---

## 9. Migration phases

Exit criteria are behavioral, not “files exist.”

### Phase 0 — Contracts and freeze

1. Copy 1.6.0 tree to `backup-pre-refactor/`.
2. Add `packages/protocol` with interfaces + JSON Schema for envelope,
   ToolDecision, Requirement, PluginError, EnforcementEvent.
3. npm workspaces at repo root.
4. Compatibility tests: golden v0 RPC request/response fixtures from
   current daemon tests.
5. Decision lock: v0 stays; v1 is additive.

**Exit:** schemas published, no runtime behavior change.

### Phase 1 — Core policy + state

1. `PolicyEngine` pipeline with DENY > HOLD > ALLOW.
2. Session-scoped `StateStore` (in-memory default).
3. Structured `Requirement` for hold/commit.
4. Character loader (embedded defaults + yaml merge) moved out of daemon.
5. Golden tests vs current daemon allow/deny/hold cases.

**Exit:** same verdicts as 1.6.0 for existing tests, plus structured
requirements on holds.

### Phase 2 — Events

1. `packages/events` emitter + JSONL sink.
2. Instrument evaluate / hold / ack / inject (`pick_prompt` included).
3. Hierarchical ids; companions pass through what the host provides.
4. Redaction defaults.

**Exit:** one JSONL stream can answer: what was proposed, what policy did,
what happened next.

### Phase 3 — Daemon on core

1. Socket server (unix/tcp), auth token, multi-workspace registry.
2. Dual v0/v1 dispatch.
3. `reload` exposed on CLI.
4. Watchtower / existing `ack hook` still speak v0.

**Exit:** current Node test suite green against new daemon.

### Phase 4 — CLI split

Command bodies live in `packages/cli/src/`. Commander stays in
`node/bin/ack.js`. `configure` still delegates to `install.js`.

Commander modules: hook, configure, manage, status, doctor, repair,
config, habit, **reload**, and a new `ack audit` (read JSONL; closes
AGENTS.md “no CLI for audit trail” gap as a byproduct, not a scope creep
of policy).

**Exit:** existing CLI commands behave; `ack reload` works.
Shipped in this tree: `ack reload` + read-only `ack audit` (last-N JSONL).

### Phase 5 — Companion + host plugins

1. `packages/companion` implements `CharacterKitPlugin` over the client.
2. `plugins/openai` adapter (can start read-only/model-hook if tool
   interception host is not ready; must fail closed when tools are
   claimed but unsupported).
3. `plugins/claude` real plugin (layout from example, ACK wiring).
4. `plugins/hermes` move.

**Exit:** Claude PreToolUse deny of `rm -rf /`; Hermes pre_tool_call same;
OpenAI mapper round-trips a hold as structured requirements.

### Phase 6 — Monitor + watchdog

Same ACK processes, same kit. Optionally move `deploy/ack_monitor.js` and
`deploy/ack_watchdog.js` into `packages/monitor` and `packages/watchdog`
(npm workspaces under `@drdeeks/character-kit`, not separate products).
Python monitor/watchdog remain parity-only for Hermes if still needed.

**Exit:** root-mode systemd units start new binaries; ack hold still
credits via monitor.

### Phase 7 — Deploy + docs

Update `deploy/*.sh`, systemd units, `install.sh`, README pointer,
CHANGELOG, version **2.0.0**. Six version stamps still bump together
(`AGENTS.md` version tracking).

**Exit:** fresh `ack configure --yes` on a clean workspace enforces.

### Phase 8 — Hardening

Socket.dev when a human can login. Two-agent live systemd proof (still
open in AGENTS.md). Capability-negotiation tests per host.

---

## 10. What stays vs what changes

**Unchanged**

- Fail-closed semantics and bootstrap break-glass
- YAML constitution / enforcer / habits on disk
- Embedded defaults
- `ACK_AUTH_TOKEN`
- v0 wire methods and names
- Privilege modes (user / service-user / root)
- Python `EnforcerClient` as a client
- Watchtower as an external v0 consumer
- Habit ack *format* the agent types (`Habit: … because …`)

**Changes**

- Monolith → packages + plugins
- Boolean tool results → `ToolDecision` + `Requirement[]`
- Ad-hoc JSONL → canonical events (old files can be dual-written one
  release, then dropped)
- Claude example template → real ACK Claude plugin
- OpenAI adapter exists
- Protocol v1 envelope
- Package identity: character enforcement, not a knowledge kit

---

## 11. Risks

| Risk | Mitigation |
|---|---|
| v1 envelope breaks Watchtower | v0 always on; v1 additive; fixtures |
| Policy split drifts from daemon | Golden tests from 1.6.0 before deleting old files |
| OpenAI host can’t intercept tools | Capability negotiation; refuse tool-gate rather than fake it |
| Event schema blocks the refactor | `packages/events` is a sink, not a gate; emit async, never allow on emit failure |
| TS friction vs current JS | Compile in CI; do not require contributors to hand-write `dist/` |
| Scope explosion (memory, RL trainer, Gate) | HABIT_POLICY §3 + P9; out of repo |
| 4 GB ThinkPad / SQLite lessons | Keep in-memory state default; JSONL append-only; no extra DB in v2 core |
| Two SoT docs | This file + `AGENTS.md` only; old plan is a stub |

---

## 12. Decision log

| Date | Decision | Rationale |
|---|---|---|
| 2026-09-11 | npm workspaces | Keep from prior plan |
| 2026-09-11 | Backup then break | Rollback path |
| 2026-09-11 | JSONL events | Matches ACK; RL builders consume later |
| 2026-09-11 | Knowledge/memory out of core | HABIT_POLICY §3 |
| 2026-09-13 | **Absorb openai-character-kit.md into this plan** | Prior plan omitted it |
| 2026-09-13 | **v0 RPC kept, v1 envelope added** | Overrides “protocol never changes” |
| 2026-09-13 | **DENY > HOLD > ALLOW + Requirement objects** | OpenAI kit §5–7; stops prose parsing |
| 2026-09-13 | **Plugins: openai, claude, hermes** | Host-specific; core host-neutral |
| 2026-09-13 | **Claude example is layout-only** | Replace content with ACK plugin |
| 2026-09-13 | **RL_INTEGRATION is the event doctrine** | Prior plan’s EventBus was incomplete |
| 2026-09-13 | **TS contracts, compiled JS runtime** | Reconciles 09-11 JS decision with needed interfaces |
| 2026-09-13 | **Two injection channels remain** | injection-design.md; observability not cargo-cult |
| 2026-09-13 | **ACK does not compute reward** | RL_INTEGRATION §11 |

---

## 13. Definition of done (v2.0.0)

- [ ] `AGENTS.md` still describes one daemon and thin companions.
- [ ] `packages/protocol` is the typed contract; plugins do not define a
      second ToolDecision.
- [ ] OpenAI, Claude, and Hermes plugins each call the same
      `CharacterKitPlugin` methods.
- [ ] Hold returns structured `requirements[]`; agent-facing text still
      omits habit names.
- [ ] v0 clients (Watchtower, current `ack hook`) still work.
- [ ] Canonical events include proposed vs enforced vs subsequent, and
      `habit.injected` from `pick_prompt`.
- [ ] Memory/knowledge are not required to install or run ACK.
- [ ] Fresh install: `rm -rf /` denied; unreachable daemon denies
      (except bootstrap); `ack configure --yes` is idempotent.

When those are true, the kit is modular enough to add another provider
plugin without editing the daemon.
