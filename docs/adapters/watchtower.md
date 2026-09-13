# Watchtower adapter

Sibling package (same `plugins/` directory as this kit, not nested in
ACK): `../../../watchtower-adapter`.

It is a **v0 NDJSON socket client** — a normalizer/bridge only. It does
not import ACK plugins, does not eval constitution, and does not call
`ack hook`. Policy stays in the daemon. A harness-specific Watchtower
plugin is later work, not this kit's v2 cutover.

## RPCs it uses (frozen v0)

| Adapter method | Daemon RPC | Notes |
|---|---|---|
| `gateAction` | `execute_tool` | Fail-closed. Shape `{ denied, reason, reflection, ... }` |
| `injectHabit` | `get_habit` | Verifies a named habit exists. **Not** `pick_prompt` |
| `submitAcknowledgement` | `submit_ack` | Session currently `"default"` |
| `sendHeartbeat` | `heartbeat` | Plus Watchtower-side heartbeat |

It does **not** call `pick_prompt` or `tool_tick`. Prompt-only injection
and the hold loop are companion-hook concerns. Do not rename or reshape
those four v0 methods without updating the Watchtower client in lockstep.

Auth: every method except `status` sends `token` when `ACK_AUTH_TOKEN`
is set. Transport: Unix path or `tcp://host:port` (`CHARACTER_KIT_SOCKET`).

See the adapter's own `AGENTS.md` and `src/bridge/character-kit.ts`.
