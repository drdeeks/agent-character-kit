# Privacy

Agent Character Kit runs on the local machine. This plugin talks to the
ACK daemon on loopback (`ACK_MCP_HTTP`, default `http://127.0.0.1:8754/mcp`)
and to Codex/ChatGPT hooks on stdin. It does not send habit YAML, tool
commands, or acknowledgments to Socket.dev, npm, or a vendor cloud.

Event and audit JSONL stay on disk:

- `$AGENT_WORKSPACE/.agent/logs/events/YYYY-MM-DD.jsonl`
- `$AGENT_WORKSPACE/.agent/logs/enforcer-audit.jsonl`
- `$HOME/var/log/agent-enforcer/tool-audit.jsonl`

Auth is a local `ACK_AUTH_TOKEN` bearer, not OAuth. Do not put secrets in
MCP results. The plugin is a deterrent, not a security boundary.

The ChatGPT **hosted** app is a different path (`apps/chatgpt-ack-mcp`,
`docs/PRIVACY.md`): Cloudflare D1, not this loopback daemon.
