# MIGRATION — this repo is archived

**`drdeeks/agent-identity-kit` is archived (read-only). The active
project lives at [`drdeeks/agent-character-kit`](https://github.com/drdeeks/agent-character-kit).**

Use that link for clones, issues, and contributions. This repo is kept
only so old links don't 404.

---

## Why the rename

The old name was wrong about what this kit does.

- **Character**, not **identity**. This kit enforces an agent's *character* —
  its inner compass, its non-negotiable standards (a constitution +
  habits + policy). That is NOT its *identity* (its self: `soul.md`,
  system prompt, `agent.json`). The kit never manages or touches identity.
- The repo was named `agent-identity-kit` before that distinction was
  made. The code is correct; only the label was wrong. The new repo
  carries the right name and the same enforcement engine.

## What moved

Everything. `agent-character-kit` is the full project — daemon,
habits, companions (Hermes plugin + generic `aik hook`), deploy
scripts, tests. No code was lost; only the name and the
character-vs-identity framing changed.

## Quick re-point (if you cloned the old name)

```bash
# old (archived, do not use):
git clone https://github.com/drdeeks/agent-identity-kit.git   # read-only

# new (active):
git clone https://github.com/drdeeks/agent-character-kit.git
cd agent-character-kit && cd node && npm install && cd ..
```

---

*Archived to preserve history. Active development is at
`drdeeks/agent-character-kit`.*
