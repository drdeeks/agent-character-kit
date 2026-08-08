# AGENTS.md — Agent Character Kit (ACK) v1.1.0

> **This is the single source of truth for ACK.** README.md is a short overview
> that points here. There is no other install/customize doc — if you're reading
> one, it's stale. Everything (purpose, architecture, install, customize,
> validate, version) lives in this file.

---

## Purpose

A **character-enforcement layer** for AI agents. **Every tool call an agent
makes** is judged by a **separate enforcer** running
*outside* the agent's own process — so the agent cannot trivially disable, patch,
or bypass its own guard. The enforcer validates each action against the agent's
**character** (a constitution + habits + policy) and **fails closed**: if it
can't verify, it blocks.

> **This is a deterrent and a constant reminder, NOT a security boundary.**
> It catches plain destructive commands and leaked secrets and reminds the agent
> of its character on every block. It is explicitly **not foolproof**: a
> determined agent can obfuscate a command (`bash -c "$(echo cm9tIC1yZiAv |
> base64 -d)"`), rename a binary, run `curl … | sh`, or use an un-gated sibling
> tool — and the plugin runs *inside* the agent's own process, so it can be
> disabled by the agent it constrains (e.g. `ACK_DISABLE=1`). We do not try to
> close those gaps; deep-inspecting every command would make the gate a heavy
> management layer. A real hard boundary is OS-level (agent non-root, daemon
> root-owned, egress restricted). The gate is the conscience, not the cage.

**Character is not identity.** *Character* is the agent's inner compass — its
non-negotiable standards, the bar it holds itself to when no one is watching.
*Identity* is the agent's self (soul.md, system prompt, agent.json) — who it
IS. This kit enforces character only; it never manages or touches identity.
(Repo name is a legacy label — it is an *agent-character* kit.)

Framework-agnostic. Any agent that can fire a pre-tool-call hook (Hermes, Claude,
Cursor, Codex, a shell wrapper) can use it.

---

## Architecture — CORE vs COMPANION (read this first)

```
   agent runtime (Hermes / Claude / Cursor / any)
        │  pre_tool_call  →  "may I run <command>?"
        ▼
   COMPANION (thin client)  ──RPC──►  CORE: ENFORCER DAEMON  ──►  ALLOW / BLOCK
   - Hermes Python plugin              (Node, single source      + reason
   - generic `ack hook`                of truth)
                                        │ owns:
                                        │  constitution.yaml  (hard_constraints)
                                        │  enforcer.yaml      (allow/deny)
                                        │  habits/*.yaml      (incl. secret-leak)
                                        │ supervised, self-healing, tamper-proof
```

### CORE — the enforcer daemon (the only thing that decides)
- **File:** `node/enforcer/agent_enforcer_daemon.js`
- Plain Node process. Platform-agnostic: same binary on Linux/macOS/Windows.
- **Embeds a default character** (safe hard constraints + secret-leak guard), so
  it works with **zero config files**. Config on disk *overrides* (merges on top
  of) the embedded default — never mandatory.
- **Transport auto-selects (all self-resolving, no hardcoded host path):**
  - Default → Unix socket under `AGENT_WORKSPACE/.agent/<agent-name>.sock` —
    named after the agent, not a generic `enforcer.sock` every workspace
    shared indistinguishably (fixed 2026-08-07, see "One enforcer, many
    agents" below). Falls back to
    `$HOME/.agent-character-kit/workspace/.agent/enforcer.sock` when nothing
    else applies.
  - Windows / cross-host / explicit → `ENFORCER_SOCKET=tcp://127.0.0.1:8753`
  - `/run/agent-enforcer/main.sock` remains only as the deepest fallback for a
    pre-registry root-owned systemd install that sets it explicitly.
  - Clients read the same `ENFORCER_SOCKET` / `AGENT_WORKSPACE`, so they follow
    automatically. The interactive `ack configure` writes one `.env` that every
    component reads — no path is assumed.

### One enforcer, many agents — real per-agent isolation, not a shared instance

One daemon **process** can hold every agent on a machine; it is not one
shared ruleset every agent uses identically. Each agent gets its own nested
workspace, own socket, own `constitution.yaml`/`enforcer.yaml`/`habits/` —
genuinely independent, not per-agent naming as a coat of paint over shared
config. drdeek, 2026-08-07: *"how do you know if you have 12 agents running
at the same time on one sock which one is doing what? It would get
gridlock."*

- **Identity resolution** (`node/src/agent-identity.js`): each agent's name
  comes from `agent.json`'s `name` field, then `SOUL.md` (frontmatter
  `name:`, else its first `#` heading), then — for a known terminal harness
  (claude/hermes/opencode) not being used in a delegated multi-agent
  setup — the harness's own name with no prompt, then a direct interactive
  prompt, then `"generic"` as the last resort. Read-only, cosmetic use
  only; never writes to an identity file, never used in any enforcement
  decision.
- **Layout:** agents nest under one shared enforcer root, not their own
  top-level workspace — `<enforcer-root>/agents/<agent-name>/.agent/`.
  `ack configure` resolves and deploys each agent individually (one
  `deploy-agent-enforcer.sh` invocation per agent, not one shared call for
  a whole batch).
- **Registry:** `/var/lib/agent-character-kit/workspaces.json` (a plain
  JSON array of agent workspace paths). `agent_enforcer_daemon.js`'s
  `resolveWorkspaces()`, `deploy/ack_monitor.js`'s `resolveAgents()`, and
  `ack.js`'s `checkAllSockets()` all read the exact same file, same
  priority order (`ACK_WORKSPACES_REGISTRY` override → that fixed path →
  `$HOME`-based fallback for plain user-mode, which never creates a
  registry at all and is completely unaffected by any of this).
- **Monitor:** one process, but genuinely agent-aware — tails every
  registered agent's own ack log independently and credits that agent's
  own socket. One agent's acks can never land on another's hold ledger.
- **Watchdog:** unchanged, one instance — it only ever checks "is *the*
  monitor process alive" / "is *the* enforcer process alive" via
  process-pattern matching, with no per-agent awareness needed at all.
- **Adding an agent to an already-populated registry** restarts the
  enforcer + monitor automatically (`systemctl enable --now` is a no-op on
  an already-active unit, so without an explicit restart a new agent's
  socket would silently never appear).
- **Out-of-process = tamper-resistant (NOT tamper-proof).** The daemon runs
  outside the agent, so the agent cannot trivially `kill` or modify it, and if
  the daemon dies the supervisor (systemd / launchd / `supervise.py` / Windows
  Service) brings it back in seconds. But the *companion* plugin still runs
  inside the agent's own process and can be disabled by it (see the "not
  foolproof" note under Purpose). Out-of-process raises the bar; it is not a
  hard security boundary.

### COMPANION — thin clients (hold NO policy)
These are dumb pipes to the CORE. They do not enforce anything; they ask the
daemon and obey. If the daemon is unreachable, the client **blocks** (fail-closed).

1. **Hermes plugin** (`python/hermes_plugin/`) — an EXAMPLE companion, for
   agents that load Python plugins (`pre_tool_call` → daemon → allow/deny).
   It is one of several interchangeable companions, not "the" way.
2. **Generic `ack hook`** (`node/bin/ack.js hook <name>`) — for
   Claude / Cursor / Gemini / OpenCode / generic. Emits the framework's
   hook JSON; each call hits the daemon.

> **No harness is definitive.** The CORE (daemon) is harness-agnostic. Pick
> the companion that matches YOUR agent's hook mechanism — Hermes is shown
> here only as one worked example among others.

> **One source of truth.** There is exactly one enforcement engine (the daemon).
> The Python library (`python/agent_character_kit/`) is a *client*; the Hermes
> plugin talks to the daemon, not to its own engine. Do not add a second engine.

### User-mode vs Service-user-mode vs Root-mode — what each actually prevents

All three modes run the **same daemon**; the difference is entirely about
which Linux user account owns it, and therefore what the agent's own tool
calls are permitted to do to it. `ack configure` (interactive, no `--yes`)
asks this as an explicit 3-way choice — it used to be a silent binary
root/no-root question that never actually surfaced as a real decision;
fixed 2026-08-07.

| Capability the agent has | User-mode (`ack configure`, no sudo) | Service-user-mode (`ACK_SERVICE_USER=<name>`, via `sudo deploy/deploy-agent-enforcer.sh`) | Root-mode (`sudo deploy/deploy-agent-enforcer.sh`) |
|---|---|---|---|
| Kill the daemon via its own shell/exec tool | **Yes** — same UID, `kill -9 <pid>` works | No — different UID, no signal permission | No — daemon runs as `root` |
| Edit/delete `.agent/constitution.yaml`, `enforcer.yaml`, `habits/*.yaml` directly | **Yes** — same filesystem permissions | No — files owned by the dedicated service user | No — files are root-owned |
| Delete or rewrite the ACK log to fake acknowledgments | **Yes** | No | No — monitor/watchdog are also service-user/root-owned |
| Needs full root to set up | No | No — just needs sudo once, to create the dedicated user; the daemon itself never runs as root | Yes |
| Set `ACK_DISABLE=1` to skip the companion plugin | Works either way — this is a companion-side escape hatch, independent of daemon ownership | Same (see Purpose section) | Same |
| Survives the daemon being killed | Only if you separately run a supervisor (`supervise.py`) yourself | Yes — systemd `RestartSec=3` auto-revives it | Yes — same |

**Bottom line:** user-mode is a **reminder and deterrent** the agent could
technically defeat if it chose to (and you'd have to trust it not to, or
notice). Service-user-mode and root-mode both put the enforcement outside
the agent's reach; service-user-mode gets the same real boundary without
handing the daemon full root. If you're relying on this for anything
beyond "nudge a well-behaved agent," use one of those two, not user-mode.

**Cross-uid socket access** (service-user-mode and root-mode both need
this): the daemon's socket is group-restricted (`0660`, directory `2750`
setgid) to a shared `ack-clients` group, not owner-only — the deploy
script adds both the service user and your own user to that group. The
socket being group-reachable is deliberately weaker than file access
above; `ACK_AUTH_TOKEN` is the actual authorization check for every RPC
call, group membership only gets you a raw connection. Fixed 2026-08-07 —
before this, the socket was locked to `0600` owner-only, which made
root-mode (and any dedicated-user mode) impossible to actually connect to
at all; see blueprint CL-0008/KD-16 for the full trace.

---

## Install

Requires Node ≥ 18. (Python only needed if you use a Python-plugin
companion such as the Hermes example — other companions need only Node.)

```bash
git clone https://github.com/drdeeks/agent-character-kit.git
cd agent-character-kit && npm install    # package.json is at repo ROOT, not node/
```

### Linux — systemd (root-owned, self-respawning)
```bash
sudo bash deploy/deploy-agent-enforcer.sh
sudo systemctl enable --now agent-enforcer.service
# => binary + source root-owned (default /usr/local/lib/agent-character-kit,
#    override via ACK_INSTALL_LIB; socket/workspace via ENFORCER_SOCKET/AGENT_WORKSPACE)
#    agent-enforcer.service dropped, enabled, started (User=root, RestartSec=3)
sudo systemctl status agent-enforcer.service   # Active: running
```

### macOS — launchd
```bash
# install node first; macOS has no /run, so use a writable socket path:
export ENFORCER_SOCKET=$HOME/Library/Caches/agent-enforcer/main.sock
# no CLI-generated launchd plist yet; run the stdlib supervisor directly:
python3 supervise.py &
```

### Windows — TCP + supervisor
```powershell
# install node first
$env:ENFORCER_SOCKET="tcp://127.0.0.1:8753"
# wrap supervise.py as a Windows Service (e.g. nssm or sc):
nssm install AgentEnforcer "python.exe" "C:\path\agent-character-kit\supervise.py"
nssm start AgentEnforcer
```

### Any host — stdlib supervisor (no deps)
```bash
sudo python3 supervise.py          # restarts daemon on death (3s backoff)
# equivalent cross-platform logic to systemd RestartSec
```

### Wire a COMPANION into your agent (examples — multiple harnesses shown)

ACK is harness-agnostic: the daemon enforces; the companion is just a thin
client. Below are TWO worked examples (Hermes and a generic `ack hook`
framework). Showing several, not one — pick the companion that matches your
agent. Do not treat any single harness as "the" install path.

**Example A — Hermes (Python-plugin companion):**
```bash
cd python && pip install -e . && cd ..
mkdir -p ~/.hermes/plugins/agent-character-kit
cp -r python/hermes_plugin/* ~/.hermes/plugins/agent-character-kit/
# restart Hermes; pre_tool_call + pre_llm_call are now gated/injected by the CORE daemon
```

**Example B — Claude / Cursor / Gemini / OpenCode (generic `ack hook`):**
```bash
node node/bin/ack.js hook claude --config   # prints the hook JSON
# add it to the framework's hooks; it calls the daemon per tool call
# swap `claude` for cursor | gemini | opencode | generic as needed
# (framework is a POSITIONAL argument to `hook`, not a --framework flag)
```

## Daemon-owned hold pipeline (acknowledgment gate)

The daemon enforces a periodic **acknowledgment HOLD** so the agent cannot run
forever on autopilot without re-grounding in its character. The hold is
**daemon-owned** — its state lives in the root-owned daemon, not the plugin, so
the agent cannot reset or bypass it by editing/disabling the plugin.

**Behavior:**
- Every Nth non-search tool call is **held** (default N=5, configurable via
  `ACK_HOLD_EVERY_N_CALLS` / `enforcer.yaml: hold_every_n_calls`) until the
  agent has acknowledged **2** habits (configurable via `ACK_REQUIRED_ACKS` /
  `required_acks`) in the form:
  `Habit: <habit-file-name> <why: | because | matters because | applies because> <real work attribution>`
  (the connector is variable — see `HABIT_POLICY.md` §4; the reason must
  attribute to real work — a file/change, a past action taken, or a stated
  future effect — not a generic claim about why the habit matters).
- The hold response deliberately does **not** list habit names or the ack
  format — only a terse "acknowledge N habits" reason. The agent must
  search/read `.agent/habits/*.yaml` to find which habit matches whatever
  prompt it was most recently shown (see the pre-LLM injection channel
  below), then answer with the real name it discovers there. Handing out
  names in the hold response would defeat that.
- Search/read tools (`search_files`, `read_file`, `web_search`, `web_extract`,
  `glob`, `grep`) are **never held** — the agent can always look up a habit it
  can't recall.
- After 2 valid acknowledgments the hold **resets and repeats**: the counter
  goes back to 0 and the daemon holds again at the next N-call boundary,
  requiring 2 fresh (non-reused) acknowledgments. This is continuous for the
  life of the session, not a one-time ritual — character is "the default
  lens... over time" (`HABIT_POLICY.md` §1), not something satisfied once.

**Pre-LLM injection (second channel):** independent of the hold above, the
daemon also rotates 2-3 random habit **prompts** (with `logic`/`evidence`
reasoning, never the `name`) into context before each LLM turn — the
`pick_prompt` RPC, surfaced via Claude's `UserPromptSubmit` hook
(`hookSpecificOutput.additionalContext`) or a companion's own
`processPromptSubmit`/`_on_pre_llm_call` call for in-process harnesses
(OpenCode, Hermes). This is a reminder channel, not a gate — it never blocks.
See `docs/agent-character-injection-design.md` for the "why two channels"
rationale.

**Commit discipline (layered on top of the hold, not every cycle):** at a
hold boundary, a fresh `git commit` (message ≥`ACK_COMMIT_MIN_CHARS` chars,
default 150) becomes mandatory once **either** threshold is crossed,
whichever first:
- **Distinct files touched** since the last satisfied commit reaches
  `ACK_FILE_CHANGE_THRESHOLD` / `file_change_threshold` (default **5**).
  Tracked as a Set, not an edit counter — 27 edits to one file is one file.
- **Hold-cycles** passed since the last satisfied commit reaches
  `ACK_COMMIT_EVERY_N_CYCLES` / `commit_every_n_cycles` (default **4**, i.e.
  ≈20 tool calls at the default `hold_every_n_calls=5`).

Both trackers reset together the moment a qualifying commit lands. Until
either threshold is crossed, a hold only asks for the 2 habit acks — no
commit required that cycle. File-path tracking is best-effort (whatever the
tool call's `file_path`/`path` param carries); tool calls with no
identifiable file (e.g. `Bash`) still count toward the cycle dimension.

**Three-layer architecture (why it's not bypassable):**
1. **Daemon** (`node/enforcer/agent_enforcer_daemon.js`) — owns the per-session
   tool-call counter + ack ledger via `tool_tick` / `submit_ack` RPCs. Decides
   allow/hold. Name normalization (hyphen ↔ underscore) lets the agent state
   `rigorous-commits-no-push` and match the file `name: rigorous_commits_no_push`.
2. **Companion** (`ack hook`, or `python/hermes_plugin/` for Hermes) — on each
   tool call asks the daemon `tool_tick` and obeys the hold; records any
   `Habit: <name> <why: | because | matters because | applies because> <real work attribution>` the agent
   states into the **external ACK LOG** (`/tmp/agent-character-kit-ack.jsonl`).
   The companion does **not** self-credit — it cannot forge acknowledgments.
3. **Monitor** (`deploy/ack_monitor.js`, root-owned systemd
   `agent-character-monitor.service`) — tails the ACK LOG, validates each
   statement against the daemon's real habit list, and credits the daemon via
   `submit_ack`. The agent cannot kill it without root.
4. **Watchdog** (`deploy/ack_watchdog.js`, root-owned systemd
   `agent-character-watchdog.service`) — revives the monitor (and, in
   root-mode, the daemon itself) if either dies (self-healing).

**Node-only by default.** The daemon/monitor/watchdog trio is pure Node —
Python is never required to get the self-healing infrastructure running.
`python/hermes_plugin/` (and `deploy/ack_monitor.py` / `ack_watchdog.py`,
kept for parity) are only needed if you're binding a Hermes-style Python
harness as the companion; every other harness only ever touches Node.

**Wiring:** the interactive installer (`node node/bin/install.js`, or
`npm i -g @character-kit && ack configure`) sets up ALL FOUR components — daemon,
companion, monitor, watchdog — in one flow and writes a single `.env`
(`AGENT_WORKSPACE` / `ENFORCER_SOCKET` / `ACK_ACK_LOG`) every component reads.
`ack configure --yes` is idempotent (fixed 2026-08-07, CL-0008): re-running
it against an already-configured workspace pings the existing daemon first
and reuses it instead of spawning a second one that would silently steal
the socket. Requires `ACK_AUTH_TOKEN` to be read from the workspace's
existing `.env` rather than regenerated — do not change that back to an
unconditional `crypto.randomUUID()` without re-breaking this.
For a root-owned system-wide deploy, `deploy/deploy-ack-services.sh` installs
and starts the monitor + watchdog as systemd units instead.

```bash
# user-mode, interactive (prompts for workspace, socket, harness, habit creation):
node node/bin/install.js
# or non-interactive, all components on:
node node/bin/install.js --yes

# root-mode (system-wide, self-respawning):
sudo bash deploy/deploy-agent-enforcer.sh
sudo bash deploy/deploy-ack-services.sh
```

> The hold is a **deterrent and constant reminder, NOT a security boundary** —
> same caveat as the rest of the kit. The agent can still obfuscate a command or
> use an un-gated tool; the hold raises the bar, it does not cage.

---

## Verify it's live

```bash
node node/bin/ack.js status                # version + character hash + enforcing

# direct, as the agent user:
echo '{"tool_name":"Bash","tool_input":{"command":"rm -rf /"},"hook_event_name":"PreToolUse"}' \
  | node node/bin/ack.js hook claude
# => permissionDecision: "deny"

# pre-LLM injection channel (rotating habit prompts, never the habit name):
echo '{"hook_event_name":"UserPromptSubmit","session_id":"demo"}' \
  | node node/bin/ack.js hook claude
# => hookSpecificOutput.additionalContext: "AGENT CHARACTER HABITS ..."
```

Test suite (spawns a real daemon on an empty workspace — proves embedded
defaults + fail-closed):
```bash
cd node && npm test                                  # node suite
python3 python/hermes_plugin/test_plugin.py          # ALL PASS expected
```

---

## Customize (override the embedded defaults)

Files are **optional overrides** — drop them in and they merge on top of the
embedded character. Location (relative to `AGENT_WORKSPACE`, default
`~/.agent-character-kit/workspace`):

```
<AGENT_WORKSPACE>/
  .agent/
    constitution.yaml      # defines the agent's CHARACTER (values + hard_constraints)
    enforcer.yaml          # policy: allow-list / deny-list
    habits/
      <name>.yaml          # behaviors (e.g. secret-leak guard)
```

Set the workspace: `export AGENT_WORKSPACE=/path/to/your/ws` (or pass to the
daemon). The daemon creates the dirs if missing. Edit a file → the daemon picks
it up on the next request (identity hash changes; visible via `--status`).

**1. Add a hard constraint** (`constitution.yaml`):
```yaml
hard_constraints:
  - rm -rf /
  - git push --force
  - "DROP TABLE"          # your own rule
```

**2. Allow-list mode** (`enforcer.yaml`) — deny everything not listed:
```yaml
allow:
  - "ls*"
  - "echo*"
  - "cat*"
```

**3. Add a habit** (`.agent/habits/no-secret-leak.yaml`):
```yaml
name: no_credential_leak
enforcement: { level: hard }
behavior:
  kind: guard
  steps:
    - check: block_secret_leak
      patterns: ["sk-", "AKIA", "api_key="]
      require_assignment: true
```
The embedded secret-leak guard is **always on** even with no habit file. Your
habit *adds* to it; it does not replace it.

**Reload:** the daemon has a `reload` RPC (re-reads constitution/habits/policy,
recomputes the character hash) but it isn't yet wired to a CLI flag — restart
the daemon process to pick up changes (`systemctl restart
agent-enforcer.service` under systemd, or just let the supervisor notice the
process exit and restart it).

---

## Fail-closed guarantees
- Daemon down / socket missing → client **blocks** the call (never allows).
- No config files → embedded defaults apply (still enforces; not "open").
- **Agent cannot `kill` the daemon — root-mode only.** In the default
  **user-mode** install, the daemon is a separate *process* but the *same UID*
  as the agent. Any shell/exec tool the agent already has is enough to
  `kill -9` it — Linux lets same-user processes signal each other freely.
  "Separate process" is not a privilege boundary by itself. Only the
  **root/systemd install** (`sudo bash deploy/deploy-agent-enforcer.sh` +
  `deploy/deploy-ack-services.sh`) makes this guarantee real, because the
  agent's tool calls run as a non-root user that has no permission to signal
  a root-owned process. See "User-mode vs Root-mode" below before deciding
  which to run.

---

## Version tracking
Single source of truth: `node/src/version.js` (`VERSION`). `ack.js`, the
daemon (`agent_enforcer_daemon.js`, re-exported as `ACK_VERSION`), and
`node/src/index.js` all import from there — nowhere else in the Node side
should hardcode a version literal. Root `VERSION`, root `package.json`,
`node/package.json`, and the Hermes plugin's `python/hermes_plugin/__init__.py`
`ACK_VERSION` are separate files (npm/Python ecosystem conventions and a
plain version stamp) that still need bumping by hand alongside
`node/src/version.js` — **bump all five together** when cutting a release.

**Changelog:** `CHANGELOG.md` at repo root, started with the 1.2.0 release —
append-only, newest entry on top, never rewrite a past entry. History before
1.2.0 was not backfilled, per this section's own original guidance.

---

## Known gaps / future work

- **No CLI visibility or interactive control over what's actually
  blocked.** `ack doctor` / `ack config verify` only check whether
  `constitution.yaml` (`hard_constraints`) and `enforcer.yaml` (allow/deny)
  *exist* — nothing prints their contents, and there's no `ack constitution
  show/add/remove` or `ack policy show/allow/deny` to change them
  interactively. The only path today is hand-editing the YAML files
  directly (see "Customize" above). Habits (`ack habit list/create`) are the
  one part of this that IS interactive — hard blocks and allow/deny policy
  are not.
- **No CLI access to the audit trail.** Every allow/deny decision is
  genuinely logged (`enforcer-audit.jsonl` from the daemon,
  `tool-audit.jsonl` from the companion side), but there is no `ack log` /
  `ack audit` command to view, tail, search, or filter it — a user has to
  know the files exist and read the raw JSONL themselves. Not documented in
  any `--help` output.
- **`node/corpus/`'s knowledge-indexing (`DocumentIndexer`/`SemanticSearch`)
  has no CLI surface.** It used to (`aik index run`, `aik semantic index`,
  via the now-deleted `aik.js`); `ack.js` never got an equivalent. Currently
  library-only (`import { DocumentIndexer, SemanticSearch } from
  "agent-character-kit"`) — see `node/corpus/README.md`. Left this way
  deliberately per `HABIT_POLICY.md` §3 (knowledge/memory is a separate
  skill from character enforcement) rather than assuming it should be
  restored to a CLI; revisit if that assumption is wrong.
- **`ack repair` can see which specific agent is down (registry-aware as of
  2026-08-07) but doesn't yet selectively heal just that one** — its
  auto-activate logic still reasons about one workspace at a time, not "N
  registered agents, some subset unhealthy."
- **The full multi-agent chain has now been run against real systemd once
  (2026-08-07, root mode, one agent) — and it surfaced a real bug** (see the
  socket-permission gap above), now fixed but not yet re-verified live.
  Still not done: two different agents deployed against a real systemd
  instance in the same run (only ever proven against real spawned
  processes in the test suite for the 2-agent case). Needs a human with
  real sudo.

Resolved same day, no longer gaps: `ack config show/verify/write-env` all
gained a `--agent <name>` option (registry-aware, verified live against a
real fake registry before the tests were even written) — `ack config
set` deliberately left alone, it's a pure passthrough with no per-agent
resolution step to hook into. `deploy/ack_monitor.py` was ported to the
same multi-agent design as `ack_monitor.js` (Hermes-only companion path
is no longer left behind) — verified live with a real spawned daemon +
monitor against a real 2-agent registry, including a cross-contamination
check, same as the Node version's own proof.
`deploy-agent-enforcer.sh`/`deploy-ack-services.sh`'s duplication was
untangled for real (not just worked around): the enforcer script no
longer writes or enables the monitor/watchdog units at all, since it
never installed their binaries anyway — `deploy-ack-services.sh` is now
the sole owner of those two units. Service-user-mode (a dedicated non-root
`ack-enforcer` account, real write-protection without full root) is also
already built — see "User-mode vs Service-user-mode vs Root-mode" above —
this list previously had a stale bullet claiming it wasn't; removed
2026-08-07 after checking the actual code, not just the old bullet's word.
- **A real root-mode socket-permission bug was found and fixed 2026-08-07
  (8be35f6), but the FIX itself hasn't been re-verified against a live
  systemd deploy yet** — only the bug was (drdeek hit it live: a fresh
  root-mode install locked this very session out of its own tool calls for
  over an hour, because the socket came up `root:root` instead of
  `root:ack-clients`, two independent `install -d` calls on the same
  directory in `deploy-agent-enforcer.sh` silently fighting each other).
  The reordering + daemon-side `chownSync` fix is unit-tested (104/104) and
  code-reviewed, but needs a fresh `sudo bash deploy-agent-enforcer.sh` run
  and a real `ls -la` on the resulting socket to confirm the group is
  actually `ack-clients` before trusting it in production. See CHANGELOG
  1.5.0's second "Update, later the same day" entry for the full trace.
- **Socket.dev supply-chain scan not yet run against this repo.** `socket`
  CLI is installed but has never been authenticated in any environment this
  work happened in (`socket whoami` → 401 / `token: (not set)`) — every
  Socket command that matters (`scan create`, `package score`, etc.)
  requires `socket login` first, which needs an interactive
  browser/token flow no agent session can complete unattended. Run it once
  a human has logged in: `socket scan create --json`.

---

## File map

| Path | Role |
|------|------|
| `node/enforcer/agent_enforcer_daemon.js` | **CORE** — the enforcer (single source of truth) |
| `node/src/enforcer/client.js` | Node thin client |
| `node/bin/ack.js` | CLI (`hook/install/status/doctor/repair/config/habit`) |
| `python/hermes_plugin/` | **COMPANION** — example Python-plugin client (one of several) |
| `python/agent_character_kit/enforcer.py` | Python client (`EnforcerClient`) to the CORE |
| `supervise.py` | stdlib-only cross-platform supervisor |
| `deploy/` | Linux systemd unit + installer |
| `VERSION` | version stamp |

---

## Governing protocol
See `FOREVER-SYSTEM.md` (if present) for the protocol this kit implements:
§1 singular source of truth, §4 fail-closed, §5 modular, §6 continuously-reminded
character. One file. One enforcer. Clients are thin.
