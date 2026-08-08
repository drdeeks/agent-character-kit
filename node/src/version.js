// Single source of truth for the kit's version. Kept in sync with /VERSION
// at repo root (bump both together — see AGENTS.md "Version tracking").
//
// Deliberately its own module, not folded into src/index.js: the daemon
// (agent_enforcer_daemon.js) needs this constant but must NOT pull in
// index.js's knowledge/memory re-exports (HABIT_POLICY.md §3 — the
// character kit is ONLY the habit system; memory/knowledge is a separate,
// heavier skill the daemon has no business depending on just to know its
// own version number).
export const VERSION = "1.5.0";
