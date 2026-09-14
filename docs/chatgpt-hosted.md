# ChatGPT hosted ACK

ChatGPT users connect a remote HTTPS MCP app. They do not run `install.sh`,
a local daemon, or `ACK_MCP_HTTP=8754`.

Implementation: `apps/chatgpt-ack-mcp/`. Contract: `GPT-INTEGRATION-SPEC.md`.

Local Codex / Claude / Hermes still use `plugins/openai` + the kit daemon.
That path is unchanged. No Apps SDK widget. No nested `mcp-server/src`.
Enforcement is `packages/core` `evaluatePolicy` in both paths.

## Telemetry / elementary RL → D1

Canonical facts (not rewards) land in `enforcement_events`
(`migrations/0002_rl_events.sql`). Hosted `ack_check_action` /
`ack_acknowledge_hold` print automatically. Local ACK, Forever Gate, or
other components can:

1. MCP `ack_ingest_event` (ChatGPT tools)
2. `POST /events` JSON `{ events: [...] }` (daemon/batch)
3. `ack_list_events` to gather **everyone in the same workspace**

`user_id` in the payload is ignored. Commands/tokens are redacted.

### Other methods (not implemented here)

- **Cloudflare Queues** — buffer bursts, then a consumer writes D1
- **R2 JSONL** — cheaper for high-volume raw logs; D1 stays the query index
- **Analytics Engine** — aggregates only, not full events
- **Durable Object stream** — per-session ordered log, flush to D1
- **Local JSONL** (`packages/events` `JsonlSink`) — still the Codex path;
  export later with `POST /events`

Do not compute RL rewards in the Worker. Dataset builders read D1 facts.
