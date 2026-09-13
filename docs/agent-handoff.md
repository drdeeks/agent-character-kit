Agent Handoff Lifecycle Specification

1. Purpose

This specification defines a standalone, adaptive agent handoff mechanism responsible for preserving the operational state of an agent across context compaction and subsequent continuation.

The handoff mechanism is not itself an agent harness, provider, model target, transport protocol, or execution environment.

It is a foundational state-preservation component that can be invoked by whatever agent architecture is hosting it.

Its responsibility is simple:

Determine what the current agent must carry forward, materialize that state into a durable handoff package, verify that the package is sufficient, and only then permit or trigger context compaction.

The handoff therefore exists before compaction, not as a consequence of compaction.

⸻

2. Core Lifecycle

The canonical lifecycle is:

LIVE AGENT STATE
       │
       ▼
┌─────────────────────┐
│ HANDOFF ACTIVATION  │
└──────────┬──────────┘
           │
           ▼
┌─────────────────────┐
│ STATE SCANNER       │
│                     │
│ Inspect current     │
│ operational state   │
└──────────┬──────────┘
           │
           ▼
┌─────────────────────┐
│ RELEVANCE /         │
│ COMPLETENESS ENGINE │
│                     │
│ Determine what must │
│ survive compaction  │
└──────────┬──────────┘
           │
           ▼
┌─────────────────────┐
│ HANDOFF BUILDER     │
│                     │
│ Materialize durable │
│ continuation state  │
└──────────┬──────────┘
           │
           ▼
┌─────────────────────┐
│ VALIDATION GATE     │
│                     │
│ Verify required     │
│ state exists        │
└──────────┬──────────┘
           │
      ┌────┴────┐
      │         │
    FAIL       PASS
      │         │
      ▼         ▼
 REPAIR /    HANDOFF
 RESCAN      SEALED
                │
                ▼
       ┌─────────────────┐
       │ COMPACTION      │
       │ TRIGGER         │
       └────────┬────────┘
                │
                ▼
       ┌─────────────────┐
       │ NEW CONTEXT     │
       │ INITIALIZATION  │
       └────────┬────────┘
                │
                ▼
       ┌─────────────────┐
       │ HANDOFF         │
       │ RECONSTRUCTION  │
       └────────┬────────┘
                │
                ▼
       CONTINUED AGENT

The critical ordering is:

SCAN
  ↓
BUILD
  ↓
VERIFY
  ↓
SEAL
  ↓
TRIGGER COMPACTION
  ↓
RECONSTRUCT

Never:

COMPACTION
  ↓
"try to figure out what mattered"

⸻

3. Handoff Is a Pre-Compaction Authority

The handoff mechanism becomes the final authority over whether the agent is ready to lose its current context.

Context pressure alone must not be treated as sufficient justification for compaction.

Instead:

Context pressure detected
        │
        ▼
Handoff requested
        │
        ▼
Current state scanned
        │
        ▼
Required continuation state identified
        │
        ▼
Handoff materialized
        │
        ▼
Handoff validated
        │
        ├── FAIL ──► repair/rescan
        │
        ▼
       PASS
        │
        ▼
Handoff sealed
        │
        ▼
Compaction triggered

This establishes a hard invariant:

No destructive context transition occurs until the continuation state has been successfully materialized and validated.

⸻

4. State Scanning

The scanner examines the current agent state rather than relying exclusively on the conversation transcript.

The scanner should be capable of identifying state such as:

* active objective
* current task
* completed work
* unfinished work
* pending operations
* decisions already made
* decisions still unresolved
* constraints
* user requirements
* architectural invariants
* active files
* modified files
* generated artifacts
* relevant commands
* command results
* tool results
* external references
* discovered errors
* known failures
* attempted approaches
* rejected approaches
* current hypotheses
* verified facts
* unverified assumptions
* dependencies
* environmental requirements
* credentials/configuration references where preservation is appropriate without exposing secrets
* active sub-agents
* agent-to-agent state
* queued work
* temporal ordering
* provenance
* recovery information

The scanner must distinguish between:

FACT
DECISION
CONSTRAINT
STATE
INTENT
ASSUMPTION
HYPOTHESIS
PENDING WORK
COMPLETED WORK
FAILURE
RECOVERY INFORMATION

These categories must not be collapsed into an undifferentiated summary.

⸻

5. The Scanner Must Preserve Operational Meaning

A handoff is not merely a shortened transcript.

Bad:

"The user is building an agent system and wants it
to preserve memory across compaction."

Useful:

OBJECTIVE:
Build a standalone pre-compaction handoff subsystem.
CURRENT STATE:
Handoff lifecycle has been defined.
ARCHITECTURAL INVARIANT:
Handoff must complete before compaction.
TRIGGER:
Handoff validation success authorizes compaction.
CONSTRAINT:
Do not define the system around a specific harness,
provider, transport, or model.
REFERENCE:
Existing OpenCode behavior demonstrates useful
handoff-oriented capabilities.
NEXT ACTION:
Produce implementation architecture for the standalone
handoff subsystem.
DO NOT REPEAT:
Previous architectural mistake of treating the handoff
as an integration adapter.

The second representation preserves operational continuity.

⸻

6. Relevance and Priority

The handoff engine must determine what information is necessary for continuation.

Information should be evaluated according to at least:

CONTINUATION NECESSITY
        +
DEPENDENCY
        +
RECENCY
        +
USER IMPORTANCE
        +
ARCHITECTURAL IMPORTANCE
        +
RECOVERY VALUE
        +
UNRESOLVED STATUS

A useful conceptual priority model is:

P0  = mandatory for safe continuation
P1  = required for accurate continuation
P2  = strongly useful context
P3  = optional historical context
P4  = disposable

Examples:

State	Priority
Current objective	P0
Architectural invariant	P0
Unfinished operation	P0
Required recovery instruction	P0
User-imposed constraint	P0
Current file modifications	P0/P1
Critical decisions	P1
Known failures	P1
Pending questions	P1
Supporting reasoning	P2
Historical exploration	P3
Redundant conversation	P4

The exact scoring mechanism may evolve.

The invariant does not:

Anything whose loss could cause the resumed agent to make a materially different decision must be eligible for preservation.

⸻

7. Handoff Package

The output of the handoff engine is a structured continuation artifact.

Conceptually:

HANDOFF PACKAGE
│
├── identity
├── timestamp
├── lifecycle metadata
├── objective
├── current state
├── completed work
├── pending work
├── decisions
├── constraints
├── invariants
├── verified facts
├── assumptions
├── unresolved questions
├── failures
├── recovery state
├── active resources
├── artifact references
├── dependency references
├── provenance
└── continuation instructions

The package should be machine-readable where practical and human-inspectable when debugging.

⸻

8. Durable State

The handoff must conform to the principles of the Forever system.

The important distinction is:

CONTEXT
    ≠
MEMORY
    ≠
HANDOFF
    ≠
ARCHIVE

They may contain overlapping information, but they perform different lifecycle functions.

Context

Immediate working state supplied to the model.

Memory

Longer-lived knowledge intended to influence future operation.

Handoff

The authoritative continuation package created immediately before a destructive context transition.

Archive

Historical state retained for provenance, auditability, recovery, or reconstruction.

The handoff may reference memory and archival material.

It must not assume that those systems alone will reconstruct the exact operational state that existed immediately before compaction.

⸻

9. Forever-System Alignment

The handoff mechanism must preserve the following Forever principles:

9.1 Persistence

Important state must not exist exclusively inside ephemeral context.

9.2 Provenance

Where practical, preserved information should retain enough provenance to establish where it originated.

9.3 Continuity

A resumed agent must be capable of determining:

What was happening?
Why was it happening?
What has already happened?
What remains?
What decisions were made?
What constraints remain active?
What must happen next?

9.4 Recovery

The handoff must provide sufficient information for recovery after interruption.

9.5 Idempotence

Repeated handoff attempts must not corrupt durable state.

A second scan should produce either:

* the same valid handoff,
* a newer version,
* or an explicitly superseding version.

9.6 Versioning

Handoffs should carry an identifiable lifecycle/version marker.

Conceptually:

handoff-00041
handoff-00042
handoff-00043

The system should never silently overwrite historical state when doing so would destroy recovery information.

⸻

10. Handoff Sealing

After construction, the handoff enters a validation phase.

Validation should establish:

[ ] Objective exists
[ ] Current task exists
[ ] Required constraints exist
[ ] Critical decisions exist
[ ] Pending work exists
[ ] Required artifacts are referenced
[ ] Recovery information exists where necessary
[ ] No required state was truncated
[ ] Package is internally consistent
[ ] Package is persistently available

Only after successful validation does the handoff become:

SEALED

A sealed handoff represents the state that the system is willing to trust across compaction.

⸻

11. The Compaction Trigger

The handoff subsystem ultimately controls the transition into compaction.

The sequence is:

CONTEXT THRESHOLD / HANDOFF REQUEST
              │
              ▼
       BEGIN HANDOFF
              │
              ▼
        SCAN STATE
              │
              ▼
      BUILD PACKAGE
              │
              ▼
         VALIDATE
              │
        ┌─────┴─────┐
        │           │
       FAIL        PASS
        │           │
        ▼           ▼
      RESCAN      SEAL
                    │
                    ▼
             TRIGGER COMPACTION

This is fundamental.

The handoff subsystem does not merely prepare information for a compaction system.

It establishes the condition under which compaction is safe.

⸻

12. Compaction Must Not Race the Handoff

The system must prevent this class of failure:

Handoff starts
      │
      ├──── Context compacts
      │
      └──── Handoff finishes

That creates an incomplete handoff.

Instead:

Handoff lock / transition state
          │
          ▼
     State frozen
          │
          ▼
      Scan/build
          │
          ▼
       Validate
          │
          ▼
        Seal
          │
          ▼
  Compaction permitted

The transition must therefore have an explicit lifecycle state.

Example:

ACTIVE
HANDOFF_REQUESTED
SCANNING
BUILDING
VALIDATING
SEALED
COMPACTION_AUTHORIZED
COMPACTING
RESUMING
RECONSTRUCTED
CONTINUED

Failure states should be explicit rather than inferred.

⸻

13. Reconstruction

After compaction, the receiving context consumes the sealed handoff.

The reconstruction process should restore:

IDENTITY
   ↓
OBJECTIVE
   ↓
CURRENT STATE
   ↓
CONSTRAINTS
   ↓
DECISIONS
   ↓
PENDING WORK
   ↓
RECOVERY INFORMATION
   ↓
RELEVANT MEMORY / ARCHIVE REFERENCES
   ↓
CONTINUATION

The resumed agent should not have to reconstruct the previous state by guessing from fragments.

The handoff is the bridge.

⸻

14. Continuation Verification

After reconstruction, the system should verify that the new context has successfully recovered the handoff.

Conceptually:

SEALED HANDOFF
      │
      ▼
RECONSTRUCTION
      │
      ▼
STATE CHECK
      │
      ├── mismatch ──► recovery path
      │
      ▼
    MATCH
      │
      ▼
CONTINUATION

A continuation check should be capable of identifying:

* missing objective
* missing constraints
* missing pending work
* missing critical decisions
* stale state
* inconsistent state
* missing artifact references
* invalid assumptions
* incomplete recovery information

⸻

15. Scanner Capability

The scanner is a first-class capability.

It should not be limited to scanning the immediate conversational transcript.

Where the surrounding architecture permits it, it may inspect:

conversation state
agent state
workspace state
tool state
artifact state
memory references
active tasks
queued tasks
execution history
recovery records
handoff history

The scanner should identify relationships between these sources rather than treating every source independently.

For example:

CURRENT TASK
     │
     ├── depends on FILE A
     │
     ├── depends on DECISION B
     │
     ├── constrained by RULE C
     │
     └── blocked by FAILURE D

The resulting handoff must preserve those relationships.

⸻

16. Provider and Harness Adaptability

The handoff mechanism must not encode a permanent dependency on any particular provider, model, harness, protocol, or execution environment.

Its interfaces should therefore be capability-oriented.

Conceptually:

             ┌────────────────────┐
             │ HANDOFF CORE        │
             └─────────┬──────────┘
                       │
        ┌──────────────┼──────────────┐
        ▼              ▼              ▼
     Scanner        Builder        Validator
        │              │              │
        └──────────────┼──────────────┘
                       │
                 Handoff Store
                       │
                 Compaction Gate
                       │
                Reconstruction

External systems interact with the handoff through defined capabilities rather than becoming part of its identity.

⸻

17. OpenCode Reference Behavior

OpenCode is relevant only as an existing implementation demonstrating useful operational patterns around agent continuation and context handoff.

Its relevant conceptual capabilities include mechanisms for:

* recognizing context pressure
* preparing continuation information
* preserving important state
* carrying operational context forward
* supporting continuation across context boundaries
* working with substantial file/context state

Those behaviors should be treated as reference behavior.

The standalone handoff architecture may reproduce, improve, generalize, or replace those behaviors without inheriting the surrounding implementation assumptions.

The target is the capability:

Reliable pre-compaction state preservation and continuation.

Not the reproduction of an external implementation.

⸻

18. Failure Handling

A handoff failure must stop or defer destructive compaction.

Examples:

STATE SCAN FAILURE
       ↓
retry / alternate scan
PACKAGE BUILD FAILURE
       ↓
repair / rebuild
VALIDATION FAILURE
       ↓
identify missing state
       ↓
rescan
PERSISTENCE FAILURE
       ↓
do not authorize compaction
RECONSTRUCTION FAILURE
       ↓
load previous sealed handoff
       ↓
recovery

The system should prefer:

OLD VALID HANDOFF

over:

NEW INVALID HANDOFF

⸻

19. Handoff Queue and Recovery

If multiple handoff events occur before a previous transition has completely resolved, they should be represented as ordered lifecycle events rather than discarded.

Conceptually:

HANDOFF EVENT 41
HANDOFF EVENT 42
HANDOFF EVENT 43
        │
        ▼
     QUEUE
        │
        ▼
ORDERED PROCESSING

The queue must preserve event ordering and allow the system to determine which handoff supersedes another.

This prevents transient failures from becoming permanent state loss.

⸻

20. No Lossy “Summary First” Architecture

The handoff system must not begin with the assumption:

“Summarize the conversation.”

Instead:

SCAN
  ↓
CLASSIFY
  ↓
RELATE
  ↓
PRIORITIZE
  ↓
PRESERVE
  ↓
VALIDATE
  ↓
SUMMARIZE WHERE APPROPRIATE

Summarization is an optimization.

State preservation is the requirement.

⸻

21. Canonical Handoff Contract

A conceptual handoff object should contain at minimum:

{
  "handoff": {
    "id": "unique-handoff-id",
    "version": 1,
    "status": "sealed",
    "created_at": "...",
    "source_state": "...",
    "objective": "...",
    "current_state": "...",
    "completed": [],
    "pending": [],
    "decisions": [],
    "constraints": [],
    "invariants": [],
    "verified_facts": [],
    "assumptions": [],
    "unresolved": [],
    "failures": [],
    "recovery": [],
    "artifacts": [],
    "dependencies": [],
    "provenance": [],
    "continuation": {
      "next_action": "...",
      "required_context": [],
      "validation": []
    }
  }
}

This is illustrative rather than a fixed serialization requirement.

The underlying contract is what matters.

⸻

22. Architectural Invariants

The following rules are mandatory:

Invariant 1

Handoff occurs before compaction.

Invariant 2

Handoff validation occurs before compaction authorization.

Invariant 3

The handoff mechanism may ultimately trigger compaction.

Invariant 4

Compaction must never be allowed to destroy the only copy of required continuation state.

Invariant 5

The handoff is not merely a transcript summary.

Invariant 6

The scanner must be capable of inspecting operational state beyond conversational text where the surrounding architecture exposes it.

Invariant 7

The mechanism must remain adaptable to different execution environments.

Invariant 8

No external harness becomes the architectural identity of the handoff system.

Invariant 9

Forever-system persistence and recovery principles apply to handoff state.

Invariant 10

A failed handoff cannot silently authorize destructive compaction.

Invariant 11

A sealed handoff must remain recoverable.

Invariant 12

The resumed agent must be able to determine what to do next without reconstructing critical state through guesswork.

⸻

23. Minimal Lifecycle API

A conceptual implementation can expose capabilities equivalent to:

requestHandoff()
scanState()
classifyState()
buildHandoff()
validateHandoff()
sealHandoff()
authorizeCompaction()
triggerCompaction()
loadHandoff()
reconstructState()
verifyContinuation()
resume()

The implementation may combine or rename these operations.

The lifecycle must remain equivalent.

⸻

24. End-to-End Lifecycle

The definitive lifecycle is:

                    ┌──────────────────┐
                    │   ACTIVE AGENT   │
                    └────────┬─────────┘
                             │
                             ▼
                  ┌─────────────────────┐
                  │ HANDOFF REQUESTED   │
                  └──────────┬──────────┘
                             │
                             ▼
                  ┌─────────────────────┐
                  │   SCAN LIVE STATE   │
                  └──────────┬──────────┘
                             │
                             ▼
                  ┌─────────────────────┐
                  │ CLASSIFY + RELATE   │
                  └──────────┬──────────┘
                             │
                             ▼
                  ┌─────────────────────┐
                  │ PRIORITIZE REQUIRED │
                  │ CONTINUATION STATE  │
                  └──────────┬──────────┘
                             │
                             ▼
                  ┌─────────────────────┐
                  │ BUILD HANDOFF       │
                  └──────────┬──────────┘
                             │
                             ▼
                  ┌─────────────────────┐
                  │ PERSIST HANDOFF     │
                  └──────────┬──────────┘
                             │
                             ▼
                  ┌─────────────────────┐
                  │ VALIDATE HANDOFF    │
                  └──────────┬──────────┘
                             │
                       ┌─────┴─────┐
                       │           │
                     FAIL         PASS
                       │           │
                       ▼           ▼
                    REPAIR       SEAL
                       │           │
                       └─────┐     │
                             │     ▼
                             │  AUTHORIZE
                             │  COMPACTION
                             │     │
                             │     ▼
                             │  COMPACT
                             │     │
                             │     ▼
                             │  LOAD SEALED
                             │  HANDOFF
                             │     │
                             │     ▼
                             │  RECONSTRUCT
                             │     │
                             │     ▼
                             │  VERIFY
                             │     │
                             │     ▼
                             │  CONTINUE
                             │
                             └──────────────►
                                RESCAN

⸻

25. Definition of Done

The handoff subsystem is complete when an agent can:

1. Detect or receive a request for context transition.
2. Scan its available operational state.
3. Determine which state is necessary for continuation.
4. Preserve critical decisions, constraints, objectives, unfinished work, failures, and recovery information.
5. Construct a durable handoff package.
6. Validate that package.
7. Refuse destructive compaction if validation fails.
8. Seal the valid package.
9. Trigger or authorize compaction only after sealing.
10. Reconstruct the next context from the sealed handoff.
11. Verify successful reconstruction.
12. Continue operation without requiring critical state to be rediscovered from the discarded context.
13. Preserve lifecycle history according to Forever-system persistence principles.
14. Recover from interrupted or failed handoff operations.
15. Remain adaptable to the execution environment in which it is deployed.

⸻

26. Final Architectural Statement

The handoff is a pre-compaction state transition system.

It does not exist to summarize a conversation.

It exists to preserve the agent’s ability to continue operating correctly after its current context ceases to exist.

The fundamental sequence is therefore:

LIVE STATE
    ↓
SCAN
    ↓
UNDERSTAND
    ↓
PRESERVE
    ↓
VALIDATE
    ↓
SEAL
    ↓
TRIGGER COMPACTION
    ↓
RECONSTRUCT
    ↓
VERIFY
    ↓
CONTINUE

The handoff is the bridge between ephemeral context and durable continuity.

Its implementation should take advantage of proven behaviors demonstrated by existing agent systems, including OpenCode where appropriate, while remaining an independent, capability-oriented foundation.

The intended long-term home for this capability is the Agent Character Kit, where the handoff mechanism can become part of the broader character/agent foundation rather than being permanently coupled to any particular external execution system.