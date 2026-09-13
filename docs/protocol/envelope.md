# Protocol envelope

Two versions share one socket.

## v0

Newline-delimited JSON `{ method, params, token }`. Kept so the sibling
Watchtower adapter (`../../../watchtower-adapter`) and current `ack hook`
clients keep working.

Watchtower's frozen subset: `execute_tool`, `get_habit`, `submit_ack`,
`heartbeat`. Do not rename those. `pick_prompt` / `tool_tick` are hook
companions only.

## v1

```
protocol: character-kit
version: "1"
type: string
requestId: string
context: RuntimeContext
payload: object
```

Responses add `ok`, optional `payload`, optional `error`.

`parseIncoming` in `@drdeeks/character-kit-protocol` accepts both. Unknown
versions fail closed (`CK_VERSION_UNSUPPORTED`).

Schema: `packages/protocol/schemas/envelope.v1.json`.
