# ChatGPT hosted ACK

ChatGPT users connect a remote HTTPS MCP app. They do not run `install.sh`,
a local daemon, or `ACK_MCP_HTTP=8754`.

Implementation: `apps/chatgpt-ack-mcp/`. Contract: `GPT-INTEGRATION-SPEC.md`.

Local Codex / Claude / Hermes still use `plugins/openai` + the kit daemon.
That path is unchanged. No Apps SDK widget. No nested `mcp-server/src`.
Enforcement is `packages/core` `evaluatePolicy` in both paths.
