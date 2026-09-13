---
name: character-enforcement
description: Apply ACK habits during Claude Code work when a tool is about to run, when a hold or deny is returned, or when the agent must re-ground in character. Not for adding or editing habits, allow-lists, or hold frequency — use configure-character for those.
---

# Character enforcement

The daemon is the only enforcer. This skill does not evaluate policy.

Load [references/acknowledge.md](references/acknowledge.md) before answering
a hold. To add, edit, delete, or retune habits, frequency, or allowed
commands, switch to the `configure-character` skill.

## When to use

- A shell, write, edit, or network tool is about to run.
- The host returned hold or deny from an ACK hook.
- The user asks the agent to follow character, not to change the kit.

## Steps

1. Do not invent habit names or daemon state. Read `.agent/habits/*.yaml`.
2. On hold, acknowledge the required number of habits (default 2) using
   the format in [references/acknowledge.md](references/acknowledge.md).
3. Search and read tools are never held. Use them to find habit names.
4. If the daemon is unreachable, fail closed. Recovery commands only:
   `ack doctor`, `ack repair`, `ack configure`, and starting the daemon.
5. ACK is a deterrent and reminder, not a security boundary.

## Do not

- Do not evaluate constitution or allow/deny lists here.
- Do not write habit YAML from this skill. That is `configure-character`.
