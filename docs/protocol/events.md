# Enforcement events

ACK emits facts. It does not compute rewards.

Package: `@drdeeks/character-kit-events`.

Minimum types: `session.started`, `session.ended`, `habit.injected`,
`tool.requested`, `tool.allowed`, `tool.held`, `tool.denied`,
`tool.completed`, `acknowledgment.*`, `policy.*`, `enforcer.*`,
`protocol.error`.

Each record has `eventId`, `sessionId`, `runId`, `sequence`,
`schemaVersion`. Optional `episodeId` / `taskId` come from the host.

Default sink: date-partitioned JSONL. Payloads redact `command`,
`content`, `prompt`, `token`, and `statement`. Sink failure must not
allow a tool and must not crash the gate.

Doctrine: `../RL_INTEGRATION.md`.
