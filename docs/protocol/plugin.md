# CharacterKitPlugin

Host-neutral surface every provider plugin must call.

The daemon (and `CharacterKitCore` during the v2 split) is the only
enforcer. OpenAI, Claude, and Hermes adapters translate host events into
these methods and translate `ToolDecision` back. They do not read
`constitution.yaml`.

## Methods

- `initialize(context)`
- `beforeModel(input)` — non-blocking injection channel
- `beforeTool(input)` — allow, hold, or deny
- `submitAcknowledgment(input)`
- `shutdown()`

`RuntimeContext` on every call: `sessionId`, `runId`, `timestamp`, plus
optional `agentId`, `workspaceId`, `toolCallId`, `episodeId`, `taskId`.

## Related

- [envelope.md](envelope.md)
- [errors.md](errors.md)
- [../adapters/openai.md](../adapters/openai.md)
- [../adapters/claude.md](../adapters/claude.md)
- [../adapters/hermes.md](../adapters/hermes.md)
- [../adapters/watchtower.md](../adapters/watchtower.md)
- [../refactor-plan.md](../refactor-plan.md)
