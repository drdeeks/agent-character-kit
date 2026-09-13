# Acknowledgment

Source: `docs/HABIT_POLICY.md` §4 and `AGENTS.md` hold pipeline.

## Format

```
Habit: <habit-name> <connector> <real work attribution>
```

Connectors the daemon accepts: `why:`, `because`, `matters because`,
`applies because`.

Attribution must include at least one of:

- a file or code reference (path, backtick-quoted name, or `.extension`)
- a past-tense action (wrote, fixed, changed, edited, added, removed,
  renamed, moved, committed, refactored, deleted, created, updated, broke,
  caught, found, touched, reverted)
- a stated future effect (`will affect`, `will prevent`, `this commit`,
  `this file`, `this session`, and similar)

Filler (`why: yes`) is rejected. A long reason with no real work is
rejected. Hyphen and underscore in habit names are treated as the same.

## Rolling window

You cannot reuse either of the two habits most recently acknowledged, and
you cannot reuse a prior ack's exact reason in the same session. Default
name history is 10 (`ACK_MAX_HABIT_NAME_HISTORY` /
`max_habit_name_history`).

The hold response does **not** list habit names. Discover them by reading
`.agent/habits/*.yaml` and matching the most recent injected **prompt**
(prompt text only; logic/evidence stay in the file).

## Hold vs injection

- Gate: every Nth non-search tool call is held (default N=5).
- Reminder: rotating habit prompts on SessionStart / UserPromptSubmit.
  That channel never blocks.

Search/read tools (`search_files`, `read_file`, `web_search`, `web_extract`,
`glob`, `grep`, `read`) do not count toward the hold.
