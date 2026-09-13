# Claude adapter

Directory: `plugins/claude/`.

This is the ACK Claude Code plugin. The Anthropic generic example that
lived under `docs/example-plugin-claude/` was moved to `.trash/` after
this plugin shipped.

- `PreToolUse` → `hooks/pre-tool-use.js` → `ack hook claude` → daemon RPC
- `UserPromptSubmit` → `hooks/user-prompt-submit.js` → `ack hook claude` → `pick_prompt` RPC
- Skills: `character-enforcement` (hold/ack) and `configure-character` (habits, allow/deny, frequency)
- `.mcp.json` — optional HTTP MCP to `http://127.0.0.1:8754/mcp` (`ACK_MCP_HTTP`). Gate remains PreToolUse → `ack hook claude`.

The plugin holds no policy. Local `CharacterKitCore` is not on this path.

See [../protocol/plugin.md](../protocol/plugin.md).
