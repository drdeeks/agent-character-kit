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

OpenAI's current plugin guide is MCP-first (`skills/` + MCP server +
`README.md`; UI optional). ACK maps that onto **one daemon**, not a nested
`mcp-server/src` package:

- `plugin.json` — portable Agent Plugins manifest (stable name + 1.9.0)
- `mcp.json` — streamable HTTP to the ACK daemon (`ACK_MCP_HTTP`)
- `mcp-server/README.md` — pointer only; live server is `packages/daemon`
- `.mcp.json` — Codex fallback copy of that MCP pointer
- `.codex-plugin/plugin.json` — Codex fallback (author + interface metadata).
  Manifest **name** is `agent-character-kit` (kit identity). Directory
  `plugins/openai` is the OpenAI host package, not a rename target.
- `PRIVACY.md` / `TERMS.md` — local-only privacy and MIT terms pages
- `skills/character-enforcement/` — hold, ack, fail-closed
- `skills/configure-character/` — add/update/delete habits, allow/deny, frequency, workspace
- `hooks/` — Codex `PreToolUse` / `SessionStart` exec `ack hook` (daemon RPC, no local policy)
- `src/` — optional Chat Completions mapper for custom OpenAI-compatible HTTP hosts (still must not evaluate constitution)

MCP tools have title, description, input/output schemas, and safety
annotations. Reads (`list_habits`, `get_habit`, `get_character_config`,
`heartbeat`, `status`, `pick_prompt`) are separate from writes
(`write_habit`, `set_character_config`, `execute_tool`, `submit_ack`,
`reload`, `tool_tick`). `delete_habit` is the destructive write. Results
return `structuredContent` plus readable `content`. No secrets in results.
GET `/config` is optional localhost HTML; tools work without it.

## Local marketplace

Repo catalog: `.agents/plugins/marketplace.json` at the ACK repo root,
`source.path` `./plugins/openai`.

## Related

- [../../docs/adapters/openai.md](../../docs/adapters/openai.md)
- [../../docs/protocol/plugin.md](../../docs/protocol/plugin.md)
