# Agent Character Kit — Companion Plugin (Hermes)

A **real, registered** companion plugin that enforces agent *character* (your word,
not "identity") on every tool call, via any harness's `pre_tool_call` hook. This
replaces the old `hooks/identity.js` string-suggestion that was never actually wired in.

One of several companion clients — the kit itself is harness-agnostic (Hermes,
OpenCode, Claude, Cursor, Gemini all supported).

## What it does

Bridges any harness's `pre_tool_call` hook to the Agent Character Kit
enforcer. The enforcer runs the **same** policy the Node daemon enforces:

- `constitution.yaml` → `hard_constraints` (deny patterns)
- `enforcer.yaml` → `allow` / `deny` lists
- `habits/*.yaml` (level: hard) → internalized behavioral blocks

Every tool call is judged before it executes. Denied calls are blocked with a
reason + reflection ("this isn't a rule to work around — it's who we are").

## Fail-closed (never fails open)

- If the enforcer can't load → **block**.
- If no valid `constitution.yaml` is present → **block**. An agent without a
  loaded character is not trusted to act.

## Install

```bash
# 1. Make the AIK Python package importable
cd agent-character-kit/python
pip install -e .

# 2. Drop this plugin into Hermes's plugin dir
mkdir -p ~/.hermes/plugins/agent-character-kit
cp -r hermes_plugin/* ~/.hermes/plugins/agent-character-kit/

# 3. Define the agent's character (singular source of truth)
#    ~/.openclaw/workspace/.agent/constitution.yaml  (or $AGENT_WORKSPACE/.agent/)
```

Hermes loads `plugin.yaml` + `__init__.py` at startup and registers the hook.
No core files touched — this is a layer, not a fork.

## Verify

```bash
python3 hermes_plugin/test_plugin.py
# => blocks rm -rf / api_key, allows ls
# => fails CLOSED when constitution unloadable
# ALL PASS
```

## Path-agnostic

The enforcer resolves its config from env → home → default, so this works on
the USB free-state, the host, or inside the container reading persistent data —
same code, no changes. That's the forever-system property: layerable,
adaptable, singular-source.

See `FOREVER-SYSTEM.md` §1 (singular source), §4 (fail-closed), §5 (modular),
§6 (continuously-reminded character) for the governing protocol.
