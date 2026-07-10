# AGENTS.md — Agent Identity Kit (AIK) v1.0.0

> **This is the single source of truth for AIK.** README.md is a short overview
> that points here. There is no other install/customize doc — if you're reading
> one, it's stale. Everything (purpose, architecture, install, customize,
> validate, version) lives in this file.

---

## Purpose

Make sure **every tool call an AI agent makes** is judged by a **separate,
tamper-proof enforcer** running *outside* the agent's own process — so the agent
cannot disable, patch, or bypass its own guard. The enforcer validates each
action against an identity (constitution + habits + policy) and **fails closed**:
if it can't verify, it blocks.

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
- **Transport auto-selects:**
  - POSIX default → Unix socket `/run/agent-enforcer/main.sock`
  - Windows / cross-host → `ENFORCER_SOCKET=tcp://127.0.0.1:8753`
  - Clients read the same `ENFORCER_SOCKET`, so they follow automatically.
- **Out-of-process = tamper-proof.** The agent cannot `kill` or modify it. If the
  daemon dies, the supervisor (systemd / launchd / `supervise.py` / Windows
  Service) brings it back in seconds.

### COMPANION — thin clients (hold NO policy)
These are dumb pipes to the CORE. They do not enforce anything; they ask the
daemon and obey. If the daemon is unreachable, the client **blocks** (fail-closed).

1. **Hermes plugin** (recommended for Hermes) — `python/hermes_plugin/`
   Python, because Hermes loads Python plugins. It is the *singular* companion
   for systems like Hermes: `pre_tool_call` → daemon → allow/deny.
2. **Generic `aik hook`** — `node/bin/aik.js hook --framework <name>`
   For Claude / Cursor / Gemini / OpenCode / generic. Emits the framework's
   hook JSON; each call hits the daemon.

> **One source of truth.** There is exactly one enforcement engine (the daemon).
> The Python library (`python/agent_identity_kit/`) is a *client*; the Hermes
> plugin talks to the daemon, not to its own engine. Do not add a second engine.

---

## Install

Requires Node ≥ 18. (Python only for the Hermes plugin.)

```bash
git clone https://github.com/drdeeks/agent-identity-kit.git
cd agent-identity-kit && cd node && npm install && cd ..
```

### Linux — systemd (root-owned, self-respawning)
```bash
sudo bash deploy/deploy-agent-enforcer.sh
sudo systemctl enable --now agent-enforcer.service
# => binary + source root-owned at /usr/local/lib/agent-identity-kit,
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
nssm install AgentEnforcer "python.exe" "C:\path\agent-identity-kit\supervise.py"
nssm start AgentEnforcer
```

### Any host — stdlib supervisor (no deps)
```bash
sudo python3 supervise.py          # restarts daemon on death (3s backoff)
# equivalent cross-platform logic to systemd RestartSec
```

### Wire the COMPANION into your agent

**Hermes (singular plugin):**
```bash
cd python && pip install -e . && cd ..
mkdir -p ~/.hermes/plugins/agent-identity-kit
cp -r python/hermes_plugin/* ~/.hermes/plugins/agent-identity-kit/
# restart Hermes; pre_tool_call is now gated by the CORE daemon
```

**Generic `aik hook` (Claude/Cursor/Gemini/OpenCode):**
```bash
node node/bin/aik.js hook --framework claude --config   # prints the hook JSON
# add it to the framework's hooks; it calls the daemon per tool call
```

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
`~/.agent-identity-kit/workspace`):

```
<AGENT_WORKSPACE>/
  .agent/
    constitution.yaml      # who the agent IS (values + hard_constraints)
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
| `python/hermes_plugin/` | **COMPANION** — Hermes plugin (thin client, singular for Hermes) |
| `python/agent_identity_kit/enforcer.py` | Python client (`EnforcerClient`) to the CORE |
| `supervise.py` | stdlib-only cross-platform supervisor |
| `deploy/` | Linux systemd unit + installer |
| `VERSION` | version stamp |

---

## Governing protocol
See `FOREVER-SYSTEM.md` (if present) for the protocol this kit implements:
§1 singular source of truth, §4 fail-closed, §5 modular, §6 continuously-reminded
character. One file. One enforcer. Clients are thin.
