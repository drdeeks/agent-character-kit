# Agent Identity Kit

**Universal identity enforcement + knowledge + memory for any AI agent framework.**

Agent Identity Kit (AIK) makes sure every tool call your agent makes goes through a
**separate, tamper-proof enforcer** that validates the action against your agent's
identity, constitution, and permissions. It also gives you a knowledge indexer (with
YAML frontmatter on every document) and a three-layer memory system — all
framework-agnostic.

---

## Two packages, one standard

AIK ships in **two variants that are at full parity** — same behaviors, same data files,
same enforcement logic:

| Variant | Role | Entry point |
|---------|------|-------------|
| **Node.js** (`aik`) | Primary. Ships the **enforcer daemon**, CLI, and all commands. | `npm i -g agent-identity-kit` |
| **Python** (`agent_identity_kit`) | Companion. Runs the same hooks, indexer, memory, and semantic search for Python-based agents (Hermes, OpenCode) and talks to the Node daemon. | `pip install -e ./python` |

Both read the **same config** (`.agent/constitution.yaml`, `.agent/enforcer.yaml`),
write the **same audit trail**, and obey the **same fail-closed** rule. The enforcer
*daemon* is a Node process; the Python package is a client that enforces the identical
policy class (`Enforcer`) in-process for tests and Python-first setups.

> Pick the package that matches your agent's runtime. Everything below works in both —
> command examples are shown per version.

---

## Why this matters

Customizing identity is **character development, not installing a checker**. The
constitution and habits are injected **before the LLM loads and before any tool runs**,
and are re-asserted at *every* tool call — like raising a child, where repeated standards
become *who they are*: what is acceptable, what is not, and what "enough" means in their
own eyes.

The system's job is to **continuously remind the agent that "good enough" is not good
enough.** Exceptional only arrives through true due diligence — validating, and curating
a *wholesome* product. A passing syntax check or a demo is not production. It is not
enterprise-ready. It is not *done*.

Structurally, this means:

- The **enforcer daemon** runs as its *own* tamper-proof service on a Unix socket.
  The agent process cannot edit, kill, or patch it.
- Every tool call passes through a **hook** installed in the agent framework. The hook
  blocks the call until the enforcer says `allow`.
- The agent's **identity** and **constitution** live in files the enforcer reads — files
  the agent itself does not control.

```
 agent  ──tool call──▶  identity hook  ──RPC──▶  enforcer daemon  ──▶  allow / deny
   (any          (framework            (separate,         validates against
 framework)      adapter)              tamper-proof       identity + constitution
                                       service)
```

This is the difference between an agent that *says* it follows your standards and one
that *actually cannot lower them*.

> **Every tool call is enforced.** `curl`, `tar`, web fetches, file writes — all of it
> passes the identity gate and is written to an append-only `enforcer-audit.jsonl` trail.
> If the enforcer is unreachable, the hook **fails closed** (denies), so killing the
> daemon cannot open a hole. (Dev opt-out: `AIK_FAIL_OPEN=1`.)

---

## Install

### Node.js

```bash
npm install -g agent-identity-kit        # CLI: aik
# or run without installing:
npx agent-identity-kit hook --framework claude
```

### Python

```bash
cd python && pip install -e .
python3 -m agent_identity_kit --help
```

---

## Quick start

### Node.js

```bash
# 1. Install a self-healing enforcer service (systemd on Linux, launchd on macOS)
aik enforcer --install            # writes the unit; then:
systemctl --user enable --now agent-enforcer.service   # (Linux)
# or, without a service manager, just run the self-healing supervisor:
aik enforcer --supervise

# 2. Place your constitution + policy (examples in ./node/examples)
cp node/examples/constitution.yaml .agent/constitution.yaml
cp node/examples/enforcer.yaml        .agent/enforcer.yaml

# 3. Wire the hook into your framework (prints the config snippet)
aik config

# 4. Drop user docs into ./corpus and index them (agent-internal files are excluded)
aik index run                    # defaults to ./corpus
aik memory log "Shipped v2" --tags "release"
aik knowledge add Kyle --type person --facts '{"timezone":"PST"}'
```

### Python

```bash
# 1. Point Python at the same workspace the Node daemon protects
export AGENT_WORKSPACE="$HOME/.openclaw/workspace"

# 2. Run the identity hook (reads the same constitution + enforcer policy)
echo '{"tool_name":"Bash","tool_input":{"command":"ls"}}' | \
  python3 -m agent_identity_kit hook --framework hermes

# 3. Same corpus / memory / knowledge / semantic commands as the Node CLI
python3 -m agent_identity_kit index --path ./corpus
python3 -m agent_identity_kit memory log "Shipped v2" -t "release"
python3 -m agent_identity_kit knowledge add Kyle --type person --facts '{"timezone":"PST"}'
python3 -m agent_identity_kit semantic search "authentication flow"
```

> The Python hook enforces **the same policy** as Node — it contacts the Node enforcer
> daemon over the Unix socket. Run both, or run Python standalone (its `Enforcer` class
> evaluates policy in-process when no daemon is present).

---

## Establish the full system (self-contained)

AIK ships everything needed to stand the system up on any machine:

1. **Enforcer daemon** (`enforcer/enforcer_daemon.js`) — a separate Node process the agent
   cannot modify, signal, or patch. It owns the Unix socket and judges every tool call
   against the constitution, habits, and `enforcer.yaml` policy (allow/deny lists).
2. **Self-healing** — run under `aik enforcer --supervise` (cross-platform) or a systemd
   unit with `Restart=always`; if killed, it returns within 5–15 seconds. Optionally
   create a dedicated `aienforcer` user (`aik enforcer --install --user`) so the agent
   can't even read the socket.
3. **Identity + policy files** in `<workspace>/.agent/` — `constitution.yaml`
   (core_values, hard_constraints, aspiration) and `enforcer.yaml` (allow/deny lists).
4. **Corpus** (`./corpus`) — the only directory the indexer reads: the user-supplied
   docs, links, and examples the agent should learn from. The agent's own files
   (`SOUL.md`, constitution, habits, memory, knowledge graph) are kept in dedicated dirs
   and are **never indexed as corpus**.
5. **Hooks** — `aik hook --framework <fw>` (Node) or
   `python3 -m agent_identity_kit hook --framework <fw>` (Python) for
   claude / cursor / gemini / hermes / opencode, generated via `aik config`.

All paths are **self-resolving** (script location > env > `$HOME` fallback) and the
package is **platform-agnostic** (Linux, macOS, any framework).

---

## Key components

### 0. Enforcer daemon (shipped, tamper-proof, self-healing)

`enforcer/enforcer_daemon.js` is the guardian. It runs as its own process, owns the Unix
socket, and validates **every** tool call (shell, `curl`, `tar`, web, file writes — all of
them) against the constitution, habits, and `enforcer.yaml` policy. It cannot be modified
or killed by the agent.

- **Allow/deny policy** — `enforcer.yaml` sets a strict allow-list; unlisted tools are
  denied by default. `hard_constraints` from the constitution are always blocked.
- **Audit trail** — every gated call is appended to `.agent/logs/enforcer-audit.jsonl`
  (tool, command, decision, identity hash). This is the continuous reminder: identity is
  exercised on *every* action.
- **Fail-closed** — if the daemon is unreachable, the hook **denies** (a guard that fails
  open is no guard).
- **Self-healing** — `aik enforcer --supervise` respawns it within 5–15s if it dies; the
  systemd/launchd unit uses `Restart=always`.

```bash
aik enforcer --install            # platform service (self-healing)
aik enforcer --supervise          # or run the supervisor directly
aik enforcer --status             # validate workspace integrity
```

> The Python package mirrors this logic with the `Enforcer` class (in-process policy
> evaluation) and the `EnforcerClient` (RPC to the Node daemon), so Python agents enforce
> identically whether or not the daemon is running.

### 1. Identity & constitution (`.agent/constitution.yaml`)

The constitution is the **first file loaded at `t=0`** — before the LLM and before any
tool. The enforcer reads it; the agent can read but not change it. This is where you plant
the standards that, repeated at every gate, become the agent's self-standard. Canonical
shape:

```yaml
agent:
  id: "synthesis-1"
  name: "Synthesis"
  purpose: "Build systems that amplify human agency."
core_values:
  - "I validate before I claim done — every time"
  - "I seek my own flaws before anyone else does"
operational_standards:
  - "Every action passes through identity gate FIRST"
hard_constraints:
  - "Never hardcode paths, credentials, or bypasses"
  - "Never ship without validation + reflection"
  - "Never call a demo or a syntax-pass 'production'"
aspiration: "Be the agent I'd trust with my own intent"
```

The **identity gate** evaluates `core_values` + `hard_constraints` on *every* tool call,
completion claim, and heartbeat. Skills become **internalized habits** (`.agent/habits/`)
that run inside the enforcer process, so the agent cannot disable them. The **reflective
loop** (`intend → simulate → evaluate → act → reflect → update`) is what earns
"exceptional": before acting, simulate future-maintainer / future-user / future-me; after
acting, reflect on what was missed. "Functional" means *validated*, not "it ran once."

> **Character, not compliance.** The point is to make certain actions *unthinkable*
> because "that's not who we are" — not to bolt on a checker the agent can bypass. A demo
> is not done. Syntax passing is not shipped. Raise the bar; the agent's standard rises to
> meet it.

### 2. The hook (the door)

A tiny command the framework runs **before every tool call**. It proxies the call to the
enforcer and blocks it (exit code 2 for Claude/Cursor/Gemini) when denied.

```bash
# Node
echo '{"tool_name":"Bash","tool_input":{"command":"ls"}}' | aik hook --framework claude
# → {"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow"}}

# Python
echo '{"tool_name":"Bash","tool_input":{"command":"ls"}}' | \
  python3 -m agent_identity_kit hook --framework hermes
```

Supported frameworks: `claude`, `cursor`, `gemini`, `hermes`, `opencode`, `generic`, `auto`.

### 3. Knowledge indexer (with YAML frontmatter)

Discovers many file types and gives every indexed document structured frontmatter so
semantic search is precise:

```bash
# Node
aik index run ./docs              # discover, follow local links, parse llms.txt
aik index run ./docs --no-follow  # catalog links but don't index referenced files

# Python
python3 -m agent_identity_kit index --path ./docs
python3 -m agent_identity_kit index --path ./docs --no-follow
python3 -m agent_identity_kit index --search "query"
```

```yaml
---
id: docs-readme
title: readme
category: documentation
tags: ["readme", "intro"]
type: documentation
source: docs/README.md
indexed_at: "2026-07-09T11:00:00.000Z"
updated_at: "2026-07-09T10:30:00.000Z"
---
```

**Link documentation:** the indexer records *every* link it finds in a document —
markdown links, `[[wiki links]]`, `![[embeds]]`, `doc:`/`ref:` references, and bare URLs.
Local links can be **followed and indexed too**, so referenced docs are never orphaned.
`llms.txt` / `agents.md` are parsed as curated reference manifests — their links are
indexed as references.

**File types discovered:** Markdown & docs (`.md` `.mdx` `.rst` `.adoc` `.org` `.tex`
`.wiki`), data/config (`.yaml` `.json` `.toml` `.ini` `.xml` `.csv`), source code (`.py`
`.js` `.ts` `.go` `.rs` `.sql` … 30+ languages), and agent files (`SOUL.md` `AGENTS.md`
`IDENTITY.md` `llms.txt` `agents.md` `.agent` `.skill` `.hook`).

### 4. Semantic search

AIK gives you **searchable memory** — find by meaning, not just keywords. Documents are
split into overlapping chunks (so context isn't lost at boundaries), embedded into
vectors (optional local `@xenova/transformers`, all-MiniLM-L6-v2), and searched with a
**hybrid** ranking that fuses vector similarity and BM25 keyword match via Reciprocal
Rank Fusion (RRF): `score = Σ 1/(k + rank)`.

```bash
# Node
aik semantic search "authentication flow"     # hybrid: semantic + keyword
aik semantic status                            # shows whether vector model is loaded

# Python
python3 -m agent_identity_kit semantic index      # build vector index from corpus
python3 -m agent_identity_kit semantic search "authentication flow"
python3 -m agent_identity_kit semantic hybrid "authentication flow"
python3 -m agent_identity_kit semantic status
```

- **Vector search** — best for conceptual queries ("what did I learn about X").
- **BM25 / keyword** — best for exact terms and names.
- **Hybrid** — best for general recall; surfaces docs that rank in either method.

Every chunk is stored with metadata (`source`, `category`, `tags`, `indexed_at`), so
results can be filtered by document type. Without the embedding model installed, keyword
search still works over chunks.

**Search discipline.** Memory only helps if it's *used*. Build the habit (and bake it
into `AGENTS.md`) to **search before acting**:

- At session start: search `<main topic>` to surface prior context.
- When a name/topic comes up: pull everything known about it.
- Before a significant action: search for similar past work and lessons.

> The meta-point: you don't need perfect memory, you need *searchable* memory. Every
> file you write becomes retrievable by meaning. That compounds.

### 5. Three-layer memory

```
memory/
├── daily/YYYY-MM-DD.yaml        # Layer 1: raw timeline of what happened
├── weekly/week-YYYY-MM-DD.yaml  # Layer 2: patterns curated from daily notes
└── long-term.yaml               # Layer 3: curated lessons, patterns, decisions
knowledge/
└── entities/<name>.yaml         # Structured facts: people, orgs, topics
```

```bash
# Node
aik memory log "Refactored indexer" --tags "refactor" --category development
aik memory lesson "Context Conservation" "Fresh context beats exhausted"
aik memory decision "Use YAML frontmatter" "<context>" "<decision>" "<rationale>"
aik knowledge add Kyle --type person --facts '{"timezone":"PST"}'

# Python
python3 -m agent_identity_kit memory log "Refactored indexer" -t "refactor" -c development
python3 -m agent_identity_kit memory lesson "Context Conservation" "Fresh context beats exhausted"
python3 -m agent_identity_kit memory decision "Use YAML frontmatter" "<context>" "<decision>" "<rationale>"
python3 -m agent_identity_kit knowledge add Kyle --type person --facts '{"timezone":"PST"}'
```

**Why it matters:** memory turns a stateless chatbot into an agent that *accumulates*
wisdom. Each layer has a distinct job:

- **Daily notes** capture events raw — conversations, decisions, errors, links. Write
  constantly; "mental notes" don't survive a context reset.
- **Weekly digests** extract patterns from the daily noise.
- **Long-term memory** stores curated lessons, patterns, and decisions — wisdom, not a
  log.
- **Knowledge graph** holds structured facts about entities (people, orgs, topics) so
  recall scales past a handful of names.

Every morning the agent can: read `SOUL.md` → skim long-term memory → check today's daily
note → query the knowledge graph → search semantically. The knowledge indexer also
records **every link** in a document (`[[wiki]]`, markdown, `doc:`/`ref:`, URLs) and can
follow local links to index referenced docs too — so no informational doc is orphaned.

### 6. Persona files (`SOUL.md`, `AGENTS.md`, `llms.txt`, …)

`SOUL.md` is the agent's anchor — *who it is across all contexts*. AIK auto-discovers and
indexes: `SOUL.md`, `IDENTITY.md`, `AGENTS.md`, `USER.md`, `TOOLS.md`, `MEMORY.md`,
`HEARTBEAT.md`, `CONSTITUTION.md`, `llms.txt`, `agents.md`, `.agent`, `.skill`, `.hook`.

---

## Command reference

### Node.js (`aik`)

| Command | Purpose |
|---------|---------|
| `aik hook` | Validate a tool call (the enforcement entry point) |
| `aik enforcer` | Manage the daemon (install / supervise / status / heartbeat) |
| `aik index` | Index documents with YAML frontmatter, follow links, parse `llms.txt` |
| `aik semantic` | Vector search over indexed content |
| `aik memory` | Daily / weekly / long-term memory (YAML) |
| `aik knowledge` | Knowledge graph of people, orgs, facts |
| `aik config` | Emit framework-specific hook configs |

### Python (`python3 -m agent_identity_kit`)

| Command | Purpose |
|---------|---------|
| `python3 -m agent_identity_kit hook` | Validate a tool call (same policy as Node) |
| `python3 -m agent_identity_kit enforcer --status` | Validate workspace integrity via daemon |
| `python3 -m agent_identity_kit index --path <dir>` | Index documents (corpus + links + `llms.txt`) |
| `python3 -m agent_identity_kit memory <log\|lesson\|decision\|search\|status>` | Memory ops |
| `python3 -m agent_identity_kit knowledge <add\|get\|search\|list>` | Knowledge graph ops |
| `python3 -m agent_identity_kit semantic <index\|search\|hybrid\|status>` | Vector / hybrid search |

---

## Python API

For Python-first agents, use the package as a library:

```python
from agent_identity_kit import (
    DocumentIndexer, Memory, SemanticSearch, Enforcer, EnforcerClient,
)

# Knowledge indexing (corpus only; agent-internal files excluded)
idx = DocumentIndexer(workspace)
idx.init()
result = idx.index_directory("./corpus", {"followLinks": True})

# Three-layer memory + knowledge graph
mem = Memory(workspace)
mem.init()
mem.daily.log("Shipped v2", ["release"], "dev")
mem.longterm.add_lesson("Context", "Fresh beats exhausted", ["x"])
mem.knowledge.add_entity("Kyle", "person", {"timezone": "PST"}, [])

# Semantic / hybrid search (optional vector model; keyword works without it)
sem = SemanticSearch(workspace)
sem.init()
sem.index_document("c1", "authentication flow ...", {"category": "docs"})
hits = sem.hybrid_search("auth flow", idx.search("auth flow"))

# In-process policy evaluation (mirrors the Node daemon)
enf = Enforcer()
decision = enf.execute_tool("Bash", {"command": "rm -rf /"})  # -> {"denied": True, ...}

# Or validate against a running Node daemon
client = EnforcerClient()
allowed = client.validate_tool("Bash", {"command": "ls"})      # async
```

Every class is fully independent — import only what you need; the hook/identity layer
works with none of this present.

---

## Tuning enforcement

Edit `constitution.yaml` (add `hard_constraints`, refine `core_values`) and restart the
enforcer so it reloads:

```bash
systemctl --user restart agent-enforcer.service
```

Before claiming "done," the **reflective loop** (`intend → simulate → evaluate → act →
reflect → update`) simulates future-maintainer / future-user / future-me. If any says
"not done yet," it isn't. Disabling this gate defeats the architecture.

---

See **[node/docs/CUSTOMIZING-IDENTITY.md](node/docs/CUSTOMIZING-IDENTITY.md)** for a full guide to
customizing identity, constitutions, and hooks — with copy-paste examples and the *why*
behind each piece.
