# Loop Enforcement Telemetry & RL Data Architecture — Implementation Plan

**Spec**: Grounded Refinement Directive v2 (task brief)
**Version**: 1.6.0 (written against; live kit is 1.8.0)
**Date**: 2026-09-05

---

## Grounding

**Current state** (verified 2026-09-05):

- 4 separate JSONL logs with no cross-component correlation: `enforcer-audit.jsonl` (daemon), `tool-audit.jsonl` (companion), `ack.jsonl` (companion→monitor), `ack-inject-log.jsonl` (companion)
- No formal event schema — all ad-hoc JS objects, no TypeScript, no JSON Schema
- Only `sessionId` exists as an identifier (no `episodeId`, `taskId`, `runId`, `agentId` in event payloads)
- No event emitter/bus — fire-and-forget `appendFileSync`
- `pick_prompt` RPC is never audit-logged — no record of which habits were injected
- No session start/end lifecycle events — sessions created lazily, never cleaned up
- No hold-cycle lifecycle events — only the final `submit_ack` decision is logged, not the hold trigger or release
- No counterfactual capture — proposed vs enforced vs subsequent action not recorded

**Governing doctrine**: AGENTS.md — fail-closed (§1), no second engine (§2), atomic action discipline (§6).

**Decisions**:

1. Internal module (`node/src/events/`) — extractable to `@drdeeks/loop-events` later
2. Companion-supplied identifiers — harnesses provide `episodeId`/`taskId`/`runId` in hook payloads
3. Companion-side counterfactual events — companion emits `tool.requested` + `tool.completed`, daemon emits `policy.*`
4. Remote sink interface only — no built-in HTTP sink for MVP

---

## Phase 1: Canonical Event Schema + Infrastructure

### Step 1.1 — Event type definitions

**File**: `node/src/events/event-types.js`

- Define all event type constants as a frozen object (e.g. `EVENT_TYPE.SESSION_STARTED = "session.started"`)
- Categories from spec §5: lifecycle, model, actions, character-kit, gate/loop-enforcement, accountability, infrastructure
- Export a flat lookup and a `categoryOf(type)` helper

### Step 1.2 — Event ID generation

**File**: `node/src/events/event-id.js`

- `generateEventId()` — `evt_` prefix + 24-char random hex (collision-safe, sortable by time)
- `generateInterventionId()` — `int_` prefix
- Pure function, no state

### Step 1.3 — Event builder

**File**: `node/src/events/event-builder.js`

- `buildEvent({ eventType, source, component, ...overrides })` — returns a complete `EnforcementEvent` with `eventId`, `timestamp`, `schemaVersion`, defaults for optional fields
- Validates `eventType` against known types, throws on unknown
- `parentEventId` linking is the caller's responsibility (pass it in)

### Step 1.4 — Local JSONL sink

**File**: `node/src/events/sinks/local-jsonl.js`

- `LocalJsonlSink` class — constructor takes `{ dir, filename }`, manages file handle
- `write(event)` — appends one JSON line, returns the event (for chaining)
- File rotation: date-partitioned subdirs (`events/YYYY/MM/DD/<filename>.jsonl`)
- Idempotent: same `eventId` written twice is a no-op (in-memory Set of recent IDs, bounded)

### Step 1.5 — Remote sink interface

**File**: `node/src/events/sinks/remote.js`

- `RemoteSink` interface — `async write(event)`, `async flush()`, `async close()`
- No implementation; just the contract

### Step 1.6 — Event emitter

**File**: `node/src/events/emitter.js`

- `EventEmitter` class (extends Node's `EventEmitter`)
- `emitEvent(eventType, payload)` — builds event via builder, writes to all registered sinks, emits on Node EventEmitter for in-process listeners
- `addSink(sink)`, `removeSink(sink)`
- Configurable redaction: `redactFields: ["command", "params", "statement"]` option — replaces values with `{ redacted: true, contentHash: "..." }`

### Step 1.7 — Module index

**File**: `node/src/events/index.js`

- Export all public API: `EventEmitter`, `LocalJsonlSink`, `RemoteSink`, `buildEvent`, `generateEventId`, `EVENT_TYPE`, `categoryOf`

### Step 1.8 — Legacy JSONL adapter

**File**: `node/src/events/sinks/legacy-audit.js`

- `LegacyAuditSink` — converts new-format events back to the existing `enforcer-audit.jsonl` shape so the old audit trail keeps working
- Writes to the same `<AGENT_DIR>/logs/enforcer-audit.jsonl` path
- This is the backward-compatibility bridge; can be removed once users migrate

**Verification**: `npm test` passes. New unit tests for `event-builder`, `event-id`, `local-jsonl` sink, `legacy-audit` sink, `emitter` (event flows through to sink).

---

## Phase 2: Daemon Instrumentation

### Step 2.1 — Add agent name to daemon audit context

The daemon already resolves agent identity via socket path (`<agent-name>.sock`). Extract `agentName` from the socket path and include it in every event's `agentId` field.

**Location**: `agent_enforcer_daemon.js`, `startSocketServer()` and `startMultiWorkspaceDaemon()` — pass `agentName` into the enforcer instance.

### Step 2.2 — Refactor `_audit()` to emit events

`_audit()` currently writes ad-hoc JSONL. Change it to call `emitter.emitEvent(eventType, { ...extra })`.

The `LegacyAuditSink` maintains the existing `enforcer-audit.jsonl` format.

`kind` values map to event types:
- `"execute_tool"` → `EVENT_TYPE.TOOL_ALLOWED` / `TOOL_DENIED`
- `"tool_tick"` → `EVENT_TYPE.TOOL_HELD` / `TOOL_RELEASED`
- `"submit_ack"` → `EVENT_TYPE.ACKNOWLEDGMENT_ACCEPTED` / `ACKNOWLEDGMENT_REJECTED`

### Step 2.3 — Emit session lifecycle events

On first `tool_tick` or `submit_ack` for a new session: emit `session.started` with `sessionId`, `agentId`, `modelId`.

This replaces the current lazy `_holdState(session)` creation — piggyback on it.

### Step 2.4 — Emit hold-cycle lifecycle events

When `tool_tick` triggers a hold: emit `policy.held` with `{ policy: "acknowledgment", requirements: [...] }`.

When `submit_ack` completes a cycle: emit `policy.released` with `{ policy: "acknowledgment" }`.

These are new events; the current audit only logs the final `submit_ack` result.

### Step 2.5 — Audit `pick_prompt`

`pickPrompt()` currently returns silently. Add an audit entry: emit `habit.injected` with `{ habitId, injectionId, channel: "pre_llm" }` for each prompt returned.

This fills the gap where injections are invisible to the daemon's audit trail.

### Step 2.6 — Add identifier pass-through to RPCs

- `tool_tick` RPC: accept optional `episode_id`, `task_id`, `run_id`, `agent_id` in params. Record them in the emitted event.
- `submit_ack` RPC: same.
- `pick_prompt` RPC: same.
- `execute_tool` RPC: accept optional `episode_id`, `task_id`, `run_id`.

Companion is responsible for sending these; daemon doesn't generate them.

### Step 2.7 — Version metadata in events

Add `characterKitVersion` (from `version.js`), `policyVersion` (hash of constitution+habits+policy), `configurationVersion` (hash of enforcer.yaml) to every event as top-level fields.

These are computed once on daemon startup, stored as instance properties.

**Verification**: Run existing test suite (`cd node && npm test`). Daemon tests still pass. New tests: daemon emits `session.started` on first tool_tick, emits `policy.held`/`policy.released` around hold cycles, `pick_prompt` produces `habit.injected` events.

---

## Phase 3: Companion Instrumentation

### Step 3.1 — Refactor `character.js` `auditLog()` to emit events

Replace direct `appendFileSync` with `emitter.emitEvent()`.

The companion's `tool-audit.jsonl` is maintained via a `LegacyCompanionSink` or separate `CompanionAuditSink`.

### Step 3.2 — Counterfactual capture in `processToolCall()`

- Before calling `enforcer.validateTool()`: emit `tool.requested` with `{ tool, parametersHash, proposedAt }`.
- After enforcement decision + `toolTick`: emit `tool.allowed` / `tool.denied` / `tool.held` with `{ decision, policy, effect }`.
- After actual tool execution (post-hook): emit `tool.completed` with `{ status, durationMs, exitCode }`.

This preserves the counterfactual: what was proposed → what enforcement decided → what actually happened.

### Step 3.3 — Inject identifier pass-through

Read `episode_id`, `task_id`, `run_id` from the harness hook payload (add to `normalizeInput()`).

Pass them through to all daemon RPCs (`execute_tool`, `tool_tick`, `submit_ack`).

If harness doesn't supply them, leave them undefined (daemon events will have them as optional).

### Step 3.4 — Acknowledgment events in companion

When `detectAckFromTranscript()` finds an ack statement: emit `acknowledgment.submitted` with `{ statement, sessionId, ...identifiers }`.

This replaces the direct write to `ack.jsonl`; the monitor's relay will emit `acknowledgment.accepted` / `acknowledgment.rejected` via the daemon.

### Step 3.5 — Injection events in companion

Replace `_logInjection()` with `emitter.emitEvent(EVENT_TYPE.HABIT_INJECTED, { ... })`.

Maintain `ack-inject-log.jsonl` via a legacy sink.

### Step 3.6 — Python companion (`hermes_plugin/__init__.py`)

The Python companion is a separate process and can't use the Node EventEmitter directly.

Strategy: the Python companion writes events to `<workspace>/.agent/events/python-companion.jsonl` with the same canonical schema. The Node-side event emitter reads this file for cross-component correlation.

**Verification**: Run `npm test` and `python3 python/hermes_plugin/test_plugin.py`. New tests: companion emits `tool.requested` before enforcement, `tool.completed` after, identifier pass-through works.

---

## Phase 4: Monitor + Watchdog Instrumentation

### Step 4.1 — Monitor emits acknowledgment events

`ack_monitor.js` currently tails `ack.jsonl` and calls `submit_ack` RPC. After each RPC call, emit `acknowledgment.accepted` or `acknowledgment.rejected` based on the response.

This is the only place where ack validity is confirmed, so these events are authoritative.

### Step 4.2 — Watchdog emits infrastructure events

`ack_watchdog.js` currently checks process liveness and restarts dead processes. Emit `enforcer.recovered` when it restarts a dead daemon, `enforcer.disconnected` when it detects a dead daemon.

These are low-frequency events (every 5-30 seconds check cycle), not hot-path.

**Verification**: Existing monitor/watchdog tests pass. New tests: monitor emits ack events on credit/reject, watchdog emits recovery events.

---

## Phase 5: Trajectory Reconstruction

### Step 5.1 — Event query helpers

**File**: `node/src/events/query.js`

- `queryEvents(sink, { sessionId, episodeId, taskId, startTime, endTime, eventTypes })` — reads from JSONL, filters, returns sorted array.
- `reconstructTrajectory(events)` — builds the state-transition chain: MODEL_RESPONSE → PROPOSED_ACTION → ENFORCEMENT_EVALUATION → DECISION → ACKNOWLEDGMENT → EXECUTION → OBSERVED_RESULT.
- `buildRLStep(event)` — transforms a single event into the RL trajectory format from spec §16.

### Step 5.2 — Episode boundary detection

`detectEpisodeBoundaries(events)` — identifies `session.started`/`session.ended`, `task.started`/`task.completed`/`task.failed` events.

Returns an array of `{ episodeId, taskId, startTime, endTime, events[], outcome }`.

**Verification**: Unit tests with synthetic event streams. Query returns correct filtered results. Trajectory reconstruction produces correct state transitions.

---

## Phase 6: Integration Tests

### Step 6.1 — End-to-end event flow test

- Spawn a real daemon (like the existing test suite does).
- Simulate a full cycle: tool call → hold → ack → release → tool execution.
- Assert that the event JSONL contains all expected events in correct order.
- Assert that identifiers (sessionId, episodeId, etc.) are present and consistent.

### Step 6.2 — Multi-agent event isolation test

- Two agents, each with their own workspace.
- Assert that events from Agent A don't appear in Agent B's event store.
- Assert that `agentId` is correctly set on each event.

### Step 6.3 — Legacy audit compatibility test

- Assert that `enforcer-audit.jsonl` entries are still in the old format after the refactor.
- Assert that `tool-audit.jsonl` entries are still in the old format.

---

## File Map

### New files

| Path | Role |
|------|------|
| `node/src/events/event-types.js` | Event type constants + category lookup |
| `node/src/events/event-id.js` | `generateEventId()`, `generateInterventionId()` |
| `node/src/events/event-builder.js` | `buildEvent()` — constructs complete event objects |
| `node/src/events/emitter.js` | `EventEmitter` — core event bus with sink routing |
| `node/src/events/query.js` | Event query, trajectory reconstruction, RL step builder |
| `node/src/events/sinks/local-jsonl.js` | `LocalJsonlSink` — append-only JSONL with date rotation |
| `node/src/events/sinks/remote.js` | `RemoteSink` interface |
| `node/src/events/sinks/legacy-audit.js` | `LegacyAuditSink` — backward-compat enforcer-audit.jsonl |
| `node/src/events/sinks/legacy-companion.js` | `LegacyCompanionSink` — backward-compat tool-audit.jsonl |
| `node/src/events/index.js` | Public API exports |
| `node/tests/events/*.test.js` | Unit tests for event infrastructure |

### Modified files

| Path | Change |
|------|--------|
| `node/enforcer/agent_enforcer_daemon.js` | Refactor `_audit()` to emit events; add session lifecycle, hold lifecycle, pick_prompt audit; add identifier pass-through to RPCs; add version metadata |
| `node/src/hooks/character.js` | Refactor `auditLog()` to emit events; add counterfactual capture; add identifier pass-through; refactor `_logInjection()` and `detectAckFromTranscript()` |
| `deploy/ack_monitor.js` | Emit ack.accepted/rejected events |
| `deploy/ack_watchdog.js` | Emit infrastructure events |
| `node/src/index.js` | Export new events module |
| `python/hermes_plugin/__init__.py` | Emit canonical events to JSONL |

### Unchanged files

| Path | Reason |
|------|--------|
| `node/src/enforcer/client.js` | Thin client, just passes params through |
| `node/src/agent-identity.js` | Read-only, no events |
| `supervise.py` | Process supervisor, no events |

---

## Dependency Order

```
Phase 1 (schema + infra)
    → Phase 2 (daemon)
        → Phase 3 (companion)
            → Phase 4 (monitor/watchdog)
                → Phase 5 (trajectory)
                    → Phase 6 (integration)
```

Each phase is independently verifiable. Phase 1 has zero impact on existing behavior (new module, nothing calls it yet). Phases 2-6 can be validated incrementally.

---

## Risks and Mitigations

| Risk | Mitigation |
|------|------------|
| Refactoring `_audit()` breaks existing audit trail | `LegacyAuditSink` writes the old format; integration test validates format compatibility |
| Python companion events not correlated with Node events | Same canonical schema + shared `episodeId`/`taskId`/`runId` supplied by harness; dataset builder merges by these identifiers |
| Performance impact of event emission on hot path | Events are built in-memory and written async (buffered); `appendFileSync` is already the pattern; no new I/O |
| Event file growth | Date-partitioned rotation; old archives can be pruned by external tooling (not built into MVP) |

---

## Spec Coverage

| Spec Section | Implementation |
|---|---|
| §1 Core Principle (one canonical event model) | `EventEmitter` + `LocalJsonlSink` — all components emit through the same bus |
| §2 Fundamental Unit (structured events) | `buildEvent()` — `EnforcementEvent` interface |
| §3 Hierarchical Identifiers | Companion-supplied `episodeId`/`taskId`/`runId` via hook payloads; daemon records them |
| §4 State Transitions | Companion emits `tool.requested` → daemon emits `policy.evaluated`/`policy.held` → companion emits `tool.completed` |
| §5 Standard Event Categories | `event-types.js` — full vocabulary from spec §5 |
| §6 Action + Outcome Separation | `ActionRecord` and `OutcomeRecord` in event payloads |
| §7 Count Everything | Atomic events → derive counts; no special counters |
| §8 Character Kit Behavioral Telemetry | `habit.injected`, `acknowledgment.*`, `policy.*` events |
| §9 Implicit Behavior Capture | Tool selected/not selected, action abandoned, retry performed |
| §10 Counterfactual Boundary | `tool.requested` (proposed) → `tool.denied` (enforced) → `tool.completed` (subsequent) |
| §11 Reward Derived, Not Hardcoded | Raw events → dataset builder → reward function (separate concern) |
| §12 Canonical Event Store | `LocalJsonlSink` — append-only, date-partitioned, immutable |
| §13 Local-First, Remote-Capable | `LocalJsonlSink` always writes; `RemoteSink` interface for optional push |
| §14 Durable Delivery | `eventId` + idempotent ingestion |
| §15 Separate Raw From Derived | Phase 5 trajectory builder consumes events, never modifies them |
| §16 RL Trajectory Model | `buildRLStep()` in `query.js` |
| §17 Intervention Metadata | `Intervention` interface in event payloads |
| §18 Version Everything | `characterKitVersion`, `policyVersion`, `configurationVersion` in every event |
| §19 Privacy/Data Minimization | Configurable redaction in `EventEmitter`; `contentHash`/`artifactRef` for sensitive payloads |
| §20 Event Schema Is Contract | `event-types.js` + `event-builder.js` — single source of truth |
| §21 Package Boundary | Internal `node/src/events/` module, extractable to `@drdeeks/loop-events` later |
| §22 Minimum Viable Implementation | All 12 MVP items covered across Phases 1-6 |
