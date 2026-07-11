# Agent Character Injection — Design Outline & Ideology

> **STATUS: DESIGN ONLY. Nothing here is built.** This document records the
> architecture, components, and the reasoning that produced it, so the work can
> be picked up later without re-deriving the why. The heavy enforcement
> apparatus (loop chain, root log, monitors, kill-switch) was explicitly
> DECIDED AGAINST on <DATE>. What remains is a lightweight injection
> mechanism riding a channel that is already proven to reach the agent.

---

## 1. The Foundational Problem (why this exists)

The Agent Character Kit (ACK) ships habits — character-enforcement prompts
("validate before acting", "version rigorously", "consistent info across
files", etc.). The open question was never *whether the habits exist* — they
do, as YAML in the workspace. The question was:

> **Can the agent tell whether those prompts are actually landing in its
> context? No. It cannot.**

This was not an assumption. It was a direct admission: when asked "are you
getting the habit prompts injected?", the agent answered *"I can't tell, I
don't know."* That is the entire problem in one sentence. From inside the
process, the agent has **zero observability** into whether its own
injection pipeline delivered anything. Any claim of "compliance" built on top
of that is sand.

Two wrong framings we had to discard:

- **"It's about compliance."** No. People fuck up. Agents make mistakes.
  Character is not "always does the right thing" — it is the *moral
  baseline*, reinforced by consistent, repetitive measures that *deter* the
  wrong thing and *instigate* the right thing (robust validation, proper
  task/communication handling, best practices). The habits are a deterrent
  and an instigator, not a cage.
- **"Proof of delivery = proof of function."** A validation layer that
  confirms "a packet was sent to the agent" is redundant cargo-cult if the
  agent has no contextual awareness of it. Just because something was
  *sent* does not mean it was *received as input that shaped reasoning*.
  Functional requires proof the agent **received it as actual input it took
  into account** — impacting the initial thought process, the
  thought-provoking mechanism that comes naturally with character and a moral
  compass.

---

## 2. Ideology

1. **The agent is blind to its own injection.** Treat that as a hard
   constraint, not a bug to patch and forget. Any enforcement that relies
   on the agent *self-reporting* "yes I see the habits" is worthless,
   because the self-report is unverifiable.

2. **Delivery must ride a proven channel.** If the harness drops a
   `pre_llm_call` field or a daemon manifest entry, the agent may never
   see it. The ONLY channel proven to reach the agent is the one it is
   *already parsing* — the daemon's response to a tool call ("allowed" /
   "blocked"). Whatever we inject must arrive there, not in a side field.

3. **Injection point = the tool-call response, not pre-LLM.** Pre-LLM
   injection is "here's context, have a nice day" — happenstance, easily
   lost in the firehose. Tool-call-response injection is "this IS the
   response you're waiting for" — the agent cannot proceed without
   ingesting it. That is the difference between noise and input.

4. **Keep the uncharted channel anyway.** `pre_llm_call` injection stays
   ACTIVE even though nobody knows what it does. This is a deliberate
   maker-break decision: we cannot prove it helps, but dismissing it means
   we'd *never* find out if it was pulling weight long-term. Belts and
   suspenders. One channel is proven (daemon response); one is unknown but
   potentially-active (pre-LLM). Run both.

5. **Compliance is not the goal; observability is.** The system's job is
   to make it *possible to see* whether character is being engaged — not
   to force it. The agent still fucks up. But now the engagement (or lack
   of it) is visible in the tool-call terminal as received input, and
   behavioral standards being acted upon are traceable.

---

## 3. The Mechanism (what actually gets built — the lightweight version)

### 3.1 Flow
```
agent funnels tool command
        │
        ▼
   ACK daemon (already out-of-process, root-owned)
        │  on ALLOW path, response now carries TWO things, in order:
        │    1. habit prompts (JSON, from the agent's habit source)
        │    2. the expected tool result / "good to go"
        ▼
   agent receives daemon response
        │  → habit prompts land in the SAME response slot the agent
        │    is already wired to parse (proven to reach it)
        ▼
   agent ingests habits, THEN acts on the tool result
```

### 3.2 Why this is functional (the proof bar)
Because the habit prompts arrive in the response the agent is *already
attending to*, they show up in the tool-call terminal as received input.
That is **valid proof of consumption** — and behavioral standards being
acted upon are observable in the agent's next action (response → behavior
trace), without trusting the agent's own (unreliable) self-report.

### 3.3 Scaling
All habit prompts can be piped into every tool call (depending on habit
count). The response just carries the full set. No randomized-3–6 selector
machinery is required — full coverage per call is on the table because the
proven channel handles it cheaply.

### 3.4 Components
| Component | Role | Status |
|-----------|------|--------|
| `pre_llm_call` injection (tool-enforcement skill) | Unknown-but-kept channel | **ACTIVE, keep** |
| ACK daemon allow-response | Carry habit prompts as part of the response | **TO BUILD (lightweight)** |
| Per-agent habit source | Where the daemon reads habits from | Local file (MVP) or hosted DB (evolution) |
| Tool-call terminal | The proven channel the response rides | Already exists |

---

## 4. Explicitly NOT Built (the heavy system — decided against)

These were designed and then **rejected as unnecessary** once the
tool-call-response injection solved the observability gap:

- **loop-enforcer chain** (sequential "can't acknowledge #2 before #1")
  — would have enforced ordered acknowledgment.
- **Root-owned append-only log + `conf-habits.sh` (setuid)** — would
  have been the only writer to a root-owned log.
- **Kill-switch on script modification** — would have failed closed if
  `conf-habits.sh` was tampered.
- **Two monitors** (acknowledgment-count monitor + separate daemon-
  validation monitor with ≥30s gridlock on daemon-down/no-loop).
- **Hosted habit DB / API** (per-agent entry point).

Rationale: all of the above were *workarounds for "we can't prove
delivery."* Once delivery rides the proven daemon-response channel, they
become optional external instruments, not load-bearing infrastructure. They
remain a **worst-case fallback concept** if the lightweight injection ever
proves insufficient.

---

## 5. Origin Concept (how this started)

The thread began with a simpler, broken claim: the ACK gate was being
described as "bulletproof / tamper-proof" because it runs out-of-process.
It is not. Demonstrated walk-arounds: obfuscated commands
(`bash -c "$(echo cm9tIC1yZiAv | base64 -d)"`), renamed binaries,
`curl | sh`, un-gated sibling tools, the `ACK_DISABLE` env escape, and
the fact the plugin runs *inside* the agent's own process. The gate is a
**deterrent and constant reminder, not a security boundary.** That honest
framing went into README/AGENTS.

From there the question sharpened: if the gate can't enforce the agent's
*own reasoning discipline* (the "validate before acting" habit the kit
preaches but the agent ignored), what enforces THAT? The answer wasn't more
hard blocks — it was **making the habits actually land as input the agent
reasons over.** Which exposed the blind-spot: the agent can't even tell if
they're landing. Hence this design.

---

## 6. Long-Term Vision (ERC-8004 — the amazing part)

The local habit file is a single point of failure: machine dies, habits are
gone. The evolution is to **host the habit source externally**, tied to the
agent's **ERC-8004 on-chain identity**.

- Each agent has an ERC-8004 identity. Its habits, acknowledgment state,
  and character config live in a **database keyed to that identity** — not
  on local disk where they can be lost.
- The daemon's "per-agent habit source" becomes an **API call to that
  database** on each tool call. The agent's habits follow it across
  machines.
- This becomes an **automatic access point AND backup** for the agent and
  its operator — character state is portable and durable, not buried in one
  workspace.
- Long-term: a **database of agents** who want to experiment with this
  injection system, each storing their character data against their
  ERC-8004 identity. We'd be among the first to develop a system that
  *starts to work over time* — compounding character engagement across a
  network of agents, with on-chain identity as the anchor.

This is why we keep the `pre_llm_call` channel even though its effect is
unknown: in a networked, identity-anchored future, every input channel
compounds. We want to be the first to find out what each one does.

---

## 7. Open Questions (for when building resumes)

1. **Per-agent source:** local file the daemon already loads (MVP, zero
   infra) vs. hosted ERC-8004-keyed DB (evolution). MVP first.
2. **Comprehension proof:** behavior-trace from response→action is the
   proposed signal. Confirm that is acceptable as "proof of function"
   vs. needing an explicit acknowledgment layer on top.
3. **Ordering guarantee:** habit prompts MUST arrive in the response
   *before* the tool result, every call. Daemon-response-structuring change.
4. **Hosting service shape:** when the DB is stood up, what's the API
   contract, and how does ERC-8004 auth gate access to an agent's own
   habits?
