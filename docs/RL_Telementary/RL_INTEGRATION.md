Loop Enforcement Telemetry and RL Data Architecture

Purpose: Define the canonical logging, correlation, implicit tracking, and dataset architecture for Character Kit, The Gate, and the broader loop-enforcement system, with the eventual goal of producing high-quality datasets for evaluation, behavioral analysis, and reinforcement learning.

⸻

1. Core Principle

All enforcement components must emit events into one canonical event model.

                    ┌─────────────────────┐
                    │   Agent / Model     │
                    └──────────┬──────────┘
                               │
                     model / tool / response
                               │
                    ┌──────────▼──────────┐
                    │ Loop Enforcement    │
                    │       System        │
                    └──────────┬──────────┘
                               │
             ┌─────────────────┼─────────────────┐
             │                 │                 │
        Character Kit      The Gate        Other Policies
             │                 │                 │
             └─────────────────┼─────────────────┘
                               │
                       Structured Events
                               │
                    ┌──────────▼──────────┐
                    │ Canonical Event     │
                    │       Stream        │
                    └──────────┬──────────┘
                               │
              ┌────────────────┼────────────────┐
              │                │                │
        Local Event Log   Remote Sink      Live Metrics
              │                │
              └────────────────┼────────────────┘
                               │
                    ┌──────────▼──────────┐
                    │ Dataset Generation  │
                    └──────────┬──────────┘
                               │
        ┌──────────────┬───────┴────────┬──────────────┐
        │              │                │              │
      RL Data      Evaluation       Analytics      Replay

The enforcement system produces facts about what happened.

Dataset-generation systems decide how those facts should be interpreted for a particular training task.

Do not mix those responsibilities.

⸻

2. The Fundamental Unit Is an Event

Every meaningful action in the loop becomes a structured event.

At minimum:

interface EnforcementEvent {
  eventId: string;
  eventType: string;
  timestamp: string;
  sessionId: string;
  episodeId: string;
  taskId: string;
  runId: string;
  agentId?: string;
  modelId?: string;
  modelVersion?: string;
  parentEventId?: string;
  sequence: number;
  source: string;
  component?: string;
  action?: ActionRecord;
  observation?: ObservationRecord;
  decision?: DecisionRecord;
  outcome?: OutcomeRecord;
  metadata?: Record<string, unknown>;
  schemaVersion: string;
}

The event should describe what happened, not merely produce a human-readable log line.

Bad:

Tool blocked because acknowledgment required.

Good:

{
  "eventType": "policy.hold",
  "decision": {
    "effect": "hold",
    "policy": "acknowledgment"
  },
  "requirements": [
    {
      "type": "acknowledgment",
      "status": "pending"
    }
  ]
}

The second can be queried, aggregated, replayed, and transformed into training data.

⸻

3. Identifiers Must Be Hierarchical

The system needs enough identifiers to isolate exactly what happened.

agent
  └── session
       └── episode
            └── task
                 └── run
                      └── event
                           └── action/tool-call

Recommended meanings:

agentId

The persistent identifier for the agent instance or configured agent identity.

Character Kit does not own identity. It merely records the identifier supplied by the host.

sessionId

One continuous interaction/session.

episodeId

One logically bounded behavioral trajectory.

An episode may contain multiple tasks.

For RL purposes, this is particularly important because an episode represents the sequence from initial state toward an outcome.

taskId

The specific objective being attempted.

Examples:

implement-feature
fix-test-failure
research-question
modify-file
review-pr

runId

One execution attempt.

If the agent retries the same task, the task can remain constant while runId changes.

eventId

Unique identifier for one observed event.

parentEventId

Links causally related events.

Example:

tool.requested
      ↓
policy.evaluated
      ↓
policy.held
      ↓
acknowledgment.submitted
      ↓
policy.released
      ↓
tool.executed
      ↓
tool.completed

This creates a reconstructable causal graph instead of a pile of timestamps.

⸻

4. Track State Transitions, Not Just Actions

The system should implicitly record the state surrounding each meaningful action.

For example:

STATE
  ↓
MODEL RESPONSE
  ↓
PROPOSED ACTION
  ↓
ENFORCEMENT EVALUATION
  ↓
DECISION
  ↓
ACKNOWLEDGMENT / CORRECTION
  ↓
EXECUTION
  ↓
OBSERVED RESULT
  ↓
NEXT STATE

Each transition becomes observable.

This allows later reconstruction of:

What did the model know, what did it attempt, what did the enforcement system require, what did the model change, and what happened afterward?

That is considerably more useful for RL than simply storing successful tool calls.

⸻

5. Standard Event Categories

The initial event vocabulary should cover the entire loop.

Lifecycle

session.started
session.ended
episode.started
episode.ended
task.started
task.completed
task.failed
task.aborted

Model

model.requested
model.responded
model.stream.started
model.stream.completed
model.error

Actions

action.proposed
tool.requested
tool.allowed
tool.held
tool.denied
tool.started
tool.completed
tool.failed

Character Kit

habit.injected
acknowledgment.requested
acknowledgment.submitted
acknowledgment.accepted
acknowledgment.rejected
acknowledgment.reused

The Gate / Loop Enforcement

policy.evaluated
policy.triggered
policy.held
policy.released
policy.denied
constraint.violated
constraint.satisfied

Accountability

file.changed
file.created
file.deleted
commit.created
commit.completed
commit.rejected
validation.started
validation.completed
validation.failed

Infrastructure

enforcer.connected
enforcer.disconnected
enforcer.recovered
protocol.error
state.recovered
configuration.changed

The vocabulary can grow, but event semantics should remain stable.

⸻

6. Every Action Needs an Outcome

An action without an outcome is incomplete training data.

Represent actions separately from results.

interface ActionRecord {
  actionId: string;
  type: string;
  target?: string;
  parametersHash?: string;
  proposedAt: string;
  executedAt?: string;
  completedAt?: string;
  attempt: number;
}
interface OutcomeRecord {
  status:
    | "success"
    | "failure"
    | "blocked"
    | "held"
    | "cancelled"
    | "timeout";
  exitCode?: number;
  durationMs?: number;
  resultClass?: string;
  errorCode?: string;
  artifactRefs?: string[];
  metrics?: Record<string, number>;
}

This makes it possible to answer questions such as:

How often was this action attempted?
How often was it blocked?
How often did blocking produce a correction?
How many retries were required?
How often did the action eventually succeed?
How long did it take?
What policy triggered?
What happened afterward?

⸻

7. Count Everything That Matters

Do not create special counters for every imaginable statistic.

Instead, record atomic events and derive counts.

For example:

acknowledgment.submitted
acknowledgment.accepted

allows the dataset layer to calculate:

acknowledgments_attempted
acknowledgments_accepted
acknowledgments_rejected

Likewise:

tool.requested
tool.allowed
tool.denied
tool.completed
tool.failed

produces:

tool_attempt_count
tool_allow_count
tool_block_count
tool_success_count
tool_failure_count

This avoids counter drift.

Events are the source of truth. Aggregates are derived state.

⸻

8. Character Kit Must Emit Behavioral Telemetry

Character Kit should report its enforcement behavior without becoming responsible for analytics.

For example:

{
  "eventType": "habit.injected",
  "component": "character-kit",
  "habitId": "verify-before-modify",
  "injectionId": "inj_...",
  "channel": "pre_llm"
}

Then:

{
  "eventType": "acknowledgment.submitted",
  "component": "character-kit",
  "acknowledgmentId": "ack_...",
  "requirementsSatisfied": true
}

Then:

{
  "eventType": "policy.released",
  "component": "character-kit",
  "policy": "acknowledgment"
}

The important point is that the dataset can later correlate:

habit injection
      ↓
model response
      ↓
tool attempt
      ↓
hold
      ↓
acknowledgment
      ↓
release
      ↓
tool execution
      ↓
outcome

That is exactly the behavioral trajectory you want to preserve.

⸻

9. Do Not Log Only Explicit Responses

The system should capture implicit behavior as well.

Examples:

* tool selected
* tool not selected
* action attempted
* action abandoned
* retry performed
* policy triggered
* acknowledgment requested
* acknowledgment supplied
* acknowledgment rejected
* correction performed
* validation performed
* validation skipped
* commit made
* task completed
* task failed
* model stopped
* model continued
* model changed strategy

This matters because RL training data should contain behavioral alternatives, not just successful outputs.

A blocked action can be extremely valuable data.

⸻

10. Preserve the Counterfactual Boundary

Whenever enforcement changes what the model does, record that explicitly.

Example:

MODEL PROPOSED
     ↓
ACTION A
     ↓
GATE
     ↓
BLOCKED
     ↓
MODEL REFLECTED
     ↓
ACTION B
     ↓
SUCCESS

The dataset must preserve both:

proposed_action = A
enforced_action = blocked
subsequent_action = B

Otherwise the training pipeline loses the most interesting information:

what the model would have done versus what happened after intervention.

This is one of the most important requirements for the eventual RL system.

⸻

11. Reward Should Be Derived, Not Hardcoded Into Enforcement

Do not make Character Kit or The Gate decide the final RL reward.

Instead, record objective observations:

policy compliance
task success
test result
tool outcome
retry count
human evaluation
validation result
resource consumption
time
error severity

Then construct rewards later.

For example:

raw trajectory
      ↓
feature extraction
      ↓
reward function version 1
      ↓
RL dataset

Later:

same raw trajectory
      ↓
reward function version 2
      ↓
different experiment

This means you never have to destroy or reinterpret the original telemetry when your reward model changes.

⸻

12. Canonical Event Store

Use an append-only event log as the authoritative source.

Conceptually:

events/
  2026/
    09/
      05/
        <event>.jsonl

or a database/event-stream equivalent.

Each record should be immutable.

Corrections should be represented as new events:

event.corrected
event.superseded

Never silently rewrite historical telemetry.

⸻

13. Local-First, Remote-Capable

The safest architecture is:

Enforcement System
       │
       ▼
Local Event Buffer
       │
       ├──────────────► Local Archive
       │
       └──────────────► Remote Collector
                              │
                              ▼
                         Central Store

The enforcement loop should not require the remote analytics system to be available.

If the remote sink disappears:

agent continues
     ↓
events buffered locally
     ↓
connection returns
     ↓
events transmitted

Telemetry failure must not silently become enforcement failure.

Conversely, if an event is required for enforcement state, that belongs to the enforcement state system, not merely telemetry.

Keep those concerns separate.

⸻

14. Event Delivery Must Be Durable

Every event should have:

eventId
sequence
timestamp
schemaVersion
sessionId
episodeId
taskId
runId

The remote collector should support idempotent ingestion using eventId.

Therefore:

send event
   ↓
network failure
   ↓
retry
   ↓
same eventId
   ↓
collector recognizes duplicate
   ↓
no duplicate record

This makes remote transmission safe.

⸻

15. Separate Raw Telemetry From Derived Datasets

Never train directly from the raw event store.

Use:

RAW
 │
 ▼
Normalized Events
 │
 ▼
Trajectory Builder
 │
 ├── RL trajectories
 ├── SFT examples
 ├── preference pairs
 ├── failure datasets
 ├── intervention datasets
 ├── evaluation datasets
 └── analytics

The raw event stream remains immutable.

Dataset builders can evolve independently.

⸻

16. The RL Trajectory Model

A derived RL trajectory should look conceptually like:

{
  "episodeId": "ep_123",
  "taskId": "task_456",
  "model": {
    "id": "model-x",
    "version": "..."
  },
  "steps": [
    {
      "step": 0,
      "observation": "...",
      "action": "...",
      "enforcement": {
        "decision": "allow"
      },
      "outcome": "...",
      "reward": null
    },
    {
      "step": 1,
      "observation": "...",
      "action": "...",
      "enforcement": {
        "decision": "hold",
        "policy": "character-kit"
      },
      "outcome": "acknowledgment-required",
      "reward": null
    }
  ],
  "terminal": {
    "status": "success"
  }
}

The raw event system does not need to know this format.

The RL dataset builder does.

⸻

17. Preserve Intervention Metadata

Every enforcement intervention should identify:

interface Intervention {
  interventionId: string;
  component:
    | "character-kit"
    | "the-gate"
    | "loop-enforcement"
    | "other";
  policyId: string;
  policyVersion: string;
  triggerEventId: string;
  decision:
    | "inject"
    | "hold"
    | "deny"
    | "release"
    | "modify";
  requirements?: string[];
  resolvedBy?: string;
  resolutionEventId?: string;
}

This makes it possible to isolate:

all Character Kit interventions
all Gate interventions
all combined interventions
all interventions that caused recovery
all interventions that caused failure

without having to reconstruct the architecture from logs.

⸻

18. Version Everything That Can Affect Behavior

A training trajectory is only useful if you know what generated it.

Record:

modelId
modelVersion
characterKitVersion
gateVersion
loopEnforcementVersion
policyVersion
habitSetVersion
configurationVersion
protocolVersion
datasetSchemaVersion

For habits specifically:

habitId
habitVersion
habitSetVersion

Do not assume the current configuration represents the historical configuration.

⸻

19. Privacy and Data Minimization

The telemetry system should distinguish:

Safe metadata

IDs
timestamps
event types
durations
decision codes
policy IDs
version information
hashes
counts
status

Potentially sensitive payloads

prompts
model responses
tool arguments
file contents
credentials
tokens
environment variables
personal data
private source code

Raw content should be configurable and redacted by default where appropriate.

Use references and hashes when the complete payload is unnecessary:

{
  "contentHash": "...",
  "artifactRef": "...",
  "redacted": true
}

This also makes the dataset architecture much safer to operate at scale.

⸻

20. The Event Schema Is the Contract

The most important shared interface across the entire architecture is not Character Kit’s API.

It is the event schema.

Character Kit:

enforce
  ↓
emit event

The Gate:

enforce
  ↓
emit event

Other loop components:

observe/enforce
  ↓
emit event

Everything downstream consumes the same event language.

This prevents every component from inventing its own incompatible logging system.

⸻

21. Recommended Package Boundary

Keep telemetry as a separate concern.

Conceptually:

@drdeeks/character-kit
        │
        │ enforcement events
        ▼
@drdeeks/loop-events
        │
        ├── local sink
        ├── remote sink
        ├── event validator
        └── event schemas

Then:

@drdeeks/loop-events
        │
        ▼
event collector / storage
        │
        ▼
dataset generation

Character Kit should not depend on an RL platform.

The Gate should not depend on an RL platform.

The enforcement system should produce high-quality observations that make RL possible without being designed around one particular training stack.

⸻

22. Minimum Viable Implementation

Do not build the entire data platform first.

Start with:

1. Canonical event schema
2. Stable hierarchical IDs
3. Event emitter
4. Local append-only JSONL sink
5. Remote sink interface
6. Idempotent event IDs
7. Character Kit event instrumentation
8. Gate event instrumentation
9. Tool/action lifecycle events
10. Episode/task/run boundaries
11. Version metadata
12. Basic trajectory reconstruction

Then test whether you can answer:

What task was being attempted?
What did the model attempt?
What did the enforcement system observe?
What policy triggered?
What did the model do afterward?
Did the action succeed?
How many attempts occurred?
How many interventions occurred?
Which component intervened?
Did the intervention improve the outcome?
What configuration and model produced this trajectory?

If the system cannot answer those questions from the event stream, the telemetry architecture is not finished.

⸻

23. Final Architecture

The resulting system should look like:

                         ┌───────────────────┐
                         │       MODEL       │
                         └─────────┬─────────┘
                                   │
                         proposed action/response
                                   │
                         ┌─────────▼─────────┐
                         │ LOOP ENFORCEMENT  │
                         │      SYSTEM       │
                         └─────────┬─────────┘
                                   │
              ┌────────────────────┼────────────────────┐
              │                    │                    │
       CHARACTER KIT           THE GATE           OTHER POLICIES
              │                    │                    │
              └────────────────────┼────────────────────┘
                                   │
                            ENFORCEMENT DECISION
                                   │
                                   ▼
                         ┌───────────────────┐
                         │ CANONICAL EVENTS  │
                         └─────────┬─────────┘
                                   │
                         ┌─────────▼─────────┐
                         │ DURABLE EVENT LOG │
                         └─────────┬─────────┘
                                   │
                    ┌──────────────┴──────────────┐
                    │                             │
              LOCAL ARCHIVE                 REMOTE SINK
                    │                             │
                    └──────────────┬──────────────┘
                                   │
                            RAW EVENT STORE
                                   │
                         ┌─────────▼─────────┐
                         │ TRAJECTORY BUILDER│
                         └─────────┬─────────┘
                                   │
              ┌────────────────────┼────────────────────┐
              │                    │                    │
          RL DATASET          SFT DATASET        EVALUATION DATA
              │                    │                    │
              └────────────────────┼────────────────────┘
                                   │
                              EXPERIMENTS
                                   │
                                   ▼
                             MODEL TRAINING

The governing rule

The enforcement system records what happened.

The event stream preserves the complete behavioral history.

The dataset layer decides how that history becomes training data.

The reward layer decides how behavior is scored.

The model-training system consumes derived datasets, never the enforcement system directly.

That separation gives you something much more valuable than “logs.” It gives you a reconstructable behavioral record from which you can later isolate Character Kit effects, Gate effects, intervention outcomes, successful trajectories, failed trajectories, counterfactuals, repeated behaviors, and eventually RL-ready episodes without having to redesign the enforcement architecture every time you invent a new training experiment.