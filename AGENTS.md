# AGENTS.md — Agent Character Kit (ACK) v1.0.0

> **This is the single source of truth for AIK.** README.md is a short overview
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
   - generic `aik hook`                of truth)
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
  - Default → Unix socket under `AGENT_WORKSPACE/.agent/enforcer.sock`
    (falls back to `$HOME/.agent-character-kit/workspace/.agent/enforcer.sock`)
  - Windows / cross-host / explicit → `ENFORCER_SOCKET=tcp://127.0.0.1:8753`
  - `/run/agent-enforcer/main.sock` remains only as the deepest fallback for a
    root-owned systemd install that sets it explicitly.
  - Clients read the same `ENFORCER_SOCKET` / `AGENT_WORKSPACE`, so they follow
    automatically. The interactive `ack install` writes one `.env` that every
    component reads — no path is assumed.
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
2. **Generic `aik hook`** (`node/bin/aik.js hook --framework <name>`) — for
   Claude / Cursor / Gemini / OpenCode / generic. Emits the framework's
   hook JSON; each call hits the daemon.

> **No harness is definitive.** The CORE (daemon) is harness-agnostic. Pick
> the companion that matches YOUR agent's hook mechanism — Hermes is shown
> here only as one worked example among others.

> **One source of truth.** There is exactly one enforcement engine (the daemon).
> The Python library (`python/agent_character_kit/`) is a *client*; the Hermes
> plugin talks to the daemon, not to its own engine. Do not add a second engine.

---

## Install

Requires Node ≥ 18. (Python only needed if you use a Python-plugin
companion such as the Hermes example — other companions need only Node.)

```bash
git clone https://github.com/drdeeks/agent-character-kit.git
cd agent-character-kit && cd node && npm install && cd ..
```

### Linux — systemd (root-owned, self-respawning)
```bash
sudo bash deploy/deploy-agent-enforcer.sh
sudo systemctl enable --now agent-enforcer.service
# => binary + source root-owned at /usr/local/lib/agent-character-kit,
#    agent-enforcer.service dropped, enabled, started (User=root, RestartSec=3)
sudo systemctl status agent-enforcer.service   # Active: running
```

### macOS — launchd
```bash
# install node first; macOS has no /run, so use a writable socket path:
export ENFORCER_SOCKET=$HOME/Library/Caches/agent-enforcer/main.sock
node node/bin/aik.js enforcer --install      # emits a launchd plist (KeepAlive)
# or just run the supervisor directly:
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

AIK is harness-agnostic: the daemon enforces; the companion is just a thin
client. Below are TWO worked examples (Hermes and a generic `aik hook`
framework). Showing several, not one — pick the companion that matches your
agent. Do not treat any single harness as "the" install path.

**Example A — Hermes (Python-plugin companion):**
```bash
cd python && pip install -e . && cd ..
mkdir -p ~/.hermes/plugins/agent-character-kit
cp -r python/hermes_plugin/* ~/.hermes/plugins/agent-character-kit/
# restart Hermes; pre_tool_call is now gated by the CORE daemon
```

**Example B — Claude / Cursor / Gemini / OpenCode (generic `aik hook`):**
```bash
node node/bin/aik.js hook --framework claude --config   # prints the hook JSON
# add it to the framework's hooks; it calls the daemon per tool call
# swap `claude` for cursor | gemini | opencode | generic as needed
```

## Daemon-owned hold pipeline (acknowledgment gate)

The daemon enforces a periodic **acknowledgment HOLD** so the agent cannot run
forever on autopilot without re-grounding in its character. The hold is
**daemon-owned** — its state lives in the root-owned daemon, not the plugin, so
the agent cannot reset or bypass it by editing/disabling the plugin.

**Behavior:**
- Every 5th non-search tool call is **held** until the agent has acknowledged
  **2** habits in the form:
  `Habit: <habit-file-name> resonates true because <reason>`
- Search/read tools (`search_files`, `read_file`, `web_search`, `web_extract`,
  `glob`, `grep`) are **never held** — the agent can always look up a habit it
  can't recall.
- After 2 valid acknowledgments the hold lifts for the session.

**Three-layer architecture (why it's not bypassable):**
1. **Daemon** (`node/enforcer/agent_enforcer_daemon.js`) — owns the per-session
   tool-call counter + ack ledger via `tool_tick` / `submit_ack` RPCs. Decides
   allow/hold. Name normalization (hyphen ↔ underscore) lets the agent state
   `rigorous-commits-no-push` and match the file `name: rigorous_commits_no_push`.
2. **Plugin** (`python/hermes_plugin/`, thin client) — on each tool call asks the
   daemon `tool_tick` and obeys the hold; records any `Habit: … resonates true
   because …` the agent states into the **external ACK LOG**
   (`/tmp/agent-character-kit-ack.jsonl`). The plugin does **not** self-credit —
   it cannot forge acknowledgments.
3. **Monitor** (`deploy/ack_monitor.py`, root-owned systemd
   `agent-character-monitor.service`) — tails the ACK LOG, validates each
   statement against the daemon's real habit list, and credits the daemon via
   `submit_ack`. The agent cannot kill it without root.
4. **Watchdog** (`deploy/ack_watchdog.py`, root-owned systemd
   `agent-character-watchdog.service`) — revives the monitor if it dies
   (self-healing).

**Install the monitor + watchdog (after the daemon is deployed):**
```bash
sudo bash deploy/deploy-ack-services.sh
# => copies ack_monitor.py + ack_watchdog.py to /usr/local/lib/agent-character-kit,
#    installs + starts both systemd units (Restart=always).
```

> The hold is a **deterrent and constant reminder, NOT a security boundary** —
> same caveat as the rest of the kit. The agent can still obfuscate a command or
> use an un-gated tool; the hold raises the bar, it does not cage.

---

## Verify it's live

```bash
node node/bin/aik.js enforcer --status     # version + identity hash + enforcing

# direct, as the agent user:
echo '{"tool_name":"Bash","tool_input":{"command":"rm -rf /"},"hook_event_name":"PreToolUse"}' \
  | node node/bin/aik.js hook -f claude
# => permissionDecision: "deny"
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

**Live reload** (no restart): `node node/bin/aik.js enforcer --reload`
(or `systemctl restart agent-enforcer.service`).

---

## Fail-closed guarantees
- Daemon down / socket missing → client **blocks** the call (never allows).
- No config files → embedded defaults apply (still enforces; not "open").
- Agent cannot `kill` the daemon (separate, root/supervised process tree).

---

## Version tracking
`VERSION` at repo root = `1.0.0`. The daemon prints it on boot
(`AIK Enforcer daemon v1.0.0`) and returns it in `heartbeat.version`. The Hermes
plugin carries the same `AIK_VERSION`. **Bump `VERSION` and the in-code
constants together** when enforcement behavior changes.

---

## File map

| Path | Role |
|------|------|
| `node/enforcer/agent_enforcer_daemon.js` | **CORE** — the enforcer (single source of truth) |
| `node/src/enforcer/client.js` | Node thin client |
| `node/bin/aik.js` | CLI (`enforcer --start/--supervise/--status/--install/--reload`) |
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
