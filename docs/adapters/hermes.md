# Hermes adapter

Two surfaces, one engine:

- Installed companion: `python/hermes_plugin/` (`pre_tool_call` /
  `pre_llm_call` over the daemon socket)
- Node mapping: `@drdeeks/character-kit-hermes` (`createHermesAdapter`)
  also calls `processToolCall` / `processPromptSubmit`. It is not what
  Hermes installs.

Do not add a Python policy evaluator. If the daemon is unreachable, block.

See [../protocol/plugin.md](../protocol/plugin.md).
