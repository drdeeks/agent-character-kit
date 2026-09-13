# MCP server (pointer)

This folder exists so the OpenAI plugin layout matches the current
plugin guide (`skills/` + MCP server + `README.md`).

**Do not put a second MCP server here.** The live server is the ACK
daemon:

- source: `packages/daemon/src/mcp-http.js`
- start: `ACK_MCP_HTTP=8754` (or `tcp://127.0.0.1:8754`)
- endpoint: `POST http://127.0.0.1:8754/mcp` (streamable HTTP JSON-RPC)
- pointer: `../mcp.json`

Policy stays in the daemon. This plugin does not evaluate constitution,
habits, or allow/deny. No Apps SDK widgets. Optional localhost HTML
menu is `GET /config` on the same daemon — MCP tools work without it.

Auth is `Authorization: Bearer` mapped to `ACK_AUTH_TOKEN`, not OAuth
2.1. This is a loopback daemon, not a user-cloud resource. Internet
production would use HTTPS; `127.0.0.1` is HTTP by design.

Watchtower stays on unix/tcp NDJSON (`execute_tool`, `get_habit`,
`submit_ack`, `heartbeat`) and does not use this HTTP surface.
