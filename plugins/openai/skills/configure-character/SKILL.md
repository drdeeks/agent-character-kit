---
name: configure-character
description: Add, update, delete, or retune Agent Character Kit habits, hold frequency, required acknowledgments, allow/deny lists, hard constraints, and workspace files. Use when the user wants to customize ACK, not when a tool is merely held.
---

# Configure character

Overrides live under `$AGENT_WORKSPACE/.agent/`. Files merge on top of
embedded defaults. Empty files still enforce the bundled character.

Load the matching reference before changing anything:

- Habits (create, list, delete, YAML fields) → [references/habits.md](references/habits.md)
- Hard constraints and allow/deny → [references/policy.md](references/policy.md)
- Hold frequency, ack count, commit thresholds → [references/frequency.md](references/frequency.md)
- Workspace, env, reload, privilege modes → [references/workspace.md](references/workspace.md)

## Steps

1. Confirm `$AGENT_WORKSPACE` (default
   `$HOME/.agent-character-kit/workspace`).
2. Prefer `ack habit create|list|delete`, `ack constitution`, `ack policy`,
   and `ack manage` over hand-editing when those cover the change.
3. After YAML edits, `ack reload` (or MCP `reload` /
   `set_character_config`). Localhost menu: GET `/config` on `ACK_MCP_HTTP`.
4. Verify with `ack status` and a deny probe of `rm -rf /` via `ack hook`.
5. Do not evaluate policy in the plugin. Do not invent habit names.

## Do not

- Do not fold memory, knowledge index, or identity files into ACK.
- Do not treat user-mode as a privilege boundary.
- Do not weaken fail-closed to make a change "easier."
