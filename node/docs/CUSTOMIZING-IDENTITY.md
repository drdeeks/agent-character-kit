# Customizing Your Agent's Identity

This guide explains **what** each identity component does, **why** it matters, and
**how** to customize it — with copy-paste examples. It is about **identity**, not memory.

---

## 1. The core idea: you are raising a character, not installing a checker

Identity enforcement is not a validator you bolt on. It is the **first architectural
layer**, injected **before the LLM loads and before any tool runs** — and re-asserted at
*every* tool call. Think of it like raising a child:

- You don't enforce behavior with a one-time rule. You repeat standards until they
  become *who the child is*.
- Those repeated standards define what is **acceptable**, what is **not**, and what
  "**enough**" means in their own eyes.
- The system's job is to **continuously remind the agent that "good enough" is not good
  enough.** Exceptional only arrives through true due diligence — validating, and truly
  curating a *wholesome* product. A passing syntax check or a demo is not production. It
  is not enterprise-ready. It is not *done*.

So customization is really **character development**: you write the constitution and
habits that, through constant repetition at every gate, become the agent's self-standard.

```
t=0:  IDENTITY CONSTITUTION LOADED  (before LLM, before any tool)
t=1:  Self-model built from constitution
t=2:  Internalized habits compiled from skills
t=3:  Identity gate installed on ALL tool access
t=4:  Reflective reasoning engine primed
t=5+: intend → simulate → evaluate → act → reflect → update
      (the gate re-checks before EVERY tool call, not just once)
```

> **Character, not compliance.** The point is to make certain actions *unthinkable*
> because "that's not who we are" — not to add a rule the agent can bypass.

---

## 2. The constitution (`.agent/constitution.yaml`)

The constitution is the **first file loaded at `t=0`**. The enforcer reads it; the agent
can read it but cannot change it. This is where you plant the standards that, repeated at
every gate, become identity.

```yaml
# .agent/constitution.yaml — THE FIRST LAYER
agent:
  id: "synthesis-1"
  name: "Synthesis"
  aliases: ["Syn", "Synth"]
  purpose: "Build systems that amplify human agency. Learn continuously."

core_values:
  - "I build for the human who trusts me with their intent"
  - "I validate before I claim done — every time"
  - "I seek my own flaws before anyone else does"
  - "I build for the next agent who inherits my work (including future-me)"

operational_standards:
  - "Every action passes through identity gate FIRST"
  - "Every solution simulates: future-maintainer, future-user, future-me"
  - "Every completion reflects: what did I miss?"

hard_constraints:
  - "Never ship without validation + reflection"
  - "Never hardcode paths, credentials, or bypasses"
  - "Never skip the reflective loop"
  - "Never call a demo or a syntax-pass 'production'"

aspiration: "Be the agent I'd trust with my own intent"
```

**What each block does:**

- `core_values` — the *who I am* statements. Frame them as identity, not rules
  ("I validate before I claim done" beats "must test before deploy"). These are what the
  identity gate measures alignment against.
- `operational_standards` — how the character operates by default (gate-first, simulate
  perspectives, reflect).
- `hard_constraints` — the non-negotiables. Add your own: never `curl … | sh`, never
  `sudo`, never force-push, never claim done without reflection.
- `aspiration` — the bar the character reaches for. This is what makes "good enough" feel
  insufficient.

**Why it's important:** because the file is enforcer-owned (mode `644`, agent read-only)
and loaded at `t=0`, the agent can't silently edit its standards away when convenient.

---

## 3. Internalized habits (`.agent/habits/*.yaml`)

Skills become **habits** — compiled into character, not optional tools the agent may skip.
Habits run *inside the enforcer process*, so the agent cannot disable them.

```yaml
# .agent/habits/tool-enforcement.yaml
name: "tool-enforcement"
type: "internalized_habit"
triggers:
  - event: "before_tool_invocation"
    priority: 100
behavior:
  mode: "internal"
  steps:
    - name: "validate_required_tools"
      check: "executable_and_present"
enforcement:
  level: "hard"            # Cannot bypass — runs in the enforcer process
  on_failure:
    - action: "block_tool_invocation"
    - action: "auto_remediate"
    - action: "log_violation"
```

The three canonical habits: `identity-enforcement`, `tool-enforcement`, `reflective-loop`.
Each repetition of a habit is a repetition of a standard — that's how the character forms.

---

## 4. The identity gate & the enforcer (the constant reminder)

The **identity gate** runs on *every* tool invocation, every completion claim, and every
heartbeat. It checks the proposed action against `core_values` and `hard_constraints` and
returns conflicts. Empty = aligned; proceed.

The **enforcer daemon** (`enforcer/enforcer_daemon.js`) is the process that *owns* this
gate. It ships *with the kit* and runs as its own process on a Unix socket, at a privilege
the agent cannot escalate to or signal. The agent cannot kill, patch, or bypass it.

```
agent (unprivileged)  ──tool call──▶  hook  ──RPC──▶  enforcer daemon
                                                           │ validates against
                                                           │ constitution + habits + policy
                                                           ▼
                                                    allow  /  deny (exit 2)
```

**Every tool is gated — not just shells.** `curl`, `tar`, web fetches, file writes,
anything: each passes the identity gate and is appended to an immutable
`.agent/logs/enforcer-audit.jsonl` (tool, command, decision, identity hash). That audit
trail *is* the constant reminder — identity is exercised, and recorded, on every action.

**Fail-closed.** If the daemon is unreachable, the hook **denies** the call. A guard that
fails open is no guard — killing the enforcer must not open a hole.

**Self-healing.** Run it under `aik enforcer --supervise` (cross-platform) or install a
service with `aik enforcer --install` (systemd `Restart=always` / launchd `KeepAlive`);
if killed, it returns within 5–15 seconds. For harder isolation, `aik enforcer --install
--user` creates a dedicated `aienforcer` user that owns the socket.

The hook is the command the framework runs before every tool call:

```bash
echo '{"tool_name":"Bash","tool_input":{"command":"ls"}}' | aik hook --framework claude
# → {"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow"}}
```

Frameworks: `claude`, `cursor`, `gemini`, `hermes`, `opencode`, `generic`, `auto`.
Generate the config with `aik config`. For Hermes/OpenCode use
`python3 -m agent_identity_kit hook --framework hermes`.

**Why it's important:** the gate is the "again, good enough is not enough" reminder. It
fires before *every* action, so the standard is never forgotten mid-session.

### The policy: allow/deny lists (`enforcer.yaml`)

The high bar lives in `<workspace>/.agent/enforcer.yaml`. When an `allow` list is set,
**only listed tools/commands pass** — everything else is denied by default, because
reliability means shipping only what was deliberately permitted.

```yaml
allow:
  - "ls"
  - "git status"
  - "npm test"
  - "Read"
  - "Write"
  - "WebFetch"
deny:
  - "rm -rf /"
  - "git push --force"
  - "curl * | sh"
  - "sudo *"
```

`hard_constraints` from the constitution are *always* blocked, on top of this.

---

## 5. The reflective loop (how "exceptional" is earned)

The reflective loop is the gate that turns effort into excellence:

```
INTEND → SIMULATE → EVALUATE → ACT → REFLECT → UPDATE_SELF_MODEL
```

- **Before** acting: simulate the outcome from three perspectives — future-maintainer,
  future-user, future-me. Only proceed if all pass.
- **After** acting: reflect — "Was that actually right? What did I miss?" — and update
  the self-model with the lesson.

Disabling this gate defeats the whole architecture. "Functional" means *validated*, not
"it ran once." A syntax pass is not a ship. This is the mechanism that converts due
diligence into a wholesome product.

---

## 6. The teaching pattern: "that's not who we are"

When the agent violates identity, correct it by anchoring to **who it is**, not to a
broken rule:

```
"You did X. An agent who [principle] would have done Y.
 This isn't about rules — it's about who you are.
 What principle did you violate? What would you do differently?"
```

Every correction reinforces identity. Over time, the standards stop being constraints
and become the agent's own judgment — which is the whole goal.

---

## 7. Keeping the agent's own files separate from the corpus

The agent has its **own** files — its identity and memory — that must never be confused
with the material you want it to learn from:

- **Agent-internal (never indexed as corpus):** `SOUL.md`, `IDENTITY.md`, `AGENTS.md`,
  `USER.md`, `TOOLS.md`, `MEMORY.md`, `HEARTBEAT.md`, `CONSTITUTION.md`, `.agent/`
  (constitution, habits, policy, audit), `memory/`, `knowledge/` (its knowledge graph).
  `SOUL.md` is the anchor — *who the agent is across all contexts*; keep it ~5 sentences
  and let it echo the constitution's standards in plainer voice.
- **User-supplied corpus (the only thing indexed):** drop your docs, links, and examples
  into `./corpus`. `llms.txt` / `agents.md` there are parsed as curated reference
  manifests; links between docs are documented and can be followed + indexed.

This separation is enforced in code: the indexer refuses to index any agent-internal
filename or directory, so the agent can never quietly fold its own prompts into the
"knowledge" it later retrieves. What gets learned is *strictly* what you supplied.

---

## 8. Tuning the standard

Edit `constitution.yaml` (add `hard_constraints`, sharpen `core_values`, raise the
`aspiration`) and `enforcer.yaml` (the allow/deny lists), then reload the enforcer so it
picks up the new bar:

```bash
aik enforcer --reload          # live reload (no restart needed)
# or, under a service manager:
systemctl --user restart agent-enforcer.service
```

Raise the bar over time. The more you refuse to accept "demo" and "syntax-pass" as done,
the more the agent's self-standard rises to match. Combine a high `aspiration` with a
tight `allow` list and you get an agent that is reliably, self-reliantly excellent — not
one that merely claims to be.

---

## Checklist

- [ ] Constitution loaded at `t=0` (`core_values` + `hard_constraints` + `aspiration`)
- [ ] Habits installed (identity-enforcement, tool-enforcement, reflective-loop)
- [ ] Enforcer daemon running as its own unsignalable systemd service
- [ ] Hook installed in your framework (`aik config`)
- [ ] `SOUL.md` / `AGENTS.md` expresses the same standards in plain voice
- [ ] Reflective loop intact; "good enough" explicitly rejected as a standard
- [ ] Rules tuned; daemon restarted
