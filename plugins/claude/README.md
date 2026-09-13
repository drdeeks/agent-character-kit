# ACK Claude Code plugin

This is the Agent Character Kit companion for Claude Code.

It is not Anthropic's generic example plugin. Layout follows Claude Code
plugin conventions (`.claude-plugin/plugin.json`, `hooks/`, `skills/`).
Policy stays in the live daemon. These hooks exec `ack hook claude`, not
`CharacterKitCore`.

## What it wires

- `PreToolUse` → `hooks/pre-tool-use.js` → `ack hook claude` → daemon
- `UserPromptSubmit` → `hooks/user-prompt-submit.js` → `ack hook claude` → daemon
- `skills/character-enforcement/` — hold, ack, fail-closed
- `skills/configure-character/` — habits, allow/deny, frequency, workspace
- `.mcp.json` — optional HTTP MCP to the ACK daemon (`ACK_MCP_HTTP`,
  `http://127.0.0.1:8754/mcp`). Gate still runs via `ack hook claude`.

## Honest limit

Fail-closed when enforcement cannot run. This is a deterrent and reminder,
not a cage. `ACK_DISABLE=1` still exists on the Python/Node companions.

## Related

- [../../docs/adapters/claude.md](../../docs/adapters/claude.md)
- [../../docs/protocol/plugin.md](../../docs/protocol/plugin.md)
- [../../AGENTS.md](../../AGENTS.md)
