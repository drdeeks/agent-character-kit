# ACK Hermes Node mapper

Installed companion: `python/hermes_plugin/` (Hermes loads that tree).

This directory is the Node mapping (`createHermesAdapter`). It asks the
live daemon through `processToolCall` / `processPromptSubmit`. It is not
a second policy engine and it is not what Hermes installs by default.

See [../../docs/adapters/hermes.md](../../docs/adapters/hermes.md).
