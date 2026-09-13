# Habits

Workspace files: `$AGENT_WORKSPACE/.agent/habits/<name>.yaml`

The bundled secret-leak guard is always on. A habit file adds to it; it
does not replace it.

## CLI

```
ack habit list
ack habit create <name> -p "<prompt>" -l "<logic>" -e "<evidence>" --level reminder
ack habit delete <name> --yes
ack manage
```

`ack configure --create-habit` requires `--habit-name`, `--habit-prompt`,
`--habit-logic`, `--habit-evidence`, and `--habit-level`.

Interactive `ack habit create` rejects empty answers and re-prompts.
Non-interactive flag callers exit if a required field is missing.

## Required YAML fields

Written by `buildHabitYaml` (`node/src/habits/build.js`):

- `name` — snake_case (hyphens collapse to underscores)
- `prompt` — self-question shown as injection text
- `enforcement.level` — `reminder` | `should` | `must` | `hard`
- `behavior.kind` — `assertion` for authored habits
- `behavior.assert` / `behavior.logic` — why it governs action
- `behavior.evidence` — how to verify this habit was applied

Guard-style habits (block a pattern) use `behavior.kind: guard` with
`steps[].check` such as `block_secret_leak`. Do not paste live credentials
into pattern lists.

## Update

Edit the YAML in place, then restart the daemon. `ack habit create` of an
existing name prints that the habit already exists and exits 1. It does
not overwrite. `--yes` belongs to `ack habit delete`, not create.

## Delete

`ack habit delete <name>` removes the file. Embedded defaults remain.
