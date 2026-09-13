# ACK OpenAI plugin

This directory is the Agent Character Kit package for ChatGPT and Codex.

It follows [Agent Plugins 1.0.0](https://agent-plugins.org/schemas/1.0.0/plugin.schema.json):
root `plugin.json`, discovered `skills/`, and OpenAI-specific hooks under
`extensions.com.openai`. `.codex-plugin/plugin.json` is the Codex
compatibility fallback.

This is **not** a ChatGPT App. OpenAI's
[build-chatgpt-app](https://github.com/openai/plugins/blob/main/plugins/openai-developers/skills/build-chatgpt-app/SKILL.md)
skill scaffolds an MCP server + widget (`_meta.ui.resourceUri`,
`window.openai`). ACK does not ship that widget. Optional MCP is
`mcp.json` (Codex fallback `.mcp.json`) pointing at the daemon's
streamable HTTP (`ACK_MCP_HTTP`, default `http://127.0.0.1:8754/mcp`).
Codex still uses this package's skills and hooks for the gate.

## Layout

- `plugin.json` — portable Agent Plugins manifest
- `mcp.json` — optional streamable HTTP to the ACK daemon (`ACK_MCP_HTTP`)
- `.mcp.json` — Codex fallback copy of that MCP pointer
- `.codex-plugin/plugin.json` — Codex fallback
- `skills/character-enforcement/` — hold, ack, fail-closed
- `skills/configure-character/` — add/update/delete habits, allow/deny, frequency, workspace
- `hooks/` — Codex `PreToolUse` / `SessionStart` exec `ack hook` (daemon RPC, no local policy)
- `src/` — optional Chat Completions mapper for custom OpenAI-compatible HTTP hosts (still must not evaluate constitution)

## Local marketplace

Repo catalog: `.agents/plugins/marketplace.json` at the ACK repo root,
`source.path` `./plugins/openai`.

## Related

- [../../docs/adapters/openai.md](../../docs/adapters/openai.md)
- [../../docs/protocol/plugin.md](../../docs/protocol/plugin.md)
