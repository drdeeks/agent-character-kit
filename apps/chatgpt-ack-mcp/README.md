# ACK ChatGPT hosted MCP

Remote HTTPS MCP for ChatGPT custom apps. Users do **not** run `install.sh`
or a localhost daemon. Codex and local harnesses still use the kit CLI.

Spec: [`../../GPT-INTEGRATION-SPEC.md`](../../GPT-INTEGRATION-SPEC.md)

## What this is

- Cloudflare Worker `fetch` handler at `POST /mcp`
- D1 schema in `migrations/0001_init.sql` (MemoryStore in tests)
- Identity from the authenticated connection, never from `user_id` args
- Enforcement via `packages/core` `evaluatePolicy` (same engine as local)
- Fail-closed storage/worker failures return `decision: unavailable`
- No `@modelcontextprotocol/sdk`, no Apps SDK widget, no nested `mcp-server/src`

## Local tests

From the kit root after `npm install`:

```bash
node --test apps/chatgpt-ack-mcp/src/*.test.js packages/config-schema/src/*.test.js
```

## Deploy (not done until secrets exist)

1. Create a D1 database; put its id in `wrangler.jsonc`.
2. `npx wrangler d1 migrations apply ack-chatgpt`
3. Set Worker secrets (`ACK_BOOTSTRAP_TOKEN` is not a user identity).
4. Deploy a stable HTTPS hostname.
5. Point the ChatGPT app at `https://<host>/mcp`.

Do not put access tokens in D1. Do not present `install.sh` as a ChatGPT
prerequisite.

Telemetry: `ack_ingest_event` / `POST /events` print canonical facts into
D1 (`enforcement_events`). `ack_list_events` lists the workspace. Hosted
ChatGPT defaults to D1; local services default to JSONL and may select
`ACK_EVENT_SINK=local|d1|both`. See `docs/chatgpt-hosted.md`.
