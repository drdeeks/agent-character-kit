# Agent Identity Kit (AIK) — v1.0.0

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

**What it is.** A **character-enforcement layer** for AI agents. Every
tool call an agent makes is judged by a **separate, tamper-proof enforcer**
running *outside* the agent's process — so the agent cannot disable, patch, or
bypass its own guard. It **fails closed**: can't verify → block.

**Character ≠ identity.** This kit governs an agent's *character* — its inner
compass, its non-negotiable standards (a constitution + habits + policy). That
is NOT its *identity* (its self: soul.md, system prompt, agent.json). The
kit never touches who the agent is; it holds the agent to the bar it should
meet when no one is watching. (Repo name is a legacy label — read it as
"agent *character* kit.")

**Single source of truth: [`AGENTS.md`](AGENTS.md).** One file with purpose,
architecture, install (Linux/macOS/Windows), customize, verify, version.
README is only this overview. Another install/customize doc = stale; `AGENTS.md` wins.

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
node node/bin/aik.js enforcer --status           # version + identity hash
```

The daemon is now enforcing. Wire a COMPANION (any harness) per `AGENTS.md`.

Everything else — customization, macOS/Windows install, fail-closed guarantees,
version tracking, file map — is in **[`AGENTS.md`](AGENTS.md)**.
