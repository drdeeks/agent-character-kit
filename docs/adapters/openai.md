# OpenAI adapter

Directory: `plugins/openai/`.

OpenAI currently has **three** surfaces. ACK ships the first two.
The third is a different product.

1. **Agent Plugins 1.0.0** — portable `plugin.json` + discovered skills.
   ChatGPT/Codex install this as a plugin package.
2. **Codex hooks** — `hooks/hooks.json` (`PreToolUse`, `SessionStart`).
3. **ChatGPT Apps SDK** — MCP server + widget UI (`_meta.ui.resourceUri`,
   `window.openai`, CSP). Scaffolded by OpenAI's
   [build-chatgpt-app](https://github.com/openai/plugins/blob/main/plugins/openai-developers/skills/build-chatgpt-app/SKILL.md)
   skill. That is **not** Agent Plugin packaging. ACK does not ship an
   MCP app or widget until the daemon speaks streamable HTTP.

## What OpenAI actually ships for Agent Plugins

- Portable package: root `plugin.json` with
  `$schema` `https://agent-plugins.org/schemas/1.0.0/plugin.schema.json`.
  Required fields are `$schema` and `name`. Extra fields are forbidden at
  the root; host-specific data goes in `extensions.com.openai`.
- Skills: `skills/<name>/SKILL.md` with `name` + `description` frontmatter.
  Discovered from `skills/`; no `skills` field on the portable manifest.
- Optional MCP: root `mcp.json` with a transport `type` per server.
  Codex fallback uses `.mcp.json` and `.codex-plugin/plugin.json`.
- Optional Codex hooks: `hooks/hooks.json` (`PreToolUse`, `SessionStart`,
  and others). Commands read JSON on stdin.
- Local install: repo marketplace at
  `.agents/plugins/marketplace.json` (this repo) or a personal catalog
  under `$HOME/.agents/plugins/marketplace.json`.
- [Apps SDK examples](https://github.com/openai/openai-apps-sdk-examples)
  and the [build-chatgpt-app](https://github.com/openai/plugins/blob/main/plugins/openai-developers/skills/build-chatgpt-app/SKILL.md)
  skill are MCP + widget. Not this package.

## What this package contains

- `plugin.json` — portable Agent Plugins manifest
- `.codex-plugin/plugin.json` — Codex compatibility fallback
- `skills/character-enforcement/` — hold, ack, fail-closed
- `skills/configure-character/` — habits, allow/deny, frequency, workspace
- `hooks/` — Codex `PreToolUse` / `SessionStart` exec `ack hook` (daemon RPC)
- `src/` — Chat Completions mapper for custom OpenAI-compatible HTTP hosts
- No `mcp.json` yet — the ACK daemon is still a unix/tcp socket, not
  streamable HTTP

## Runtime mapper (`src/`)

Maps Chat Completions bodies onto the live daemon via `processToolCall`
and `processPromptSubmit` (same as the Codex hooks):

- No tool call → `pick_prompt` injection
- Tool call present → requires tool interception, else
  `CK_CAPABILITY_UNSUPPORTED`
- Then `execute_tool` + `tool_tick`; unreachable daemon fails closed
- Codex `SessionStart` reuses the Claude `hookSpecificOutput.additionalContext`
  shape with `hookEventName` set to `SessionStart`

See [../protocol/plugin.md](../protocol/plugin.md).
