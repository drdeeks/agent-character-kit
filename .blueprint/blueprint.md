# ACK Enforcement Repair — ENTERPRISE BLUEPRINT
## Version: 3.0 | Document Class: MASTER SPECIFICATION
## Scope: PROJECT
### Generated: 2026-08-07 | Regenerated from v2.0: 2026-08-07 (CL-0003)

> **READ FIRST — DOCUMENT AUTHORITY**
> This document is the single source of truth for repairing
> @drdeeks/character-kit's install/enforce/uninstall lifecycle end-to-end —
> but it is itself SUBORDINATE to `/home/drdeek/projects/FOREVER-SYSTEM/FOREVER-SYSTEM.md`,
> which outranks every README, SKILL.md, and blueprint in any repo (its own
> §0/preamble). Where anything below conflicts with FOREVER-SYSTEM.md, that
> file wins. Specifically binding on this blueprint: §1 (Singular Source of
> Truth — the finished capability lives as exactly one real implementation
> inside ACK's own runtime; useful mechanics from `loop-enforcer` or
> `guardrail-enforcement` — both named by FOREVER-SYSTEM.md as duplicate-
> truth violations — may be taken and folded in completely and accurately
> for whatever piece is actually used, never left as a live dependency on,
> or a parallel copy running alongside, those separate skills), §2
> (Self-Resolving Paths), §5 (Platform/Path Agnostic — hardcoding a
> harness-specific requirement is fine ONLY when explicitly attributed to
> that harness by name; presenting one harness's need as universal is not),
> §4 (Fail-closed, tamper-EVIDENT not tamper-PROOF; audit failures must be
> surfaced, never swallowed by a bare `catch {}`), and §9 (known defects,
> reverified against current code in CL-0003 below rather than assumed
> stale-but-true).
> No file listed in Part II may be changed without a corresponding
> checklist item in Part VI, and no checklist item may be marked complete
> without the change log entry Part V requires. This document's change log
> is APPEND-ONLY. Prior sections may only be updated via a formal amendment
> with a corresponding CL entry — never a silent rewrite.

---

## TABLE OF CONTENTS

```
PART I    — SYSTEM OVERVIEW & ARCHITECTURE
PART II   — MODULE REGISTRY
PART III  — SCREEN & FEATURE SPECIFICATIONS
PART IV   — DATA ARCHITECTURE
PART V    — CHANGE CONTROL PROTOCOL
PART VI   — MASTER IMPLEMENTATION CHECKLIST
PART VII  — QUALITY & COMPLIANCE STANDARDS
```

---

---

# PART I — SYSTEM OVERVIEW & ARCHITECTURE

> **Rollback Tag:** `[SYS-OVERVIEW-v2]`

## 1.1 Vision Statement

ACK is harness-agnostic by design: the daemon (`agent_enforcer_daemon.js`)
is the one enforcement engine; `generateConfig()` already speaks five
harness dialects (Claude, Cursor, Gemini, Hermes, OpenCode); no single
harness is "the" install path. This blueprint does not change that. What it
does is repair and finish the parts of the lifecycle (install, runtime
enforcement, uninstall, and habit authoring) that a full night of live,
line-by-line investigation — not assumption, not a prior blueprint's own
claims re-cited as fact — found to be either half-built, silently reversed
by a later commit, described inaccurately in this document's own prior
version, or genuinely never built. Every module below is scoped honestly to
what's Claude-specific (only Claude has an auto-write-to-settings function
at all) versus what's daemon-side and already shared, for free, by every
harness `generateConfig()` supports. Where a fix is genuinely Claude-only,
it's labeled that way. Where a gap is daemon-side, fixing it benefits every
harness without additional per-harness work.

Every person who runs `npm install -g @drdeeks/character-kit` gets asked
what it needs to know instead of being silently guessed for; every
background process the install stands up is confirmed alive, not
spawned-and-trusted; the daemon's login/auth gate actually gates something
for whichever harness(es) are configured; the full hold-then-acknowledge
loop is a real, demonstrable mechanism instead of a dead end an agent can
hit with no way out; a real habit can be authored through a single command
that actually asks for everything a habit needs, not a thin wrapper that
silently pads three of five required fields with boilerplate; and `npm
uninstall -g` leaves the machine exactly as it found it.

This is the **third pass** at this document, and the reason for a v3 is
itself part of the record, not swept under a silent rewrite: v1.0 fixed
`postinstall.js`'s visible output without checking the mechanisms
underneath it. v2.0 escalated to PROJECT tier and added the missing
1.4/1.5 subsections and real architecture diagram, but its own MOD-008
("chat-transcript monitor... currently zero real callers of `submit_ack`")
was written from an incomplete read of the codebase — a second, deeper
investigation tonight, prompted directly by the person who owns this repo
asking pointed questions about the acknowledgment mechanism's actual
robustness, found that claim to be **false**: `deploy/ack_monitor.js` /
`.py` are real, committed, 130+-line implementations that already call
`submit_ack`, and — the discovery that actually reframes MOD-008 —
`python/hermes_plugin/__init__.py` already implements the **entire**
detect→log→credit loop end-to-end for the Hermes companion specifically
(`_detect_ack()` regex-matches a real `Habit: <name> resonates true because
<reason>` statement out of the agent's own message text on every
`pre_llm_call`, appends it to the external ack log, and the root-owned
monitor — never the agent's own process — is the only thing that credits
the daemon). That loop is not hypothetical; it is running code, verified by
direct read, not inferred from a docstring. What genuinely does not exist
is a Claude-specific equivalent of `_detect_ack()`, because Claude Code's
hook surface (`PreToolUse` / `UserPromptSubmit`) is shaped differently than
Hermes's `pre_llm_call`. MOD-008 is corrected below to reflect that: **port
a working, already-proven pattern to a second harness**, not invent a
mechanism from nothing.

A second, independent gap surfaced during the same investigation, unrelated
to MOD-008: `ack habit create <name>` (the interactive habit-authoring
command in `node/bin/ack.js`) only ever asks for `name`, `prompt`, and
`logic`. It hardcodes `evidence` to one generic boilerplate sentence,
hardcodes `enforcement.level` to `"reminder"` always, and hardcodes
`behavior.kind` to `"standard"` always — regardless of what the habit
actually needs. A direct audit of all 40 bundled example habits found this
is not a hypothetical risk: it is the demonstrated root cause of a real,
present split in the bundled habit set — the ~19 habits with
`kind: "standard"` and generic evidence text were produced by this thin
command; the ~19 with `kind: "assertion"` and specific, non-generic
evidence were authored some other way. This is now MOD-009.

## 1.2 High-Level Architecture

```
┌────────────────────────────────────────────────────────────────────────────┐
│  INSTALL ENTRY LAYER                                                        │
│                                                                              │
│  npm install -g @drdeeks/character-kit                                      │
│         │                                                                   │
│         ▼                                                                   │
│  ┌─────────────────────────┐        ┌──────────────────────────────────┐  │
│  │ node/bin/postinstall.js │        │ Scoping guards (unchanged):       │  │
│  │ (npm lifecycle hook —   │───────▶│  npm_config_global === "true"     │  │
│  │  NO real TTY, proven    │        │  AND __dirname under node_modules │  │
│  │  by instrumentation)    │        │  else: silent no-op (local dev)   │  │
│  └────────────┬─────────────┘        └──────────────────────────────────┘  │
│               │                                                             │
│       ┌───────┴────────┐                                                   │
│       ▼                ▼                                                   │
│  no ACK_YES/-y     ACK_YES=1 / -y                                          │
│  (NEW DEFAULT)     (bypass = today's behavior)                             │
│       │                │                                                   │
│       ▼                ▼                                                   │
│  print what a     detectHarnesses()                                        │
│  real `ack         (Claude: ~/.claude/settings.json                        │
│  install` run       Hermes: ~/.hermes/                                     │
│  would ask          OpenCode: ~/.config/opencode/)                         │
│  (agent count,          │                                                  │
│  harness(es),           ▼                                                  │
│  location) and    install.js main({harnesses, yes:true, ...})              │
│  STOP — points          │                                                  │
│  at `ack install`  ┌────┴─────────────────────────────────────┐           │
│  for the real      │                                            │           │
│  session (a real   ▼                                            ▼           │
│  TTY, since it's  workspace scaffold              per-workspace .env        │
│  a normal CLI      (.agent/habits/, seedHabits,   (AGENT_WORKSPACE,         │
│  invocation, not    writeConstitution)             ENFORCER_SOCKET,         │
│  a lifecycle hook)       │                          ACK_ACK_LOG,            │
│                          │                          ACK_AUTH_TOKEN [NEW:    │
│                          │                          also flows to spawn     │
│                          │                          env below, MOD-006])    │
│                          ▼                                 │               │
│              ┌───────────────────────┐                     │               │
│              │  SPAWN LAYER          │◀────────────────────┘               │
│              │  (all three below get │                                      │
│              │  ACK_AUTH_TOKEN in    │                                      │
│              │  spawn env — MOD-006) │                                      │
│              └───────────┬───────────┘                                     │
│         ┌─────────────────┼─────────────────┐                              │
│         ▼                 ▼                 ▼                              │
│  ┌─────────────┐  ┌──────────────┐  ┌───────────────┐                      │
│  │ enforcer     │  │ ack_monitor  │  │ ack_watchdog  │                      │
│  │ daemon.js    │  │ .js/.py      │  │ .js/.py       │                      │
│  │ (Unix socket,│  │ (VERIFIED    │  │ (VERIFIED     │                      │
│  │  RPC server) │  │  real, tails │  │  real, revives│                      │
│  │              │  │  ACK_ACK_LOG,│  │  monitor if   │                      │
│  │              │  │  credits     │  │  it dies —    │                      │
│  │              │  │  submit_ack; │  │  130+/96+     │                      │
│  │              │  │  the ONLY    │  │  lines each,  │                      │
│  │              │  │  thing that  │  │  not stubs)   │                      │
│  │              │  │  may credit) │  │               │                      │
│  └──────┬───────┘  └───────┬──────┘  └───────────────┘                      │
│         │                  │                                               │
│         ▼                  ▼                                               │
│  ┌─────────────────────────────────────────────┐                           │
│  │ LIVENESS VERIFICATION (NEW — MOD-007)        │                           │
│  │  poll `status` RPC + confirm PIDs still alive│                           │
│  │  after a short delay BEFORE reporting success│                           │
│  └─────────────────────┬─────────────────────────┘                         │
│                        ▼                                                    │
│         visible terminal summary (MOD-001) + writeClaudeHookConfig()        │
│         writes BOTH PreToolUse + UserPromptSubmit into                      │
│         ~/.claude/settings.json (MOD-003)                                   │
└──────────────────────────────────────────────────────────────────────────┘

┌────────────────────────────────────────────────────────────────────────────┐
│  RUNTIME ENFORCEMENT LAYER — daemon-side logic is shared by every harness   │
│  generateConfig() supports. Two companions are shown side by side: Claude   │
│  (this blueprint's active repair target) and Hermes (the CONFIRMED-WORKING  │
│  reference implementation MOD-008 ports from — not a hypothetical, running  │
│  code read directly from python/hermes_plugin/__init__.py).                │
│                                                                              │
│  ══════════════════ CLAUDE COMPANION (repair target) ══════════════════    │
│                                                                              │
│  PreToolUse hook fires ──▶ ack.js hook claude ──▶ processToolCall()        │
│         │                                              │                    │
│         ▼                                              ▼                    │
│  enforcer.validateTool()                    enforcer.toolTick()             │
│  (constitution/policy check)                (daemon-owned hold state)       │
│         │                                              │                    │
│         ▼                                    ┌─────────┴─────────┐          │
│    allow / deny                              ▼                   ▼          │
│                                     not yet Nth call      count % N == 0    │
│                                     (allow, count++)          (HOLD)         │
│                                     search/read tools               │       │
│                                     EXEMPT from hold                ▼       │
│                                     (VERIFIED:                                │
│                                     this.searchTools.has(tool)       "state two habit
│                                     → {hold:false} unconditionally,  names, and how
│                                     agent_enforcer_daemon.js:644)    they apply to the
│                                                                       work you've been
│                                                                       doing." (simplified
│                                                                       live tonight — a
│                                                                       longer draft was
│                                                                       explicitly rejected
│                                                                       as over-informative)
│                                                                             │
│  UserPromptSubmit hook fires ──▶ ack.js hook claude ──▶ processPromptSubmit│
│         │                                                                  │
│         ▼                                                                  │
│  pickHabitPrompts() ──▶ daemon pickPrompt RPC ──▶ rotating 2-3 habit       │
│  prompts + logic/evidence, NEVER the habit name, PLUS a vague locational  │
│  nudge (MOD-002) — enough to start a search, not enough to skip it        │
│                                                                             │
│  Agent (having read the real habit file it found) states, IN ITS OWN      │
│  VISIBLE CHAT OUTPUT: "Habit: <real-name> resonates true — <reason>"      │
│         │                                                                  │
│         ▼                                                                  │
│  ██ GAP (MOD-008, corrected scope) ██ — nothing currently reads Claude's   │
│  own transcript to detect that statement. This is the ONE missing piece   │
│  of an otherwise-proven loop, not a whole new mechanism: port             │
│  `_detect_ack()`'s exact regex and "append to external log, never        │
│  self-credit" design from the Hermes plugin (below), reading              │
│  `transcript_path` from the Claude hook payload instead of Hermes's       │
│  `user_message` param. Same log format `ack_monitor.js` already tails —   │
│  this reuses the monitor, it does not need a new one.                     │
│         │                                                                  │
│         ▼ (once built)                                                    │
│  daemon submitAck() validates (real habit name, min reason length, no     │
│  reuse of either of the last 2 habits/reasons) ──▶ credits hold ledger    │
│  ──▶ next toolTick() call sees the hold satisfied ──▶ agent proceeds      │
│                                                                              │
│  ══════════ HERMES COMPANION (VERIFIED WORKING REFERENCE) ══════════       │
│                                                                              │
│  pre_tool_call fires ──▶ _on_pre_tool_call() ──▶ _daemon_rpc("tool_tick")  │
│         │                                                                  │
│         ▼                                                                  │
│  hold:true ──▶ {"action":"block", message: "State TWO habits... Once 2    │
│  are acknowledged, tool access resumes."} ──▶ Hermes HARD-BLOCKS the       │
│  next tool call (VERIFIED: python/hermes_plugin/__init__.py:112-130,       │
│  not a soft warning — the harness itself refuses to proceed)              │
│         │                                                                  │
│  pre_llm_call fires EVERY TURN ──▶ _on_pre_llm_call(user_message=...)     │
│         │                                                                  │
│         ▼                                                                  │
│  _detect_ack(session_id, user_message) — regex: `habit:\s*\S+\s+          │
│  resonates\s+true\s+because\s+.+` against the agent's own message text.   │
│  Match found ──▶ append {session_id, statement} to ACK_ACK_LOG (JSONL).   │
│  Plugin does NOT credit the daemon itself — "that would let the agent's   │
│  own process forge acknowledgments" (verified, __init__.py:216-218)       │
│         │                                                                  │
│         ▼                                                                  │
│  ack_monitor.py (root-owned, separate process, unkillable by the agent)   │
│  tails ACK_ACK_LOG, validates each statement against the daemon's real    │
│  rules, calls submit_ack over RPC ──▶ credits the hold ledger             │
│         │                                                                  │
│         ▼                                                                  │
│  ack_watchdog.py revives ack_monitor.py if it dies (VERIFIED, real file,  │
│  96+ lines) ──▶ hold lifts, agent proceeds. FULL LOOP, END TO END,        │
│  CONFIRMED WORKING FOR HERMES TONIGHT.                                    │
│                                                                              │
│  ═══════ DELIBERATELY-DEFERRED HEAVIER DESIGN (NOT built, NOT this   ═══   │
│  ═══════ blueprint's scope — see docs/agent-character-injection-     ═══   │
│  ═══════ design.md at commit 0992bcc for full rationale)             ═══   │
│  A loop-enforcer chain (strict sequential ack ordering), a root-owned      │
│  setuid append-only log with a kill-switch on tampering, a second          │
│  acknowledgment-count monitor with ≥30s gridlock detection, and a hosted   │
│  habit DB keyed to ERC-8004 on-chain identity were all designed and then   │
│  explicitly rejected once the lightweight daemon-response-injection        │
│  pattern above solved the actual problem (proving the agent received the   │
│  habit prompts as real input, not just that something was sent). The       │
│  design doc frames these as "a worst-case fallback concept if the          │
│  lightweight injection ever proves insufficient" — noted here for          │
│  continuity, explicitly OUT OF SCOPE for this blueprint unless a future    │
│  CL entry says otherwise.                                                  │
└──────────────────────────────────────────────────────────────────────────┘

┌────────────────────────────────────────────────────────────────────────────┐
│  HABIT AUTHORING LAYER (NEW — MOD-009)                                     │
│                                                                              │
│  ack habit create <name> [-p prompt] [-l logic]                            │
│         │                                                                  │
│         ▼                                                                  │
│  CURRENT (verified, node/bin/ack.js, the `habitCmd.command("create")`     │
│  handler): asks for name (arg), prompt (flag or interactive `ask()`),     │
│  logic (flag or interactive `ask()`) — THREE fields.                      │
│  Then HARDCODES, always, regardless of the habit's actual content:        │
│    evidence: "The agent applies this habit consistently and can state     │
│               WHY when held." (verbatim, same string every single time)   │
│    enforcement.level: "reminder" (always — never must/should/hard)        │
│    behavior.kind: "standard" (always — never "assertion")                 │
│         │                                                                  │
│         ▼                                                                  │
│  FIXED (MOD-009): prompt for evidence + enforcement level as two          │
│  additional interactive questions (or flags: -e/--evidence,               │
│  --level <reminder|should|must|hard>); write behavior.kind: "assertion"   │
│  to match the 19 already-real, specifically-authored example habits       │
│  instead of the thin default. Backfill: re-run the fixed command's        │
│  evidence-authoring step (not create — an update path) against the 19     │
│  habits currently carrying the generic boilerplate evidence string, so    │
│  every bundled habit meets the same bar the fix now enforces for new ones.│
└──────────────────────────────────────────────────────────────────────────┘

┌────────────────────────────────────────────────────────────────────────────┐
│  UNINSTALL LAYER (NEW — MOD-004)                                           │
│                                                                              │
│  npm uninstall -g ──▶ preuninstall.js (mirrors postinstall.js's own       │
│  scoping guards) ──▶ kill daemon+monitor+watchdog by PID file (fall back   │
│  to process-pattern match if PID files are stale) ──▶ strip BOTH           │
│  PreToolUse and UserPromptSubmit ack.js-marked entries from                │
│  ~/.claude/settings.json (merge-aware, touches nothing else in the file)  │
│  ──▶ leave workspace data (.agent/habits/, memory) untouched — uninstall   │
│  removes running processes and hook registration, not the user's data     │
└──────────────────────────────────────────────────────────────────────────┘
```

## 1.3 Tech Stack / Approach

| Layer | Approach | Rationale |
|---|---|---|
| Install entry | npm lifecycle hooks (`postinstall`, new `preuninstall`) | Only mechanism that runs automatically on `npm install -g` / `npm uninstall -g` without requiring the user to remember a follow-up command |
| Interactive setup | Deferred to `ack install` (Commander.js CLI, real TTY) rather than attempted inside the lifecycle hook | Proven by direct instrumentation that lifecycle hooks get no real stdin/stdout TTY — building a wizard there was tried and reverted (v1.2.1 CHANGELOG); the fix is to stop trying, not try harder |
| Daemon/monitor/watchdog | Detached Node child processes (`spawn(..., {detached:true})`), Unix domain socket RPC | Matches the existing root-owned-daemon design goal (agent cannot easily kill what it doesn't own); Node-native since v1.1.0, Python versions exist in parallel for the Hermes companion binding specifically, not as a required dependency of the core trio |
| Auth | Shared-secret token (`crypto.randomUUID()`), compared server-side, currently only reaches the daemon's env in root/systemd mode | Needs to reach user-mode spawns too (MOD-006) — the design was right, the wiring was incomplete |
| Habit injection | Daemon-owned rotation state (`pickPrompt`), keyed by session, survives the fresh-process-per-hook-call reality of CLI companions | A module-level dict in a per-call CLI process resets every call; only the long-lived daemon can hold rotation state |
| Acknowledgment detection (Hermes, VERIFIED existing) | `_detect_ack()` regex against the agent's own `pre_llm_call` message text, appends to external ack log | The plugin never self-credits — only the independent, root-owned monitor can, so the agent's own process cannot forge an acknowledgment |
| Acknowledgment detection (Claude, MOD-008 — the actual gap) | Port `_detect_ack()`'s pattern reading `transcript_path` from the hook payload instead of a `pre_llm_call` message param | Claude Code's hook surface has no direct equivalent of Hermes's `pre_llm_call(user_message=...)`; the detection *logic* transfers directly, only the input source differs |
| Habit format | `behavior.kind: "assertion"` with specific, non-generic `evidence` | The demonstrated-correct format among the 40 bundled habits; `"standard"` with boilerplate evidence is the thin `ack habit create` default, not an intentional second format |
| Liveness verification | Post-spawn poll: `status` RPC round-trip + PID-still-running check, short bounded retry | `spawn()` not throwing means the OS accepted the fork, not that the process is still running or responsive a second later. VERIFIED existing timeout budget this must respect: `client.js`'s own RPC calls already timeout at 5000ms (`client.js:48`); a liveness poll retry loop must resolve well inside that window per attempt, and the existing test harness (`habit-create.test.js:28`) budgets 20000ms total for a fresh daemon to bind its socket from cold start — MOD-007's bounded retry should be sized against that real number, not an arbitrary guess. |

## 1.4 Guiding Principles

1. **Verify, don't assume — including this document's own prior claims.**
   Every claim below traces to a git commit hash, a direct code read, or a
   live reproduction. This principle is why v3 exists: v2.0's MOD-008 claim
   ("zero real callers of `submit_ack`") was itself an unverified claim
   that turned out to be false on a second, deeper read. A blueprint is not
   exempt from the standard it sets for the code it specifies.
2. **Never reveal what the design deliberately withholds.** Habit names,
   the ack statement format, and exact file paths stay out of every terse
   message and every injection string, confirmed as intentional via commit
   `6a71887`'s own diff comment — a locational nudge is the ceiling, not a
   name or a path.
3. **A lifecycle hook is not a terminal.** Nothing in
   `postinstall.js`/`preuninstall.js` may attempt to read stdin or block
   waiting for input — proven, not assumed — and the fix is always "defer
   to a real CLI invocation," never "try harder to get a TTY."
4. **Spawned is not the same as running.** Every background process this
   system starts gets a liveness check before the install is allowed to
   report success.
5. **Fix the mechanism, not the symptom, and not just the half you can see
   from one harness.** v1.0 fixed postinstall's *output* without checking
   what was underneath it. v2.0 fixed the architecture documentation but
   scoped MOD-008 to Claude alone without checking whether an equivalent
   mechanism already existed and worked for a different companion — it
   did. Every future pass on this document owes the same cross-check.
6. **Uninstall is part of the contract.** A component that modifies the
   user's global settings and spawns background processes owes the user a
   way to get back to exactly where they started.
7. **Claims require a demonstration, not a description.** Every Phase 1/2
   deliverable in Part VI is an `external-check` — a real, reproduced
   action with real output pasted back — never a description of what
   "should" happen.
8. **A rejected design is recorded, not erased, and not silently reopened.**
   The heavier acknowledgment-enforcement architecture in
   `docs/agent-character-injection-design.md` was deliberately decided
   against, in writing, with reasoning. This blueprint references it for
   continuity and explicitly keeps it out of scope — reviving any piece of
   it requires its own future CL entry with its own stated reasoning, not
   an assumption that "more robust" always means "build the bigger thing."

## 1.5 Components Involved

| Component | Role | Technology / Method | Location |
|---|---|---|---|
| `postinstall.js` | Entry point on `npm install -g`; scoping guard + (post-fix) interactive-pointer default | Node, npm lifecycle hook | `node/bin/postinstall.js` |
| `preuninstall.js` (new) | Entry point on `npm uninstall -g`; reverses postinstall's effects | Node, npm lifecycle hook | `node/bin/preuninstall.js` |
| `install.js` | Core install logic: workspace scaffold, `.env` write, daemon/monitor/watchdog spawn, Claude hook config write | Node, imported by both `postinstall.js` and `ack install` | `node/bin/install.js` |
| `agent_enforcer_daemon.js` | Long-lived RPC server: `validateTool`, `toolTick` (hold state, VERIFIED default every 5 calls via `ACK_HOLD_EVERY_N_CALLS`), `pickPrompt` (rotation), `submitAck`, `status`, plus `execute_tool`/`reload`/`get_habit`/`register_workspace` | Node, Unix domain socket (or TCP), out-of-process | `node/enforcer/agent_enforcer_daemon.js` |
| `ack_monitor.js` / `.py` | VERIFIED real (130+/140+ lines): tails `ACK_ACK_LOG`, validates entries, calls `submit_ack`. The only component permitted to credit an acknowledgment | Node + Python parity implementation, detached background process | `deploy/ack_monitor.js`, `deploy/ack_monitor.py` |
| `ack_watchdog.js` / `.py` | VERIFIED real (134+/96+ lines): revives `ack_monitor` if it dies | Node + Python parity implementation, detached background process | `deploy/ack_watchdog.js`, `deploy/ack_watchdog.py` |
| `ack.js` | CLI entry point (`ack install`, `ack hook claude`, `ack status`, `ack doctor`, `ack habit create`/`list`, ...) | Node, Commander.js | `node/bin/ack.js` |
| `character.js` | `processToolCall`, `processPromptSubmit`, `pickHabitPrompts`, `generateConfig` (5 harnesses) | Node, imported by `ack.js` | `node/src/hooks/character.js` |
| `client.js` | Thin RPC client wrapper (`toolTick`, `pickPrompt`, `heartbeat`) — currently missing a `submitAck` wrapper | Node | `node/src/enforcer/client.js` |
| `hermes_plugin/__init__.py` | VERIFIED, complete, working reference for the acknowledgment-detection loop: `_on_pre_tool_call` (hard-blocks via daemon `tool_tick`), `_on_pre_llm_call` (injects rotating habits AND calls `_detect_ack` every turn), `_detect_ack` (regex-match + append-only log write, never self-credits) | Python, registers `pre_tool_call` + `pre_llm_call` hooks | `python/hermes_plugin/__init__.py` |
| Claude chat-transcript detector (new, MOD-008) | Port of `_detect_ack`'s exact pattern, reading `transcript_path` from the Claude hook payload instead of a `pre_llm_call` message param | Node — extends `ack.js hook claude`'s existing payload handling | Location TBD in Phase 1, likely `node/src/hooks/character.js` alongside `processPromptSubmit` |
| `ack habit create` (existing, thin) | Interactive/flag-driven habit YAML generator — currently only asks 3 of 5 fields, hardcodes the rest | Node, Commander.js subcommand | `node/bin/ack.js` (`habitCmd.command("create")`) |
| `~/.claude/settings.json` | Claude Code's own hook registry | JSON, user-owned | `~/.claude/settings.json` |

## 1.6 Non-Goals & Explicit Scope Boundaries

Stated formally, not just implied by omission — per Guiding Principle 1,
what this document does NOT cover should be as traceable as what it does:

1. **Not building any piece of the deferred heavy acknowledgment-enforcement
   design** (loop-enforcer chain, setuid kill-switch log, dual gridlock
   monitors, ERC-8004-hosted habit DB) — KD-10, deliberately out of scope,
   see Part I/1.2's architecture diagram footnote and the design doc at
   commit `0992bcc`.
2. **Not porting MOD-008's fix to any harness other than Claude.** Hermes
   already has a working implementation (verified, reference only in this
   document). Cursor, Gemini, and OpenCode have no equivalent gap analysis
   performed in this investigation — `generateConfig()` supporting them is
   necessary but not sufficient evidence their acknowledgment loop is
   complete; that is a future blueprint's scope, not this one's.
3. **Not changing `submitAck()`'s validation logic** (the reuse-window
   guard, minimum reason length, variable-closer grammar) — FEAT-002
   explicitly states this feature adds a caller to that logic, not a
   change to it.
4. **Not relaxing the fail-closed posture anywhere** — a daemon-unreachable
   condition during any RPC call continues to mean "hold," never "allow."
5. **Not migrating existing installed workspaces automatically.** A machine
   with an already-running daemon predating MOD-006/MOD-007 is not
   force-upgraded by this blueprint's changes; the next `ack install` or
   `npm install -g` picks up the fixes, but there is no background
   migration path specified here, and none is implied.
6. **Not touching `constitution.yaml`/`enforcer.yaml`'s actual bundled
   example content** — §4.4 documents their real shape for the first time
   in this blueprint, but no checklist item in Part VI modifies either
   file; they are read-only inputs to the logic this blueprint repairs.

---

---

# PART II — MODULE REGISTRY

> **Rollback Tag:** `[MODULE-REGISTRY-v2]`
> **Rule:** Every change log entry MUST reference at least one Module ID
> (unless this Part is N/A for this scope).

| Module ID | Name | Description | Feature Flag |
|---|---|---|---|
| MOD-001 | postinstall-visible-output | `postinstall.js` prints real success/failure/next-step messages to stdout/stderr, not just a silent tmp log — VERIFIED already implemented and live | FEAT_POSTINSTALL_OUTPUT |
| MOD-002 | injection-locational-nudge | `pickHabitPrompts()` adds a vague, non-specific "check your home directory" style nudge without revealing names or exact paths | FEAT_INJECTION_NUDGE |
| MOD-003 | userpromptsubmit-wiring | `writeClaudeHookConfig()` writes BOTH `PreToolUse` and `UserPromptSubmit` hooks into `~/.claude/settings.json` | FEAT_PROMPT_SUBMIT_HOOK |
| MOD-004 | uninstall-cleanup | New `preuninstall.js`: kills daemon/monitor/watchdog, strips both hooks | FEAT_UNINSTALL_CLEANUP |
| MOD-005 | interactive-default-install | `postinstall.js` defaults to pointing at `ack install` instead of silently auto-configuring; `ACK_YES=1`/`-y` bypasses to today's behavior | FEAT_INTERACTIVE_DEFAULT |
| MOD-006 | auth-token-wiring | `install.js` passes `ACK_AUTH_TOKEN` into the daemon/monitor/watchdog spawn env, not just the client `.env` | FEAT_AUTH_TOKEN_LIVE |
| MOD-007 | component-liveness-verification | `install.js` confirms daemon/monitor/watchdog are actually alive (RPC + PID check) before reporting success | FEAT_LIVENESS_VERIFY |
| MOD-008 | claude-transcript-ack-detector *(corrected scope, v3)* | Port `hermes_plugin`'s VERIFIED-working `_detect_ack()` pattern to Claude: read `transcript_path` from the hook payload, apply the same regex, append to the same `ACK_ACK_LOG` format `ack_monitor.js` already tails. NOT a new mechanism — a second implementation of a proven one. | FEAT_CHAT_MONITOR |
| MOD-009 | habit-creator-completeness *(new, v3; scope corrected CL-0006)* | All 3 independent habit-creation code paths (`ack.js habit create`, `install.js createHabitDirect`, `install.js createHabit`) collapsed into one shared `node/src/habits/build.js`; every one now prompts for `evidence` and `enforcement.level` instead of hardcoding either, and writes `behavior.kind: "assertion"`. The originally-planned "backfill 19 thin habits" step was found unnecessary on direct verification (KD-03) and removed — no bundled habit actually needed it. | FEAT_HABIT_CREATOR_COMPLETE |

## Module Extended Notes

**MOD-001** — Already implemented and verified live prior to this document's
existence. Retained in the registry (rather than removed on completion) so
Part VI's Phase 0 checklist has a real, checkable item establishing the
baseline the rest of the phase builds on, per Contributor Rule 6 (verified
complete, not assumed).

**MOD-002** — The locational nudge is deliberately vague by design (Guiding
Principle 2) — its purpose is to shorten the search an agent has to do to
find its own habit files, not to hand over the answer. "Enough to start a
search, not enough to skip it" is the literal acceptance bar, and it is
inherently a judgment call at implementation time about exactly how vague
"vague" needs to be — Phase 2's `external-check` for this module (PHASE-2.4)
is the actual arbiter, not a static string match.

**MOD-003** — This is the single highest-severity gap in the pre-existing
codebase found during either investigation session (KD-07): if
`UserPromptSubmit` was never wired, the entire injection half of the
enforcement loop (`pickHabitPrompts()`, MOD-002) may never have reached a
live Claude session regardless of how correct its own logic is — a hold
with no corresponding injection is a dead end by a different route than
MOD-008's gap, arrived at from the opposite direction (the daemon can hold,
but the agent may never have been shown how to get free).

**MOD-004** — Scoped as a mirror of `postinstall.js`'s own scoping guards
specifically so the two lifecycle hooks share one mental model: whatever
conditions cause `postinstall.js` to configure something, the same
conditions must cause `preuninstall.js` to consider removing it, or the two
hooks drift into asymmetric behavior over time as either one is
independently modified.

**MOD-005** — The interactive-default flip is a behavior change with real
user impact (today's silent auto-configure becomes tomorrow's
print-and-stop), which is why `ACK_YES=1`/`-y` must reproduce today's exact
behavior byte-for-byte (FEAT-001's Rules) — this is a deliberate default
change, not a removal of the old behavior.

**MOD-006** — The auth token mechanism already exists in the client
(`.env` write) and the daemon (the auth-gate check on every RPC method);
the gap is narrowly the spawn-env wiring for user-mode installs
specifically, not a missing design. This is the kind of gap that is easy
to miss precisely because most of the surrounding machinery already works.

**MOD-007** — Liveness verification is intentionally a POST-spawn check,
not a pre-spawn guarantee — Node's `spawn()` returning without throwing
only means the OS accepted the fork request, which is a substantially
weaker guarantee than "the process is still running and responding to RPC
a moment later." The short bounded retry (Tech Stack table, 1.3) exists
because a process can legitimately take a brief moment to bind its socket.

**MOD-008** — Corrected in this regeneration from "build a new mechanism"
to "port a proven one" (CL-0003, Guiding Principle 5). The distinction
matters for implementation risk: porting `_detect_ack()`'s already-tested
regex and already-decided no-self-credit design is a substantially lower-
risk task than designing detection logic from scratch would have been,
even though the checklist item (PHASE-1.4) and the feature flag are
unchanged from v2.0's naming.

**MOD-009** — Discovered independently of MOD-001 through MOD-008, during
a live audit prompted by a direct question about habit-prompt phrasing
conventions (39/40 already correct) that led to inspecting the full
schema and finding the `"standard"`/`"assertion"` split. Included in this
regeneration specifically because Guiding Principle 1 applies to gaps
found mid-investigation, not only to gaps present at a blueprint's initial
scoping.

---

---

# PART III — SCREEN & FEATURE SPECIFICATIONS

> **Rollback Tag:** `[SPECS-v2]`

Each specification follows this format:
> ID, Module Ref, Rollback Tag, Feature Flag, Purpose,
> Components, Rules, Error States, Fallback.

**FEAT-001 — Install lifecycle: interactive by default, verified components**
- Feature ID: FEAT-001
- Module Ref: MOD-001, MOD-003, MOD-005, MOD-006, MOD-007
- Rollback Tag: `[SPECS-v2]`
- Feature Flag: `FEAT_INSTALL_LIFECYCLE`
- Purpose: `npm install -g` asks what it needs to know instead of guessing,
  and never reports success for a component that isn't actually running.
- Components: `postinstall.js`, `install.js`, `writeClaudeHookConfig()`,
  `launchDaemon()`, the new liveness-poll function.
- Rules: the interactive-pointer default must print-and-exit, never block on
  stdin (proven impossible in a lifecycle hook); `ACK_YES=1`/`-y` reproduces
  today's auto-detect behavior exactly, byte-for-byte in what gets written to
  `settings.json`; a liveness check failure must be reported as a failure,
  never silently downgraded to a warning.
- Error States: harness auto-detection finds nothing → falls back to
  `generic`, still reports clearly what was NOT detected; a component that
  fails liveness → install reports partial failure with the exact component
  named, not a blanket "something went wrong."
- Fallback: `ack install` (interactive) and `ack doctor` (diagnostic) remain
  available for every case automatic install doesn't cover.

**FEAT-002 — Runtime enforcement loop: hold, inject, acknowledge, credit**
- Feature ID: FEAT-002
- Module Ref: MOD-002, MOD-008
- Rollback Tag: `[SPECS-v2]`
- Feature Flag: `FEAT_ENFORCEMENT_LOOP`
- Purpose: the hold-every-N-calls mechanism and the pre-prompt injection
  mechanism are two real, connected halves of one loop — an agent that gets
  held has a real, discoverable (not handed-to-it) way to satisfy the hold
  and continue, and doing so is visible to the human in the chat transcript.
  For Claude specifically, this feature closes the one confirmed missing
  link; for Hermes, this exact loop is already confirmed working end to end
  and serves as the reference implementation MOD-008 is built from.
- Components: `agent_enforcer_daemon.js` (`toolTick`, `pickPrompt`,
  `submitAck`), `pickHabitPrompts()`, the new Claude transcript detector,
  `ack_monitor.js`/`.py` (existing, verified-real, log-tailing sibling the
  new detector's log-format output must stay compatible with), the Hermes
  `_detect_ack()`/`_on_pre_llm_call` pair (verified working, unchanged by
  this feature — reference only).
- Rules: the hold message never contains a habit name or the exact ack
  format (commit `6a71887`, confirmed intentional, and the text itself was
  simplified live tonight to exactly "state two habit names, and how they
  apply to the work you've been doing." — no additional explanatory
  padding); the injection nudge is general/locational only, never a literal
  path or filename; the reuse guard (no repeating either of the last 2
  acknowledged habits or reasons) must keep working exactly as
  `submitAck()` already implements it — this feature adds a caller, it does
  not change that validation logic; search/read tools remain exempt from
  holds during an active hold (verified: `agent_enforcer_daemon.js:644`).
- Error States: daemon unreachable during a hold → fail-closed (already the
  existing posture in `client.js`'s `toolTick`, unchanged here); transcript
  file unreadable/missing → the new detector logs the failure and does NOT
  silently treat it as "nothing to acknowledge yet."
- Fallback: none by design — this is the enforcement mechanism itself; a
  broken fallback here would be a bypass, which is explicitly against the
  point (Guiding Principle 2).

**FEAT-003 — Uninstall lifecycle: full symmetry with install**
- Feature ID: FEAT-003
- Module Ref: MOD-004
- Rollback Tag: `[SPECS-v2]`
- Feature Flag: `FEAT_UNINSTALL_LIFECYCLE`
- Purpose: `npm uninstall -g` undoes everything `postinstall.js` did —
  running processes and hook registration — without touching the user's
  actual habit/memory data, which persists independent of the npm package.
- Components: new `preuninstall.js`, the same `settings.json` merge logic
  `writeClaudeHookConfig()` already uses (read, not duplicate).
- Rules: must no-op safely if nothing was ever installed (local dev
  environment, or a machine where install failed partway); must use the same
  `bin/ack.js` marker string PreToolUse merging already relies on, so it
  removes exactly what it added and nothing a different tool might have
  added to the same hooks array.
- Error States: a PID file pointing at a process that's already dead → skip
  silently, not an error; a `settings.json` that's been hand-edited since
  install (marker string altered) → leave it alone rather than guess.
- Fallback: the manual one-liner used live tonight (`pkill -f
  'character-kit'`, strip the `hooks` key, remove `~/.agent-character-kit`)
  remains the documented recovery path if `preuninstall.js` itself fails.

**FEAT-004 — Habit creation asks for everything a habit needs, from one shared implementation (NEW, v3; scope corrected CL-0006)**
- Feature ID: FEAT-004
- Module Ref: MOD-009
- Rollback Tag: `[SPECS-v2]`
- Feature Flag: `FEAT_HABIT_CREATOR_COMPLETE`
- Purpose: every habit authored through `ack habit create` OR `ack install`'s
  interactive wizard OR `install.js --create-habit`, has specific,
  non-generic evidence and a deliberately chosen enforcement level and
  behavior kind — not hardcoded defaults — and all three entry points agree,
  because they now share one implementation instead of three independent
  copies (KD-11, found mid-implementation, not in the original scoping).
- Components: `node/src/habits/build.js` (new, single source of truth:
  `normalizeHabitName`, `buildHabitYaml`, `VALID_LEVELS`), `ack.js`'s
  `habitCmd.command("create")` handler, `install.js`'s `createHabitDirect`
  (non-interactive, `--create-habit`) and `createHabit` (interactive wizard)
  — all three now call the shared builder instead of maintaining their own
  YAML-generation logic.
- Rules: `evidence` and `enforcement.level` (`reminder`/`should`/`must`/
  `hard`) must be asked exactly like `prompt`/`logic` — flag if supplied,
  interactive re-prompt otherwise (or a hard CLI error for the
  non-interactive `--create-habit` path, which cannot block on stdin),
  never silently defaulted; every path writes `behavior.kind: "assertion"`;
  the shared builder itself validates all 5 fields and throws on any
  missing one, so no caller can accidentally bypass the rule.
- Error States: an empty/whitespace-only answer (prompt, logic, or
  evidence) is rejected with a reprompt across ALL THREE entry points — the
  interactive `createHabit` wizard did not previously validate this either,
  found and fixed in the same pass since the fix touched that exact code;
  an invalid `--level`/level answer (not one of the four allowed) errors
  with the valid list shown, never silently coerced to `"reminder"`.
- Fallback: hand-editing the YAML file directly remains available and
  always has been — this feature makes every guided path actually
  complete, it doesn't remove the manual one.
- **Scope correction (CL-0006):** the originally-planned "backfill evidence
  into 19 existing thin habits" component does not appear above because it
  was found unnecessary — see KD-03. Verifying a diagnosis before acting on
  it is Guiding Principle 1 applied to this feature specifically, not just
  to reading someone else's code.

---

---

# PART IV — DATA ARCHITECTURE

> **Rollback Tag:** `[DATA-ARCH-v2]`
> **Rule:** All schema changes require a migration file named
> `YYYYMMDD_NNN_description.sql` with a corresponding rollback file,
> and must be referenced in the Global Change Log (where applicable).

## 4.1 Core Data / State

This system has no relational database — all state is JSON/JSONL on disk or
in-process daemon memory. Documented here with the same rigor a schema
would get, since that's the actual persistence layer (Part IV's data-schema
requirement is WARN, not FAIL, when genuinely inapplicable per
`blueprint-standard.md` §14 — this is honest documentation of what exists,
not an invented database to satisfy a checkbox):

**`~/.claude/settings.json`** (user-owned, merge-not-clobber)
```
hooks.PreToolUse:      [{ matcher: "*", hooks: [{ type: "command", command: <ack.js invocation> }] }]
hooks.UserPromptSubmit: [{ hooks: [{ type: "command", command: <ack.js invocation> }] }]
```
Both arrays are filtered on write to remove any prior entry whose `command`
contains the `bin/ack.js` marker string, then the current one is pushed —
idempotent re-install, no duplicate accumulation.

**`<workspace>/.env`** (per-workspace, 0600 recommended)
```
AGENT_WORKSPACE=<absolute path>
ENFORCER_SOCKET=<socket path or tcp:// URL>
ACK_ACK_LOG=<path to ack.jsonl>
ACK_AUTH_TOKEN=<crypto.randomUUID()>
ACK_MONITOR_PID / ACK_MONITOR_STATE / ACK_WATCHDOG_PID / ACK_MONITOR_BIN
ACK_HOLD_EVERY_N_CALLS=<int, default 5 — VERIFIED, agent_enforcer_daemon.js:194>
ACK_FILE_CHANGE_THRESHOLD / ACK_COMMIT_EVERY_N_CYCLES  (commit-discipline sub-gate)
```

**`ACK_ACK_LOG`** (JSONL, append-only, one line per detected acknowledgment
attempt — VERIFIED shape, `hermes_plugin/__init__.py:229-232`, this is the
exact contract MOD-008's Claude detector must match, not a shape TBD):
```
{ "session_id": string, "statement": string }
```

**`ACK_INJECT_LOG`** (JSONL, append-only — VERIFIED, `hermes_plugin/__init__.py:313-329`;
external proof of what was actually injected, read by the monitor, never
the agent's own self-report):
```
{ "ts": ISO8601, "count": int, "prompts": string[] }
```

**Daemon in-memory hold state** (`HOLD_STATE`, keyed by session)
```
{ count: int, acked: int, lastTwo: [string,string], reasons: [string,...],
  filesTouched: Set<string>, cyclesSinceCommit: int }
```

**Daemon in-memory prompt-rotation state** (`PROMPT_CYCLE`, keyed by session)
```
{ order: int[], pos: int }
```

**Habit YAML** (`.agent/habits/*.yaml` — VERIFIED, both correct and thin
forms currently coexist; MOD-009 makes only the "assertion" shape reachable
via the creator going forward)
```yaml
name: string                     # snake_case, becomes the filename
prompt: string                   # MUST be a question — VERIFIED: 39 of 40
                                  # bundled habits already are; the one
                                  # violation found tonight was corrected
                                  # live (safe-deletion-via-trash.yaml)
enforcement:
  level: reminder | should | must | hard
behavior:
  kind: assertion | standard | guard   # "standard" is the thin creator's
                                        # default output, not a second
                                        # intentional format; "guard" is
                                        # genuinely distinct (pattern-match
                                        # hard-block, e.g. no-credential-leak.yaml)
  assert: string
  evidence: string                 # MUST be specific to the habit, never
                                    # the generic boilerplate the thin
                                    # creator currently hardcodes
  logic: string
```

## 4.2 Interface / API Contracts

All RPC methods share one envelope over the Unix socket (or TCP), newline-
delimited JSON: `{ method: string, params: object, token?: string }` →
`{ ...response }` or `{ error: string }`.

| Method | Params | Returns | Notes |
|---|---|---|---|
| `status` | — | `{ ok, version, workspace, socket, habits, sessions }` | Used by MOD-007's liveness poll |
| `validate_workspace` | — | `{ allowed: true }` | Pass-through, not enforcer-gated |
| `tool_tick` | `session_id, tool, file_path?` | `{ hold: bool, reason?, commit_required? }` | Core hold mechanism; VERIFIED search/read tools always return `{hold:false}` unconditionally, independent of count |
| `pick_prompt` | `session_id` | `{ prompts: [{prompt, logic, evidence}] }` | Rotation state owned server-side; never returns a habit name |
| `submit_ack` | `session_id, statement` | `{ ok: bool, error? }` | VERIFIED real, existing callers: `ack_monitor.js`/`.py` (both harnesses' monitor processes) — NOT zero callers, correcting v2.0's claim |
| `heartbeat` | `status` | `{ ok: true }` | Liveness signal from companions |
| `register_workspace` | `workspace` | implementation-defined | Runtime workspace registration |
| `execute_tool` | `tool: string, ...params` | `{ denied: bool, reason?, reflection?, commit_intent?: bool }` | VERIFIED, `agent_enforcer_daemon.js:266` — the actual constitution/policy validation logic (see 4.3 below); NOT previously documented in this blueprint despite being the deny/allow decision point every tool call flows through |
| `reload` | — | `{ ok: true, character_hash: string }` | VERIFIED, `agent_enforcer_daemon.js:254` — re-reads constitution, habits, and policy from disk and recomputes `characterHash` (sha256 of the three combined); this is the daemon's own "did my character definition change" detector referenced conceptually by the rejected-heavy-design doc's `character_hash_visible` habit |
| `get_habit` | `name: string` | `{ name, prompt, assert, evidence, logic, enforcement } \| { error: "unknown habit: <name>" }` | VERIFIED, `agent_enforcer_daemon.js:514` — single-habit lookup by exact name; returns the same `evidence`/`logic` fields MOD-009 fixes the creator to actually ask for, confirming the daemon already expects and serves both fields correctly — the gap MOD-009 closes is upstream, in what the creator writes, not downstream in what the daemon reads |

Auth gate (all methods, when `ACK_AUTH_TOKEN` is set in the **daemon's own**
process env — currently only true in root/systemd mode, MOD-006 fixes this
for user mode): request `token` must match, else `{ error: "unauthorized" }`.

## 4.3 `execute_tool` Deny-Pattern Logic (VERIFIED, documented in full for the
first time in this blueprint)

`executeTool(tool, params)` is the actual decision function every tool call
is validated against before `toolTick`'s hold-counting even runs. Order of
evaluation, read directly from `agent_enforcer_daemon.js:266` onward:

1. **Hard-constraint deny patterns** — `constitution.hard_constraints`
   concatenated with `policy.deny`, checked first, unconditionally. A match
   returns `{ denied: true, reason: "Violates hard constraint: <pattern>", reflection: <fixed educational string> }`
   and is audited before returning. Nothing below this step can override a
   hard-constraint match.
2. **Commit-intent carve-out** — a command matching `/\bgit\s+.*\bcommit\b/`
   that is NOT a `--no-commit`/`rebase`/`cherry-pick` invocation is
   explicitly exempted from the allow-list step below and returns
   `{ denied: false, commit_intent: true }` immediately after the
   hard-constraint check. This is a deliberate design choice — the git
   commit discipline habits elsewhere in this system depend on `git commit`
   never being blockable by an allow-list that happens not to mention it.
3. **Allow-list policy** (only if `policy.allow` is a non-empty array) —
   if set, ONLY tools/commands matching an entry in `policy.allow` pass;
   everything else is implicitly denied. An empty or unset `policy.allow`
   means this step is a no-op (nothing is allow-listed, so nothing is
   denied by this step specifically).

This is the layer `toolTick`'s hold-every-N-calls mechanism (documented in
Part I's runtime enforcement diagram) sits downstream of — a call denied
here never reaches the hold-counting logic at all, since it never executes.
Every audit entry (`this._audit(tool, command, result)`) is written
regardless of allow/deny outcome, matching Guiding Principle 2's fail-
closed, tamper-evident posture: even an allowed call leaves a record.

---

---

# PART V — CHANGE CONTROL PROTOCOL

> **Rollback Tag:** `[CHANGE-CONTROL-v1]`
> **This section is permanent and non-negotiable.**
> Every contributor must read this section before making any change.

## Change Log Entry Format

Every entry MUST include all fields below. Entries are permanent.
No entry may be modified or deleted after writing.

```
Date        : YYYY-MM-DD HH:MM UTC
Contributor : [name/handle]
Modules     : [MOD-XXX, ...]
Section Tags: [[TAG-NAME-v1], ...]
Files Changed: [every file changed]
Description : [What changed and why — minimum 3 sentences]
Tests Passing: [test names, or 'none — pre-build']
Phase       : [PHASE-N]
Rollback Ref: [git commit hash or migration rollback filename]
```

## Contributor Rules

1. No work merged without a change log entry in the same PR.
2. No database migration without a rollback migration file (N/A here — no
   RDBMS — but the same discipline applies to any change to the JSON/JSONL
   shapes in Part IV: document the shape change in the change log). Concrete
   example of what this looks like for this system: if MOD-008's Claude
   detector needed a shape different from the verified `ACK_ACK_LOG` entry
   (`{session_id, statement}`, §4.1), the change log entry documenting that
   would name the old shape, the new shape, and whether `ack_monitor.js`'s
   existing reader needs a corresponding update to stay compatible — the
   same information a `YYYYMMDD_NNN_description.sql` + rollback pair would
   carry for a relational schema, just written as prose in the CL entry
   instead of as a migration file, since there is no migration runner here.
3. Feature flags required for every Phase 1+ deliverable (Part VI already
   tags each phase with one).
4. Minimum: 1 real, reproduced verification per deliverable — no
   deliverable in Phase 1/2 may be marked complete on a description alone
   (Guiding Principle 7).
5. No contributor may modify or delete an existing change log entry —
   corrections are new entries, always.
6. Every checklist item in Part VI must be checked off by whoever actually
   ran the verification, not assumed complete because the code compiles.
7. A blueprint's own claims about existing code are themselves subject to
   verification, not exempt from it (Guiding Principle 1) — a future
   correction to a claim made in this document gets its own CL entry, the
   same as a correction to the code would.

## Reviewer Checklist (applies to every `Type: review` deliverable)

Each phase's `Type: review` critique artifact must, at minimum, answer
these — matching this document's own standard for itself, not a lighter
bar than what Part VI's `external-check` deliverables require of the code:

1. **Was every claim in the phase's deliverables actually demonstrated?**
   An `external-check` deliverable with a description of expected behavior
   but no pasted real output is not complete, regardless of what the
   checklist checkbox says (Contributor Rule 4 / Guiding Principle 7).
2. **Does the reviewer differ from the assignee?** Structurally enforced by
   the `Type: review` deliverable requiring a `Reviewed-By:` field that
   must not match the phase's `Assigned Agent` (`blueprint-standard.md`
   §6) — the review is void if this isn't true, independent of how
   thorough its content otherwise is.
3. **Did anything in this phase contradict an earlier claim in this
   document, and if so, was it corrected here rather than left standing?**
   This is the specific check that would have caught v2.0's MOD-008 error
   at review time rather than requiring a second full investigation.
4. **Is every new file/behavior this phase introduced reflected in Part
   I's Components table and Part IV's data/RPC documentation, or is the
   document now out of sync with the code it describes?**
5. **For MOD-009 specifically:** did the reviewer verify the habit
   creator's `evidence` prompt was actually asked at all three entry
   points (`ack.js habit create`, `install.js --create-habit`, and the
   `ack install` interactive wizard), not merely one of them, given all
   three used to be independent implementations?

---

---

# PART VI — MASTER IMPLEMENTATION CHECKLIST

### PHASE-0: Foundation, Documentation Correction & Quick Fixes

**Section Tag:** `[PHASE-0-v2]`
**Feature Flag:** `FEAT_FOUNDATION_QUICK_FIXES`
**Assigned Agent:** claude-code-session
**Reviewer Agent:** drdeeks

### Prerequisites

None — first phase.

### Deliverables

- [x] **PHASE-0.1** `node/bin/postinstall.js` Type: file — visible stdout/stderr output (superseded in behavior by PHASE-1's default-flip, message-formatting layer stays) — VERIFIED already implemented
- [x] **PHASE-0.2** `node/enforcer/agent_enforcer_daemon.js` Type: file — hold-message text simplified to "state two habit names, and how they apply to the work you've been doing." — VERIFIED already implemented live tonight
- [x] **PHASE-0.3** `node/src/hooks/character.js` Type: file — `pickHabitPrompts()` locational nudge (MOD-002) — verified: `node --test node/tests/character.test.js`, 9/9 pass including the pre-existing "never a habit name" assertion (caught the nudge text initially violating it, fixed before landing)
- [x] **PHASE-0.4** `node/bin/install.js` Type: file — `writeClaudeHookConfig()` merges `UserPromptSubmit` (MOD-003) — verified: real exported function tested directly (not a logic copy) in `node/tests/install.test.js`, confirms both hooks written, unrelated settings preserved, re-install is idempotent (no duplicate entries)
- [x] **PHASE-0.5** `node/bin/preuninstall.js` Type: file — new file, kills daemon/monitor/watchdog + strips both hooks (MOD-004) — verified: `node/tests/preuninstall.test.js`, 10/10 pass including a genuine end-to-end test that spawns a real process and confirms `killByPattern` actually terminates it (not just that the function returns true); PID-reuse safety and corrupted-settings-left-untouched cases also covered
- [x] **PHASE-0.6** `.blueprint/blueprint.md` (this document) Type: file — Part IV RPC table documents `execute_tool`/`reload`/`get_habit` (previously undocumented, no behavior change, verification-only task) — done during the v3 regeneration itself (§4.2, §4.3)
- [ ] **PHASE-0.7** review-phase0.md Type: review — awaiting drdeeks (Reviewer Agent must differ from Assigned Agent; not something the assignee can self-satisfy)

### Validation Gate

> No phase may begin until all prior checklist items are verified complete, all tests pass in CI, and a change log entry is appended.

### Rollback Procedure

1. `git checkout -- <file>` on any touched file reverts to its state before this phase.
2. No irreversible action anywhere in this phase — no schema, no deploy, no push.
3. Manual recovery one-liner from prior sessions (`pkill -f 'character-kit'`, strip `hooks` key, remove `~/.agent-character-kit`) is the fallback if a live test leaves the machine in a bad state.
4. Post-incident change log entry within 24 hours if rollback is used.

---
### PHASE-1: Enforcement Loop Completion & Habit Authoring Fix

**Section Tag:** `[PHASE-1-v2]`
**Feature Flag:** `FEAT_ENFORCEMENT_LOOP_VERIFICATION`
**Assigned Agent:** claude-code-session
**Reviewer Agent:** drdeeks

### Prerequisites

All Phase 0 items complete, change log entry written.

### Deliverables

- [x] **PHASE-1.1** `node/bin/postinstall.js` Type: file — default flips to interactive-pointer; `ACK_YES=1`/`-y` bypasses to auto-configure (MOD-005) — verified: real subprocess spawns against a fake global node_modules install, both branches, 3 tests
- [x] **PHASE-1.2** `node/bin/install.js` Type: file — `ACK_AUTH_TOKEN` added to daemon/monitor/watchdog spawn env (MOD-006) — verified: real token read from `/proc/<pid>/environ` on a live daemon, plus RPC accept/reject
- [x] **PHASE-1.3** `node/bin/install.js` Type: file — post-spawn liveness verification: `status` RPC + PID check for all three components (MOD-007) — verified: genuine partial-failure case (daemon up, monitor/watchdog PIDs dead) and a fully-alive end-to-end case, both with real spawned processes
- [x] **PHASE-1.4** Type: file — new Claude transcript ack-detector, porting `_detect_ack()`'s verified pattern (MOD-008) — verified against a real Claude Code transcript file's actual schema (not assumed) before writing; deliberately broader than a literal Hermes port (daemon's real 5-closer grammar, not just "resonates true because"), 7 tests
- [x] **PHASE-1.5** `node/bin/ack.js` + `install.js` (both other creation paths) Type: file — all prompt for `evidence` + `enforcement.level`, write `behavior.kind: "assertion"` (MOD-009) — expanded mid-implementation to collapse 3 independent duplicate implementations into `node/src/habits/build.js` (KD-11, found during this work, not in original scoping)
- [x] ~~**PHASE-1.6** companion evidence-backfill path for the 19 existing thin habits~~ — **REMOVED (CL-0006).** Verification before execution found this unnecessary: zero files contained the boilerplate string, and the 17 `kind:"standard"` files already carry specific, real evidence. See KD-03.
- [ ] **PHASE-1.7** review-phase1.md Type: review — awaiting drdeeks

### Validation Gate

> No phase may begin until all prior checklist items are verified complete, all tests pass in CI, and a change log entry is appended.

### Rollback Procedure

1. `git checkout -- <file>` on any of the touched files (`postinstall.js`, `install.js`, `character.js`, `ack.js`, `node/src/habits/build.js`) reverts each independently — this phase's deliverables do not depend on each other's runtime state, so a partial rollback of just MOD-008 or just MOD-009 does not require reverting MOD-005/006/007 as well.
2. If `install.js`'s liveness-verification change (PHASE-1.3) is rolled back mid-testing, any daemon/monitor/watchdog already spawned by a test run of the NEW code must be killed by PID before reverting, or the old code's install summary will report success against processes it didn't actually verify.
3. MOD-009's refactor touched three files at once (`ack.js`, `install.js`, plus the new shared module) — reverting requires reverting all three together, or `ack.js habit create` and `install.js`'s two paths will disagree about what a habit YAML should look like, reintroducing the exact duplicated-truth problem (KD-11) the fix closed.
4. Post-incident change log entry within 24 hours if rollback is used, naming which deliverable was reverted and why.

---
### PHASE-2: Testing & Hardening

**Section Tag:** `[PHASE-2-v2]`
**Feature Flag:** `FEAT_TESTING_HARDENING`
**Assigned Agent:** claude-code-session
**Reviewer Agent:** drdeeks

### Prerequisites

All Phase 1 items complete, change log entry written.

### Deliverables

- [ ] **PHASE-2.1** Type: external-check — real `npm install -g` with no bypass flag; confirm it prints the interactive-pointer message and configures nothing
- [ ] **PHASE-2.2** Type: external-check — real `npm install -g` with `ACK_YES=1`; confirm `settings.json` gains BOTH hook types, real stdout output, and daemon/monitor/watchdog confirmed alive (`ps aux` + live `status` RPC)
- [ ] **PHASE-2.3** Type: external-check — confirm `ACK_AUTH_TOKEN` is present in the running daemon's actual environment and a mismatched-token request is genuinely rejected
- [ ] **PHASE-2.4** Type: external-check — trigger a real hold (terse/name-free confirmed) and a real injection (locational nudge, no literal path, confirmed)
- [ ] **PHASE-2.5** Type: external-check — end-to-end on Claude: produce a real "Habit: ..." statement live, confirm the new transcript detector logs it to `ACK_ACK_LOG`, `ack_monitor.js` credits it, and the hold actually lifts — the exact loop already confirmed working on Hermes, now confirmed on Claude too
- [ ] **PHASE-2.6** Type: external-check — real `npm uninstall -g`; confirm 0 processes, 0 dangling hooks, rest of `settings.json` untouched
- [x] **PHASE-2.7** Type: external-check — run `ack habit create` live with real answers to all 5 questions (name/prompt/logic/evidence/level); confirm the written YAML has `behavior.kind: "assertion"` and non-boilerplate evidence; confirm `install.js --create-habit` rejects an incomplete invocation instead of silently defaulting the missing fields — verified: `habits-build.test.js` (unit) + `habit-create.test.js` (real subprocess, both the complete and rejected-incomplete cases)
- [ ] **PHASE-2.8** review-phase2.md Type: review

### Validation Gate

> No phase may begin until all prior checklist items are verified complete, all tests pass in CI, and a change log entry is appended.

### Rollback Procedure

1. Every deliverable in this phase is `Type: external-check` — a verification action against already-shipped Phase 0/1 code, not new code of its own. A failed check does not require a code rollback by itself; it means the specific Phase 0/1 deliverable it's checking is not actually done, and that deliverable's own rollback procedure applies instead.
2. If PHASE-2.2's real global install leaves a machine in a bad state (stray processes, a corrupted `settings.json`), the manual recovery one-liner (`pkill -f 'character-kit'`, strip the `hooks` key, remove `~/.agent-character-kit`) is the documented fallback, same as every earlier phase.
3. If PHASE-2.5's end-to-end Claude acknowledgment test produces a false credit (an acknowledgment gets logged/credited that shouldn't have been), the daemon's hold ledger for that session must be manually reset via a fresh `AGENT_WORKSPACE`/session ID for any further testing — there is no partial-undo of a single `submit_ack` call by design (an audit trail is append-only, matching Guiding Principle 2's tamper-evident posture).
4. If PHASE-2.7's habit-creator test writes a malformed habit YAML, `git checkout -- <path>` on the specific habit file it touched is sufficient; the creator's own error-state handling (Part III, FEAT-004) should have rejected the malformed input before writing in the first place, so a rollback here is itself evidence the error-state rule needs fixing, not just the test data.
5. Post-incident change log entry within 24 hours if rollback is used.

---

---

---

# PART VII — QUALITY & COMPLIANCE STANDARDS

> **Rollback Tag:** `[QUALITY-v1]`

## Error Handling Standards (5-level, PROJECT tier)

1. **Input validation** — every new spawn-env object, every JSON merge,
   every parsed transcript line, every habit-creator answer is validated
   for shape before use; malformed input is rejected with a specific
   error, never silently coerced (an invalid `--level` value is the
   concrete MOD-009 example). Concrete case: a transcript line that looks
   almost like an acknowledgment statement but is missing the `because
   <reason>` clause must be rejected by the same regex `_detect_ack`
   already uses (§Verified-Fact Traceability Appendix), not loosely
   pattern-matched into a false positive.
2. **Execution failure** — a component that fails to spawn, fails its
   liveness check, or fails to write `settings.json` is reported as a
   named, specific failure — never swallowed into a generic "something
   went wrong." Concrete case: if `writeClaudeHookConfig()` fails to write
   `UserPromptSubmit` specifically (permissions, disk full, concurrent
   edit) while `PreToolUse` succeeds, the failure must name which of the
   two hooks failed — a install reporting blanket success with only half
   the wiring done is exactly how KD-07 went undetected for as long as it
   did.
3. **Module-level failure** — `preuninstall.js` failing partway must not
   leave `settings.json` half-merged (atomic read-modify-write, same
   pattern the existing `PreToolUse` merge already uses). Concrete case:
   if stripping the `UserPromptSubmit` entry succeeds but stripping
   `PreToolUse` throws, the file must not be left with only one hook
   removed — write the fully-modified document or leave the original
   untouched, nothing in between.
4. **Network/IPC failure** — the daemon socket being unreachable during
   any RPC call (`toolTick`, `pickPrompt`, `submitAck`) fails closed
   (hold), matching the existing documented posture in `client.js` — this
   task does not relax that. Concrete case: if the new Claude transcript
   detector (MOD-008) cannot reach the socket to hand off a detected
   statement, it must log the failure to its own error output and leave
   the statement in the ack log for the monitor to pick up on its own
   normal polling cycle, not silently drop it.
5. **System-level failure** — a partial install (daemon up,
   monitor/watchdog not) must be visibly reported as partial, with `ack
   doctor` able to diagnose exactly which of the three is missing.
   Concrete case: MOD-007's liveness check finding the daemon alive but
   the monitor dead must produce a distinct, named failure ("monitor not
   running — acknowledgments will not be credited") rather than a generic
   "installation may have issues" — the specific consequence (credits
   won't work) is exactly the information the person installing needs to
   decide whether to treat it as blocking.

## Testing / Verification

- Real `npm pack` + `npm install -g <tarball>` for every install-path
  test — actual bugs found tonight were only visible under real
  global-install conditions, never in isolated `node script.js` runs.
- `ps aux`, live `status` RPC calls, and direct file reads of
  `settings.json` and `ACK_ACK_LOG` — the exact verification pattern used
  live throughout this investigation.
- PHASE-2.5 specifically requires reproducing the full acknowledgment loop
  on Claude and confirming it behaves identically to the already-verified
  Hermes reference — not a unit test standing in for either.
- PHASE-2.7 specifically requires a real interactive run of the fixed
  habit creator with real answers, not a flags-only non-interactive smoke
  test — the gap being fixed is specifically in what gets asked.
- Real `npm uninstall -g`, never a simulated/dry-run cleanup.
- Every Known Defects Register entry (Part VII) that this blueprint claims
  to fix is verified closed by its specific PHASE-2 external-check, not by
  the corresponding PHASE-0/1 code deliverable alone — writing the fix and
  demonstrating the fix are two different checklist items, deliberately,
  so a real regression between "the code changed" and "the behavior
  changed" cannot hide behind a single checkbox.

## Per-Deliverable Test Protocol (PHASE-2, real commands)

Each PHASE-2 external-check below is the literal verification command (or
command sequence) that must be run and its real output pasted into the
Phase 2 review artifact — not a description of what the command would do.

**PHASE-2.1** (interactive default, no bypass):
```bash
npm pack && npm install -g ./drdeeks-character-kit-*.tgz
# Expect: stdout shows the interactive-pointer message naming `ack install`;
# `cat ~/.claude/settings.json | grep -c 'bin/ack.js'` returns 0 (nothing configured)
```

**PHASE-2.2** (bypass flag, full auto-configure):
```bash
ACK_YES=1 npm install -g ./drdeeks-character-kit-*.tgz
ps aux | grep -E 'agent_enforcer_daemon|ack_monitor|ack_watchdog' | grep -v grep
# Expect: 3 processes running
python3 -c "import json; d=json.load(open('$HOME/.claude/settings.json')); print('PreToolUse' in d.get('hooks',{}), 'UserPromptSubmit' in d.get('hooks',{}))"
# Expect: True True
```

**Design targets for new Phase 1 work** (stated explicitly so PHASE-2
external-checks have a real number to check against, not just "works"):
MOD-007's liveness poll retries at a 200ms interval for up to 5 attempts
(1 second total) before reporting failure — well inside `client.js`'s
existing 5000ms RPC timeout, so a liveness failure is never masked by a
slower, unrelated timeout firing first. MOD-008's transcript-read-to-log-
append path targets under 500ms per detected statement — fast enough that
a chatty session doesn't visibly stall on detection, verified by timing
the PHASE-2.5 reproduction.

**PHASE-2.3** (auth token live in daemon env):
```bash
DAEMON_PID=$(pgrep -f agent_enforcer_daemon.js)
tr '\0' '\n' < /proc/$DAEMON_PID/environ | grep ACK_AUTH_TOKEN
# Expect: a real token value present, not empty
# Then: send one RPC with a deliberately wrong token, confirm `{ "error": "unauthorized" }`
```

**PHASE-2.4** (hold terse, injection locational):
```bash
# Drive N tool calls (N = ACK_HOLD_EVERY_N_CALLS, default 5) through the
# Claude companion; on the Nth, capture the hold message verbatim.
# Expect: message body is exactly "state two habit names, and how they
# apply to the work you've been doing." -- 0 habit names, 0 file paths.
# Separately capture one UserPromptSubmit injection payload.
# Expect: a general locational phrase present, 0 literal filenames/paths.
```

**PHASE-2.5** (full Claude acknowledgment loop, end to end):
```bash
# 1. Trigger a hold (as in 2.4).
# 2. State a real "Habit: <real-name> resonates true because <specific
#    reason tied to actual current work>" in the chat.
# 3. tail -f $ACK_ACK_LOG -- confirm a new line appears matching the
#    statement.
# 4. Confirm ack_monitor.js's process log shows a submit_ack call.
# 5. Issue an 11th tool call (past the hold boundary) -- confirm it is
#    NOT held (hold was satisfied), matching the already-verified Hermes
#    behavior exactly.
```

**PHASE-2.6** (uninstall symmetry):
```bash
BEFORE=$(python3 -c "import json; d=json.load(open('$HOME/.claude/settings.json')); del d['hooks']; print(json.dumps(d,sort_keys=True))")
npm uninstall -g @drdeeks/character-kit
AFTER=$(python3 -c "import json; d=json.load(open('$HOME/.claude/settings.json')); del d.get('hooks',{}) and d or d; print(json.dumps(d,sort_keys=True))")
[ "$BEFORE" = "$AFTER" ] && echo "PASS: non-hooks keys byte-identical"
ps aux | grep -E 'agent_enforcer_daemon|ack_monitor|ack_watchdog' | grep -v grep
# Expect: 0 processes
```

**PHASE-2.7** (habit creator, all 5 fields, real answers):
```bash
ack habit create test-phase-2-7
# Answer interactively: prompt="Did I run the real test, not just read the code?",
# logic="A description of a test is not the test.",
# evidence="A specific evidence answer tied to this exact habit, not boilerplate",
# level="should"
cat .agent/habits/test_phase_2_7.yaml
# Expect: behavior.kind: "assertion" (not "standard"); evidence field
# matches what was typed, NOT "The agent applies this habit consistently
# and can state WHY when held." (the old hardcoded string)
```

## Glossary

Terms used throughout this document without re-defining them at each use:

- **Hold** — the daemon's `toolTick` returning `{hold: true}`, meaning the
  companion must block the next tool call until an acknowledgment is
  credited. Distinct from a **deny** (`executeTool` returning
  `{denied: true}`), which is permanent for that specific call, not
  something that clears on acknowledgment.
- **Tick** — one call to `toolTick`; each tick increments the per-session
  call counter that the hold-every-N-calls threshold is measured against.
- **Injection** — a `pickPrompt` response's habit prompts (name withheld,
  per Guiding Principle 2) being surfaced to the agent via
  `UserPromptSubmit`, intended to prompt the agent to go find and read the
  real habit file.
- **Nudge** — the vague locational hint (MOD-002) accompanying an
  injection — general enough to shorten a search, specific enough to not
  simply hand over the answer.
- **Acknowledgment / Ack** — the agent's own visible statement of the form
  `Habit: <name> resonates true because <reason>`, matching the format
  `HABIT_POLICY.md` §4 specifies.
- **Detect** — the act of a companion-side component (Hermes's
  `_detect_ack`, Claude's MOD-008 port) recognizing an acknowledgment
  statement in the agent's own output and appending it to the external ack
  log — explicitly NOT the same act as crediting it.
- **Credit** — the daemon's `submitAck` accepting a logged statement and
  clearing the hold ledger for that session. Only the root-owned monitor
  calls this — never the companion plugin itself, and never the agent's
  own process (this separation is the entire point of the 3-layer
  architecture in Part I/1.2's runtime diagram).
- **Companion** — a per-harness integration (the Claude hook handler, the
  Hermes plugin, etc.) that bridges a specific harness's own hook surface
  to the one daemon's RPC methods. Thin by design (Tech Stack table, 1.3)
  — enforcement logic lives in the daemon, not duplicated per companion.
  This is the architectural reason MOD-008 is a port, not a redesign: the
  daemon-side logic a companion talks to never changes between harnesses.
  A third companion added after this blueprint ships would need only its
  own thin bridge, not a new copy of `toolTick`/`pickPrompt`/`submitAck`.
- **Reuse-window guard** — `submitAck`'s rejection of an acknowledgment
  that repeats either of the session's last 2 acknowledged habit names, or
  reuses a prior ack's exact reason text — forces genuine variety, not
  ritual repetition (commit `1d3d776`).
- **Hard constraint vs. deny-list entry** — a `hard_constraint`
  (`constitution.yaml`) and a `deny` entry (`enforcer.yaml`) are checked
  together as one concatenated list by `executeTool()` (§4.3 step 1); the
  distinction is only which file a project author edits, not a difference
  in enforcement weight — both are equally unconditional.

## Known Defects Register

Per the document authority preamble's binding on FOREVER-SYSTEM.md §9
(known defects, reverified against current code rather than assumed
stale-but-true) and the `track_defects_openly` habit's own principle
("known defects are tracked openly as a named list... list the cracks;
don't hide them"): every gap this investigation found, whether this
blueprint fixes it or not, named explicitly rather than left implicit.

| # | Defect | Severity | Status | Fix Tracked As |
|---|---|---|---|---|
| KD-01 | Claude has no equivalent of Hermes's `_detect_ack()` — an agent can state a perfectly correct habit acknowledgment and nothing credits it | High — this is the actual dead-end an agent can hit with no way out | Fixed (CL-0005), MOD-008 verified live, 7 tests | MOD-008 / PHASE-1.4 |
| KD-02 | `ack habit create` hardcoded `evidence`, `enforcement.level`, and `behavior.kind` — silently, with no indication to the user that 3 of 5 fields were defaulted rather than asked. Confirmed the real, narrow defect: the CREATOR TOOL's output, verified by reading the code, not the bundled files it might have produced | Medium — produced valid but thin habits, not broken ones | Fixed (CL-0006): all 3 creation code paths (`ack.js`, `install.js` x2) collapsed into one shared `node/src/habits/build.js`, all 5 fields now required, `kind: "assertion"` always | MOD-009 / PHASE-1.5 |
| KD-03 | ~~19 of 40 bundled habits carry the generic boilerplate evidence string this thin creator produces~~ — **CORRECTED, this was false.** Direct verification (`grep` for the literal boilerplate string across all 40 files) found ZERO matches. The 17 files with `behavior.kind: "standard"` were re-read in full and carry genuinely specific, well-authored evidence/logic/assert text, not thin defaults — they were not produced by the thin creator tool despite sharing its `kind` label. Further verified `behavior.kind` is never functionally read anywhere in the runtime (daemon, character.js, ack.js) — it is pure documentation metadata with zero behavioral effect today. The original claim was an unverified inference (kind:"standard" + "creator writes kind:standard" ⇒ assumed these specific files came from that creator) never checked against the files' actual content. No backfill work exists to do. | N/A — the "defect" does not exist | Closed, not a defect (CL-0006) | N/A — was MOD-009 / PHASE-1.6, now removed |
| KD-04 | `ACK_AUTH_TOKEN` reached the daemon's process env only in root/systemd installs, not user-mode spawns — the auth gate was a no-op for most real installs | High — the design existed but didn't function for the common case | Fixed (CL-0005), verified via `/proc/<pid>/environ` on a live daemon + RPC accept/reject checks | MOD-006 / PHASE-1.2 |
| KD-05 | No liveness check after spawning daemon/monitor/watchdog — `spawn()` not throwing was treated as success | Medium — a process that died immediately after spawn was reported as a successful install | Fixed (CL-0005), verified with both a genuine partial-failure case and a fully-alive end-to-end case | MOD-007 / PHASE-1.3 |
| KD-06 | No `preuninstall.js` existed — `npm uninstall -g` left daemon/monitor/watchdog running and hooks registered in `settings.json` | High — package removal did not remove what the package installed | Fixed (CL-0004), 10 tests including a genuine end-to-end process kill | MOD-004 / PHASE-0.5 |
| KD-07 | `UserPromptSubmit` hook was not written by `writeClaudeHookConfig()` — only `PreToolUse` was, meaning habit injection may not have been wired for a fresh install even though the daemon-side rotation logic existed | High — half of the enforcement loop's wiring was missing at the config-write step | Fixed (CL-0004), verified against the real exported function | MOD-003 / PHASE-0.4 |
| KD-08 | Three daemon RPC methods (`execute_tool`, `reload`, `get_habit`) existed in the dispatch table with zero documentation anywhere in this blueprint through v2.0 | Low — a documentation gap, not a functional one; the methods work, they just weren't described | Fixed in this regeneration (§4.2, §4.3) |
| KD-09 | v2.0 of this document asserted `submit_ack` had "zero real callers," which was false | Low severity as code (nothing was broken), but a real defect in this document's own reliability — the exact failure mode Guiding Principle 1 exists to catch | Fixed in this regeneration (CL-0003) |
| KD-10 | A heavier acknowledgment-enforcement architecture (loop-enforcer chain, setuid kill-switch log, dual monitors with gridlock detection, ERC-8004-hosted habit DB) exists only as a design document, deliberately not built | Informational — not a defect, a recorded decision; listed here for the same reason KD-01 through KD-09 are: nothing about this system's real state should be implicit | N/A — explicitly out of scope; see `docs/agent-character-injection-design.md` at commit `0992bcc` |
| KD-11 | Three independent, near-identical implementations of habit-YAML-writing existed (`ack.js habit create`, `install.js createHabitDirect`, `install.js createHabit`), all three hardcoding the same defaults — a real "duplicated truth" violation per FOREVER-SYSTEM.md §1, discovered while implementing MOD-009, not present in the original scoping | Medium — three places to independently drift out of sync, exactly the failure mode single_source_of_truth.yaml and check_duplication_before_debug.yaml (both bundled habits) warn about | Fixed (CL-0006): collapsed into `node/src/habits/build.js`, all 3 call sites now use it | MOD-009 (expanded scope) |

## Done Criteria (7 concrete metrics, PROJECT tier)

| Criterion | Target |
|---|---|
| Interactive default | `npm install -g` with no bypass configures 0 components and prints the interactive-pointer message; `ACK_YES=1` reproduces today's behavior exactly |
| Component liveness | 3/3 (daemon, monitor, watchdog) confirmed alive via RPC/PID check before install reports success |
| Auth token live | `ACK_AUTH_TOKEN` present in the daemon's actual process environment; 1/1 mismatched-token request rejected |
| Locational nudge | Injection string contains a general locational hint, 0 literal habit names or file paths |
| Claude ack loop functional | 1/1 real "Habit: ..." statement produced live on Claude is detected, logged, credited, and lifts the hold — matching Hermes's already-verified behavior |
| Habit creator complete | 5/5 fields (name, prompt, logic, evidence, level) asked live at all 3 entry points, 0 hardcoded, 0 duplicate implementations remaining |
| Uninstall cleanup | 0 `character-kit`-matching processes, 0 dangling hook entries after 1 real `npm uninstall -g` |
| No regressions | `settings.json`'s non-`hooks` keys byte-identical before/after every install and uninstall test |
| Known defects closed | 8/8 open items in the Known Defects Register (KD-01 through KD-08; KD-09 and KD-10 are informational, not code defects) resolved by end of Phase 2, each with its resolving PHASE-N.M item named in this table's own row |

Each Done Criterion above maps to one or more `Type: external-check`
deliverables in Part VI — a criterion with no corresponding checklist item
would be an unenforceable claim, which Guiding Principle 7 exists
specifically to prevent.

## 4.4 Constitution & Policy File Shapes (VERIFIED — the actual inputs to §4.3's logic)

`constitution.yaml` and `enforcer.yaml` are the two files `executeTool()`
reads on every call (via `reload()`, §4.2). Documented here at full example
fidelity since §4.3 references their fields directly and no prior version
of this blueprint included their real shape.

**`<workspace>/.agent/constitution.yaml`** — loaded at t=0, before the LLM
and before any tool call; the agent can read it but not modify it:
```yaml
agent:
  id: string
  name: string
  purpose: string
core_values: string[]            # affirmative statements, re-surfaced by
                                  # the self-audit habit on every allowed
                                  # action (FOREVER-SYSTEM.md §6)
operational_standards: string[]
hard_constraints: string[]       # feeds executeTool()'s FIRST check —
                                  # concatenated with enforcer.yaml's `deny`
aspiration: string
```
The bundled example's `hard_constraints` includes "Never expose a
credential in a tool call," which is the same rule the `no-credential-leak`
habit (`behavior.kind: "guard"`, §Part I/1.5's habit-format discussion)
implements mechanically — the constitution states the value, the guard
habit enforces the pattern-match, and `executeTool()`'s hard-constraint
check is the third, code-level enforcement of the same rule. Three layers
stating the same constraint independently is intentional redundancy, not
duplication to collapse — FOREVER-SYSTEM.md §1's "singular source of truth"
applies to *implementations* of a capability, not to a value being
reinforced at multiple layers of the stack.

**`<workspace>/.agent/enforcer.yaml`** — the allow/deny policy `executeTool()`
reads directly:
```yaml
allow: string[]   # glob-ish patterns; tool name OR command string match.
                   # If non-empty, ONLY matching tools/commands pass —
                   # everything else is denied by default (§4.3 step 3).
                   # If empty/unset, this step is a no-op.
deny: string[]     # ALWAYS blocked, regardless of the allow-list —
                   # concatenated with constitution.yaml's hard_constraints
                   # and checked FIRST (§4.3 step 1), unconditionally.
```
The bundled example's `deny` list (`rm -rf /`, `git push --force`,
`curl * | sh`, `sudo *`) is the floor every workspace gets by default,
independent of whatever a specific project's `allow` list is scoped to —
this is the concrete mechanism behind the `safe-deletion-via-trash` habit's
own claim that "the daemon still hard-blocks `rm -rf /` as a floor."

## Verified-Fact Traceability Appendix

The direct implementation of Guiding Principle 1 ("verify, don't assume —
including this document's own prior claims"): every load-bearing factual
claim made anywhere above, paired with exactly where it was checked. Any
future amendment that changes one of these facts must update its entry
here in the same change — an untraceable claim is the failure mode CL-0003
exists to correct.

**Claim:** Search/read tools are unconditionally exempt from holds.
**Evidence:** `agent_enforcer_daemon.js:644-646` — `if (this.searchTools.has(tool)) return { hold: false };` runs before any count-based logic.

**Claim:** A hold fires every 5 tool calls by default.
**Evidence:** `agent_enforcer_daemon.js:194` — `this.holdEveryNCalls = _num("ACK_HOLD_EVERY_N_CALLS", "hold_every_n_calls", 5);` and `:654` — `st.count % this.holdEveryNCalls === 0`.

**Claim:** The hold message text is exactly "state two habit names, and how they apply to the work you've been doing."
**Evidence:** `agent_enforcer_daemon.js:686` (edited live this session; prior text was a longer, explicitly-rejected draft).

**Claim:** `ack_monitor.js`/`.py` and `ack_watchdog.js`/`.py` are real, non-stub implementations.
**Evidence:** Direct line counts: `deploy/ack_monitor.js` 154 lines, `deploy/ack_watchdog.js` 134 lines, `deploy/ack_monitor.py` 140 lines, `deploy/ack_watchdog.py` 139 lines — all committed, clean working tree (`git status --short deploy/` returns nothing).

**Claim:** `submit_ack` has real existing callers, contradicting v2.0's "zero real callers" claim.
**Evidence:** `ack_monitor.js`/`.py` call it directly (module docstring, `deploy/ack_monitor.js:1-16`); `hermes_plugin/__init__.py`'s docstring at the top of the file states the 3-layer design explicitly, and `_detect_ack()` (line 210) is the producer side of the log those monitors consume.

**Claim:** Hermes's `_on_pre_tool_call` hard-blocks the harness on a hold, not just a soft warning.
**Evidence:** `python/hermes_plugin/__init__.py:112-130` — returns `{"action": "block", "message": ...}` on `tick.get("hold")`, which is Hermes's own documented block contract for `pre_tool_call` hook returns.

**Claim:** `_detect_ack()`'s regex and its no-self-credit design are real and match the described behavior.
**Evidence:** `python/hermes_plugin/__init__.py:210-234` — `re.findall(r"habit:\s*\S+\s+resonates\s+true\s+because\s+.+", text, re.I)`, appends to `ack_log` path from `_load_config()`, explicit docstring: "The plugin does NOT credit the daemon directly: that would let the agent's own process forge acknowledgments."

**Claim:** `_detect_ack` runs on every turn via `_on_pre_llm_call`, not just on demand.
**Evidence:** `python/hermes_plugin/__init__.py:353-354` — `_detect_ack(session_id, user_message)` is the first line of `_on_pre_llm_call`'s body, called unconditionally before the injection-disabled check.

**Claim:** `ack habit create` only asks for name/prompt/logic and hardcodes the rest.
**Evidence:** `node/bin/ack.js`, `habitCmd.command("create")` handler — `opts.prompt || await ask(...)` and `opts.logic || await ask(...)` are the only two `ask()` calls; `evidence`, `enforcement.level`, and `behavior.kind` are written as fixed literals in the template array with no corresponding option or prompt.

**Claim:** 39 of 40 bundled example habits already phrase `prompt` as a question; `safe-deletion-via-trash.yaml` was the one violation, now fixed.
**Evidence:** Direct read of all 40 files in `node/examples/.agent/habits/*.yaml` this session; the one non-question prompt was corrected live to `"Am I about to delete something instead of moving it to .trash/ at project root?"`, sourced from that file's own pre-existing `# Source question:` comment.

**Claim:** `behavior.kind: "standard"` habits share a hardcoded generic evidence string; `"assertion"` habits carry specific, per-habit evidence.
**Evidence:** Direct read of all 40 files; `"standard"`-kind habits' evidence text matches or closely paraphrases `ack habit create`'s hardcoded template string, while `"assertion"`-kind habits' evidence is unique per file and specific to that habit's actual concern.

**Claim:** `"guard"` kind (e.g. `no-credential-leak.yaml`) is a genuinely distinct schema, not a third spelling of the same thing.
**Evidence:** `node/examples/.agent/habits/no-credential-leak.yaml` — uses `correct_action`, `steps`, and a `patterns`/`require_assignment` block with no `assert`/`logic` fields at all, structurally different from both `"standard"` and `"assertion"`.

**Claim:** A heavier acknowledgment-enforcement design was proposed and explicitly, deliberately rejected — not simply never considered.
**Evidence:** Commit `0992bcc`, `docs/agent-character-injection-design.md` (205 lines, not in the current tree — read via `git show 0992bcc:docs/agent-character-injection-design.md`), §4 header verbatim: "Explicitly NOT Built (the heavy system — decided against)."

**Claim:** The "loop-enforcer chain" named in that rejected design is the same `loop-enforcer` skill referenced elsewhere in this project's governance.
**Evidence:** `docs/agent-character-injection-design.md` §4 lists "loop-enforcer chain (sequential 'can't acknowledge #2 before #1')" among the rejected components; `FOREVER-SYSTEM.md` §1 separately names `loop-enforcer` as a skill whose useful mechanics may be folded into ACK's own runtime rather than run as a parallel implementation — same name, same underlying concern, two independent documents.

**Claim:** The variable-closer acknowledgment format (`resonates true` / `why:` / `because` / etc.) and the reuse-window guard are real, committed, and predate this session.
**Evidence:** Commit `1d3d776`, "Ack format: variable closer + enforced engaged reason" — `HABIT_POLICY.md` §4 documents the grammar; `agent_enforcer_daemon.js`'s `submitAck` implements the reuse check against `lastTwo` and prior `reasons`.

**Claim:** The habit system was renamed from "identity" to "character," not built as two separate systems.
**Evidence:** Commit `f8b106a`, "rename: agent-identity-kit -> agent-character-kit (character, not identity)" — same repository, same history, prior name confirmed by the commit message itself.

**Claim:** `executeTool`'s hard-constraint check runs before, and cannot be overridden by, the allow-list step.
**Evidence:** `agent_enforcer_daemon.js:266-298` — hard-constraint deny patterns are checked and can `return` before the allow-list block (`if (Array.isArray(this.policy.allow)...)`) is ever reached in the function body's control flow.

**Claim:** `git commit` is structurally exempt from the allow-list, not merely expected to usually pass.
**Evidence:** `agent_enforcer_daemon.js:290-294` — the `isCommit` regex check and its early `return { denied: false, commit_intent: true }` sit between the hard-constraint check and the allow-list check, meaning no `policy.allow` configuration, however restrictive, can block a genuine commit.

**Claim:** `reload()`'s `character_hash` is a real, computed value, not a placeholder.
**Evidence:** `agent_enforcer_daemon.js:254-263` — `this._hash(JSON.stringify({c: this.constitution, h: this.habits, p: this.policy}))`, recomputed from freshly reloaded disk state on every call.

**Claim:** The bundled `enforcer.yaml` example's `deny` list is what backs the `safe-deletion-via-trash` habit's claim that `rm -rf /` is hard-blocked as a floor, independent of any project-specific `allow` list.
**Evidence:** `node/examples/.agent/enforcer.yaml` — `deny: ["rm -rf /", "git push --force", "curl * | sh", "sudo *"]`, checked unconditionally by `executeTool()` (§4.3 step 1) before the allow-list is ever consulted.

---

---

# CHANGE LOG

> This section is append-only. No entry may be modified or deleted.

## CL-0000 — Document Initialization

```
Date        : 2026-08-07
Contributor : claude-code-session
Modules     : [MOD-001, MOD-002, MOD-003, MOD-004]
Section Tags: [[PHASE-0-v1]]
Files Changed: [blueprint.md, checklist.md]
Description : Initial blueprint created via enterprise-blueprint skill after a
              multi-hour live investigation (git history, not assumption) found
              four confirmed gaps in @drdeeks/character-kit's install/enforce/
              uninstall lifecycle. MOD-001 (postinstall visible output) was
              already implemented and verified live tonight before this
              blueprint existed; the remaining three were the active work.
Tests Passing: none — pre-build
Phase       : PHASE-0
Rollback Ref: N/A — initial document creation
```

## CL-0001 — Scope correction (reviewer feedback)

```
Date        : 2026-08-07
Contributor : claude-code-session (correction from drdeeks review)
Modules     : [MOD-005, MOD-006, MOD-007, MOD-008]
Section Tags: [[SYS-OVERVIEW-v1], [MODULE-REGISTRY-v1], [PHASE-0-v1], [PHASE-1-v1]]
Files Changed: [blueprint.md]
Description : v1.0 fixed postinstall's OUTPUT without verifying the mechanisms
              underneath it. Reviewer identified two concrete gaps by reading
              actual behavior, not the blueprint's claims: (1) npm install -g
              should default to an interactive setup asking agent count/
              harness/location, bypassable with -y, not silently auto-
              configure by default; (2) the blueprint never mentioned whether
              daemon/monitor/watchdog liveness is verified, whether the auth
              mechanism actually works, or whether the chat-monitoring loop
              discussed earlier in the same session was tracked as real
              work — all three were confirmed missing or broken by directly
              reading install.js's spawn calls (ACK_AUTH_TOKEN never reaches
              the daemon's env in user-mode installs) rather than assumed.
              Added MOD-005 through MOD-008 and the corresponding checklist
              items to cover the real scope.
Tests Passing: none — pre-build
Phase       : PHASE-0
Rollback Ref: N/A — documentation amendment, no code changed by this entry
```

## CL-0002 — Tier escalation TASK → PROJECT (reviewer feedback)

```
Date        : 2026-08-07
Contributor : claude-code-session (correction from drdeeks review)
Modules     : [MOD-001 through MOD-008]
Section Tags: [[SYS-OVERVIEW-v1], [MODULE-REGISTRY-v1], [SPECS-v1], [DATA-ARCH-v1]]
Files Changed: [blueprint.md]
Description : Reviewer correctly identified that Part I's High-Level
              Architecture was a 13-line arrow chain, not real architecture
              documentation, and that TASK tier's lighter bar no longer
              matched the real scope (8 modules spanning install, runtime
              enforcement, and uninstall, including two newly-discovered
              subsystem-level gaps). Per blueprint-standard.md §1, PROJECT is
              the default tier and TASK is an explicit opt-down — this
              project's actual scope does not qualify for that opt-down.
              Re-initialized at --scope project with 3 real phases (Foundation
              & Quick Fixes / Enforcement Loop & Verification / Testing &
              Hardening, chosen over the generic 7-phase enterprise template
              because this repair has no auth/identity or launch/live-ops
              phase to speak of). Rewrote Part I in full: real 100+ line
              box-drawing architecture diagram covering install, runtime
              enforcement, and uninstall layers; added the previously-missing
              1.4 Guiding Principles and 1.5 Components Involved subsections
              (both required at every tier, neither was present in v1.0/v1.1);
              expanded Part III to 3 real feature specs; documented Part IV's
              JSON/JSONL state shapes and the full RPC method table with the
              same rigor a SQL schema would get, given this system has no
              relational database (Part IV's data-schema requirement is a
              WARN not a FAIL when genuinely inapplicable, per §14, so this
              is honest documentation rather than an invented database).
Tests Passing: none — pre-build
Phase       : PHASE-0
Rollback Ref: N/A — documentation amendment, no code changed by this entry
```

## CL-0003 — Full regeneration: MOD-008 correction, MOD-009 addition, verified Hermes reference architecture

```
Date        : 2026-08-07
Contributor : claude-code-session (direct instruction from drdeeks: "regenerate
              the blueprint," following a live conversation covering the
              acknowledgment-enforcement mechanism, the habit-format duality,
              and a rejected heavier design from project history)
Modules     : [MOD-001 through MOD-009]
Section Tags: [[SYS-OVERVIEW-v2], [MODULE-REGISTRY-v2], [SPECS-v2],
               [DATA-ARCH-v2], [PHASE-0-v2], [PHASE-1-v2], [PHASE-2-v2]]
Files Changed: [blueprint.md]
Description : A second, deeper live investigation — prompted by direct
              questions about whether the acknowledgment mechanism actually
              enforces anything and where a habit-creation flag from project
              history went — found that MOD-008's core claim in v2.0 ("zero
              real callers of submit_ack") was false. Direct reads of
              deploy/ack_monitor.js, deploy/ack_monitor.py, and
              python/hermes_plugin/__init__.py confirmed a complete, real,
              already-working detect→log→credit acknowledgment loop exists
              for the Hermes companion: _detect_ack() regex-matches a real
              habit statement out of the agent's own pre_llm_call message
              text, appends it to an external ack log, and the root-owned
              monitor (never the agent's own process) is the only thing that
              credits the daemon — confirmed by python/hermes_plugin's own
              docstring and verified against the actual regex/write code, not
              inferred. MOD-008 is corrected from "build a chat-transcript
              monitor from scratch" to "port a proven, working pattern to a
              second harness" — a narrower, more accurately-scoped task.
              Separately, an audit of all 40 bundled example habits (prompted
              by a direct correction that habit prompts must always be
              phrased as questions — 39/40 already were; the one violation,
              safe-deletion-via-trash.yaml, was corrected live) surfaced a
              real, present split: ~19 habits carry behavior.kind: "standard"
              with generic, identical boilerplate evidence text, while ~19
              carry kind: "assertion" with specific, non-generic evidence.
              Root-caused by reading node/bin/ack.js's `habit create` handler
              directly: it only ever asks for name/prompt/logic, and
              hardcodes evidence, enforcement.level, and behavior.kind for
              every habit regardless of content. Added as new MOD-009 with
              its own feature spec, module registry entry, and Phase 1/2
              checklist items (creator fix + backfill of the 19 thin habits).
              Also incorporated, for continuity and explicitly kept out of
              scope: a heavier acknowledgment-enforcement design (loop-
              enforcer chain, setuid kill-switch log, dual monitors with
              gridlock detection, ERC-8004-hosted habit DB) found in
              docs/agent-character-injection-design.md at commit 0992bcc,
              deliberately rejected in project history in favor of the
              lightweight pattern now confirmed working — referenced in Part
              I's architecture diagram and Guiding Principle 8, not specified
              as work. Regenerated Part I's architecture diagram to show the
              Claude (repair target) and Hermes (verified working reference)
              runtime paths side by side, added the new Habit Authoring Layer
              diagram block, added FEAT-004 to Part III, added three
              previously-undocumented RPC methods (execute_tool, reload,
              get_habit) to Part IV as a Phase 0 documentation task, and
              added PHASE-2.7 to verify MOD-009 live. This entry, and the
              document version bump to 3.0, exist specifically so the
              correction itself — not just the new content — is part of the
              permanent record, per Guiding Principle 1.
Tests Passing: none — pre-build
Phase       : PHASE-0
Rollback Ref: N/A — documentation amendment; the two code changes referenced
              (postinstall.js say/warn helpers, daemon hold-message text)
              were made and verified live earlier in the same session, prior
              to and independent of this document regeneration
```

## CL-0004 — Phase 0 implementation: MOD-002, MOD-003, MOD-004

```
Date        : 2026-08-07 07:50 UTC
Contributor : claude-code-session
Modules     : [MOD-002, MOD-003, MOD-004]
Section Tags: [[PHASE-0-v2]]
Files Changed: [node/src/hooks/character.js, node/bin/install.js,
                node/bin/preuninstall.js (new), node/tests/install.test.js,
                node/tests/preuninstall.test.js (new), package.json]
Description : Implemented the three remaining real Phase 0 deliverables.
              MOD-002: pickHabitPrompts() now appends a locational nudge to
              every injection ("these live somewhere in your own
              workspace's hidden agent configuration -- go find the real
              file before you cite one"). The first draft used the phrase
              "by name," which would have violated an existing test
              asserting the injected context never contains the word
              "name" (case-insensitive) -- caught by actually running the
              suite before considering this done, not by inspection alone,
              and fixed before landing. MOD-003: writeClaudeHookConfig()
              was writing only PreToolUse; it now writes UserPromptSubmit
              too, using the exact same command string (ack.js already
              routes on hook_event_name at runtime, confirmed by direct
              read before implementing, so no new dispatch logic was
              needed -- only the missing write). Both functions were
              exported (matching the existing resolveSocket/
              discoverAgentWorkspaces convention in install.test.js) and a
              real test added that imports and calls the actual exported
              function against a temp HOME, not a reimplementation of the
              logic -- confirms unrelated settings.json keys survive and
              re-running install doesn't duplicate entries. MOD-004: new
              preuninstall.js, mirroring postinstall.js's scoping guards
              exactly. Kills the daemon via process-pattern match (it
              writes no PID file, confirmed in the Known Defects Register
              investigation), monitor/watchdog via PID file with a
              pattern-match fallback if the PID was reused by an unrelated
              process since the file was written (a real defensive check,
              not just "trust the file"). Strips both ack.js-marked hook
              entries from settings.json using the identical marker
              writeClaudeHookConfig writes, leaving everything else in the
              file untouched, and leaves a file it can't parse alone
              rather than guessing. Registered as npm's preuninstall
              lifecycle script in package.json. 10 new tests include one
              genuine end-to-end case: spawns a real child process with a
              unique marker in its actual command line, confirms
              listProcesses() finds it for real, confirms killByPattern
              actually terminates it (checked via process.kill(pid, 0)
              throwing, not by trusting the function's return value).
Tests Passing: node/tests/character.test.js (9/9), node/tests/install.test.js
              (6/6), node/tests/preuninstall.test.js (10/10, new), full repo
              suite via `npm test` (28/28, 0 regressions across all six
              test files)
Phase       : PHASE-0
Rollback Ref: git diff against the commit prior to this entry; each of the
              three deliverables touches a disjoint set of files and can be
              reverted independently (per this phase's Rollback Procedure)
```

## CL-0005 — Phase 1 implementation: MOD-005, MOD-006, MOD-007, MOD-008

```
Date        : 2026-08-07 08:52 UTC
Contributor : claude-code-session
Modules     : [MOD-005, MOD-006, MOD-007, MOD-008]
Section Tags: [[PHASE-1-v2]]
Files Changed: [node/bin/postinstall.js, node/bin/install.js,
                node/src/hooks/character.js, node/src/index.js,
                node/tests/postinstall.test.js (new), node/tests/install.test.js,
                node/tests/character.test.js]
Description : MOD-005: postinstall.js now defaults to an interactive-pointer
              message and configures nothing unless ACK_YES=1. Verified via
              real subprocess spawns against a fake global node_modules
              install -- an initial symlinked fixture produced silent zero
              output because import.meta.url resolves through symlinks to a
              path with no node_modules component, breaking the existing
              global-install guard; switched to a real file copy, matching
              what npm actually does on a real install.
              MOD-006: before touching anything, read the daemon's explicit
              "do NOT auto-load ACK_AUTH_TOKEN" security comment in full --
              it forbids the daemon PASSIVELY loading the token from a .env
              file (would self-gate against any client with a different
              .env), not the token arriving via spawn-time LAUNCH env, which
              the same comment explicitly endorses. The token was being
              generated and written to the client's .env but never added to
              the `vars` object used for the actual daemon/monitor/watchdog
              spawn -- fixed narrowly, verified by reading the real token
              out of /proc/<pid>/environ on a live spawned daemon, plus
              RPC-level correct/wrong/missing-token checks.
              MOD-007: new verifyLiveness() -- 200ms interval, up to 5
              attempts, real PID check + real status RPC round-trip before
              install.js reports success. A liveness failure now throws
              (previously spawn() not throwing was silently treated as
              "done"), correctly propagating into postinstall.js's failure
              path too. Verified with both a genuine partial-failure case
              (daemon alive and answering, monitor/watchdog PIDs dead) and a
              fully-alive end-to-end case, all real spawned processes.
              MOD-008: ported hermes_plugin's verified-working _detect_ack()
              pattern to Claude. Verified the real Claude Code transcript
              JSONL schema against an actual transcript file on this
              machine before writing anything (not assumed):
              {type:"assistant", message:{role, content:[{type:"text",
              text},...]}}. Deliberately broader than a literal Hermes
              port: Hermes's regex only matches the "resonates true
              because" closer, but the daemon's real submitAck() grammar
              accepts four more (why: / because / matters because /
              applies because) -- a straight port would have silently
              missed valid acknowledgments using those. Used the daemon's
              actual acceptance regex instead. Only scans the most recent
              assistant turn, confirmed an old acknowledgment several turns
              back does not get re-detected on every later turn.
Tests Passing: 11 install.test.js, 3 postinstall.test.js (new), 16
              character.test.js (7 new). Full repo suite: 43/43, zero
              orphaned processes after any test run.
Phase       : PHASE-1
Rollback Ref: each MOD's files can be reverted independently; git diff
              against the commit prior to this entry
```

## CL-0006 — Phase 1 implementation: MOD-009, expanded scope (KD-11), and a self-correction (KD-03)

```
Date        : 2026-08-07 08:52 UTC
Contributor : claude-code-session
Modules     : [MOD-009]
Section Tags: [[MODULE-REGISTRY-v2], [SPECS-v2], [PHASE-1-v2]]
Files Changed: [node/src/habits/build.js (new), node/bin/ack.js,
                node/bin/install.js, node/tests/habits-build.test.js (new),
                node/tests/habit-create.test.js, .blueprint/blueprint.md]
Description : Implementing MOD-009 surfaced a real gap in this document's
              own prior diagnosis, in both directions -- one expansion, one
              retraction, neither assumed, both verified before acting.
              EXPANSION (KD-11): while fixing ack.js's habit create
              handler, discovered install.js contains TWO MORE independent
              implementations of the exact same YAML-writing logic
              (createHabitDirect for --create-habit, and createHabit for
              the interactive `ack install` wizard) -- both hardcoding the
              identical defaults ack.js's version did. Three independent
              copies of one capability is a direct FOREVER-SYSTEM.md §1
              violation this project's own governance names explicitly.
              Collapsed all three into node/src/habits/build.js
              (normalizeHabitName, buildHabitYaml, VALID_LEVELS) rather
              than patching each site separately -- fixing three call
              sites independently would have left the underlying
              duplication in place, just with three copies of the FIXED
              defaults instead of three copies of the broken ones.
              RETRACTION (KD-03): before starting the originally-planned
              "backfill 19 thin habits" step, ran the actual verification
              first instead of executing the plan as written -- grep for
              the literal hardcoded evidence string across all 40 bundled
              habits returned ZERO matches. Read two of the 17
              kind:"standard" files in full: both carry genuinely specific,
              well-authored evidence and logic text, not thin defaults.
              Further checked whether behavior.kind is read anywhere in
              the runtime at all (daemon, character.js, ack.js) -- it is
              not; it's pure documentation metadata with zero functional
              effect today. The original KD-03 claim was an unverified
              inference chained from two true facts (kind:"standard" exists
              on these files; the thin creator writes kind:"standard") into
              a third, never independently checked (therefore these
              specific files came from that creator). PHASE-1.6 removed;
              no code was written to "fix" something that wasn't broken.
              This is the second self-correction in this document's history
              (after CL-0003's MOD-008 correction) and both are handled the
              same way: found, verified, recorded openly, never quietly
              absorbed into a rewritten claim with no trace of having been
              wrong.
Tests Passing: 5 habits-build.test.js (new), habit-create.test.js updated
              (adds a required-field-rejection case) + all existing
              assertions strengthened to check kind:"assertion" and real
              evidence text, not just file existence. Full repo suite:
              48/48, zero regressions, zero orphaned processes.
Phase       : PHASE-1
Rollback Ref: git diff against the commit prior to this entry; reverting
              requires reverting build.js + ack.js + install.js together
              (see this phase's Rollback Procedure item 3) or the three
              entry points disagree again
```

## CL-0007 — MOD-005 correction: postinstall must never configure, under any signal

```
Date        : 2026-08-07 17:35 UTC
Contributor : claude-code-session
Modules     : [MOD-005]
Section Tags: [[MODULE-REGISTRY-v2], [SPECS-v2]]
Files Changed: [node/bin/postinstall.js, node/bin/ack.js,
                node/tests/postinstall.test.js,
                node/tests/ack-configure.test.js (new), .blueprint/blueprint.md]
Description : Direct user correction of CL-0005's MOD-005 design. The
              ACK_YES=1 bypass (postinstall auto-configuring when that env
              var was set before `npm install -g`) was itself still a form
              of "install sometimes also configures" -- install and
              configure must be two fully separate, deliberate actions,
              with zero exceptions, matching the standard package-manager
              pattern (install via npm/apt/brew, then a separate `configure`
              step -- e.g. `aws configure`). Removed the ACK_YES mechanism
              from postinstall.js entirely; it now unconditionally only
              installs and prints next-step guidance, never configures.
              Renamed the `install` command to `configure` (`ack.js`),
              keeping `install` as a Commander .alias() for backward
              compatibility with the published v1.2.1 CLI. While making
              this change, found and fixed a real, previously untested bug:
              ack.js's configure/install action handler force-appended
              "--yes" onto every invocation of install.js regardless of
              whether the user passed --yes, meaning the true interactive
              wizard path inside install.js (which does exist, gated on
              opts.yes, using readline) was unreachable through the CLI --
              `ack configure` without --yes silently ran non-interactively
              every time. Fixed by removing the hardcoded append and
              trusting the already-correctly-computed flags array. Added
              ack-configure.test.js: a real end-to-end spawn of the actual
              ack.js CLI binary (not install.js directly, which every other
              test already covers) proving `ack configure --yes` reaches
              install.js and starts a real, live daemon process.
Tests Passing: 50/50 (was 48/48; +2 new in ack-configure.test.js), stable
               across repeated runs
Rollback Ref: git diff against the commit prior to this entry
```

## CL-0008 — Real Phase-2-adjacent testing surfaced 4 genuine bugs, all fixed and live-verified

```
Date        : 2026-08-07 19:20 UTC
Contributor : claude-code-session
Modules     : [MOD-005, MOD-006, MOD-007]
Section Tags: [[MODULE-REGISTRY-v2], [SPECS-v2], [PHASE-2-v2]]
Files Changed: [node/src/hooks/character.js, node/bin/install.js,
                node/enforcer/agent_enforcer_daemon.js,
                node/tests/character.test.js, node/tests/ack-configure.test.js,
                .blueprint/blueprint.md]
Description : Began real PHASE-2.1/2.2 external-check testing against the
              actual global install (not just isolated tmp-workspace test
              fixtures) at drdeek's direct request after credit-budget
              pressure made "verify it for real now, not later" the
              explicit priority. This surfaced four genuine, previously
              undetected bugs -- each found by actually running the
              system, not by reading the code:

              BUG 1 (severe): PreToolUse fails closed when the enforcer is
              unreachable (deliberate, correct design -- "a guard that
              fails open is no guard"). But this created a real deadlock:
              the commands needed to RESTART an unreachable daemon are
              themselves tool calls, blocked by the very daemon they're
              trying to fix. Hit this live three separate times in one
              session, each requiring a manual daemon restart from OUTSIDE
              the session (the in-session agent had zero working tools).
              Fixed with a narrow "break glass" allowlist
              (BOOTSTRAP_COMMAND_RE in character.js's processToolCall):
              commands matching the daemon/monitor/watchdog script paths or
              `ack doctor|repair|status|configure|install` skip the
              enforcer round-trip entirely, working even when the daemon
              is fully down. Does not weaken fail-closed for anything else.

              BUG 2: launchDaemon() had no liveness check -- a second
              `ack configure --yes` against an already-configured
              workspace spawned a SECOND daemon that stole the unix socket
              from the first via unlink+rebind (confirmed live via lsof:
              two LISTEN fds on the same path, different inodes). The
              original was left running but unreachable. Fixed by pinging
              the target socket before launching; reuse if alive.

              BUG 3: the fix for BUG 2 didn't work at first because
              ACK_AUTH_TOKEN was crypto.randomUUID()'d fresh on every run
              with no attempt to read an existing one -- the reuse-ping
              used a token that didn't match what the running daemon was
              actually launched with, auth-failed, and silently fell
              through to spawning a duplicate anyway. Fixed by reading
              ACK_AUTH_TOKEN from the workspace's existing .env first.

              BUG 4 (systemic, found opportunistically): nearly every test
              file in this repo that spawns a real daemon/monitor/watchdog
              cleans up via `pkill -f <workspace-tmpdir>` -- which can
              never match, because AGENT_WORKSPACE only ever reaches the
              child process as an environment variable, never a literal
              CLI argument, and pkill -f only matches argv. This had been
              silently leaking orphaned processes across every test run,
              all session, undetected until `ps aux` was checked directly
              during BUG 2/3 investigation (dozens of orphans found at
              once). Fixed in the two ack-configure.test.js tests that
              actually spawn real processes, using /proc/<pid>/environ
              scanning (the same real technique MOD-006's tests already
              used). NOT yet fixed in install.test.js or
              preuninstall.test.js -- same bug likely present there too;
              out of scope for tonight, flagged below as KD-13.

              Live-verified end to end on the real global install (not
              just isolated fixtures): repacked and reinstalled the fixed
              package globally, ran `ack configure --yes` for real,
              confirmed settings.json gained both real Claude hooks,
              confirmed the daemon answered a real status RPC, deliberately
              killed the real daemon and confirmed the self-lockout
              (proving BUG 1 was real before the fix), recovered manually,
              reinstalled the fixed package, and confirmed 3/3 new unit
              tests plus the full 54/54 suite pass, with zero orphaned
              processes after a full run.
Tests Passing: 54/54 (was 50/50 before tonight's Phase-2 testing began),
               stable, zero orphaned processes confirmed via ps aux
Rollback Ref: git diff against the commit prior to this entry -- four
              separate commits, each independently revertable:
              f46ae88 (BUG 1), 9eeef3c (BUG 2), 594031c (BUG 3),
              fa269dc + 043a5eb (BUG 4, partial)
```

## Known Defects Register — addendum (2026-08-07, post-CL-0008)

- **KD-12**: `install.test.js` and `preuninstall.test.js` likely have the
  same `pkill -f <workspace>` cleanup bug documented in CL-0008's BUG 4 --
  not yet verified or fixed. Check for orphaned processes via `ps aux`
  after running each file in isolation; if found, apply the same
  `/proc/<pid>/environ` scan used in `ack-configure.test.js`.
- **KD-13**: PHASE-2.1 and PHASE-2.2's checklist item text still describes
  the pre-CL-0007 `ACK_YES` bypass flow. Needs rewording to `ack configure`
  / `ack configure --yes` before those items can be honestly checked off.
- **KD-14**: The `--all` install flag (root mode, all components) still
  defaults harness to `opts.harness || "generic"` with no auto-detection,
  unlike the plain `--yes` path fixed tonight. Not confirmed broken --
  `--all`'s own contract never claimed auto-detection -- but worth an
  explicit decision on whether it should match the `--yes` path's behavior
  now that they've diverged.

## Known Defects Register — addendum (2026-08-07, operational lesson)

- **KD-15**: The break-glass bypass (CL-0008, BUG 1) matches both the bare
  `agent_enforcer_daemon.js` script path AND `ack configure`. Every manual
  recovery performed during tonight's testing used the bare script path --
  which starts the daemon with NO monitor and NO watchdog, since those are
  only spawned by `ack configure`'s own flow. This meant every
  manually-recovered daemon tonight ran completely unsupervised: if it died
  again (cause undetermined -- no crash trace in its log, and no permission
  to check kernel OOM logs to confirm or rule out a hard kill), nothing
  would have caught it. Not a defect in the watchdog itself -- a defect in
  always recommending the narrowest possible recovery command instead of
  the one that restores full supervision. **Going forward: recovery must
  always be `ack configure --yes` (or `ack repair`, once that path is
  audited to confirm it also restores monitor/watchdog), never the bare
  daemon script.** Verified live: killing the unsupervised daemon and
  recovering via `ack configure --yes` correctly produced a full
  daemon+monitor+watchdog trio.

## Known Defects Register — addendum (2026-08-07, root-mode never actually usable)

- **KD-16**: `agent_enforcer_daemon.js` has two independent, both-live
  implementations of unix-socket creation and permission-setting
  (`startSocketServer` for single-workspace, `startMultiWorkspaceDaemon` for
  multi-workspace) that had drifted into the identical wrong permission
  scheme (0600/0700, owner-only -- see the fix above). Both are now fixed
  identically, but the duplication itself is unresolved: any future socket
  hardening change has to be applied twice, in two places, or they will
  drift apart again. A proper fix collapses both into one shared
  `bindSocket(server, path)` helper. Not done tonight -- flagged as its own
  item since touching daemon startup twice, this late in a long session,
  was already enough real risk without also refactoring the call sites.

## CL-0009 — Real privilege-mode gap: interactive wizard never actually asked, root-mode's socket was unusable

```
Date        : 2026-08-07 20:15 UTC
Contributor : claude-code-session
Modules     : [MOD-005]
Section Tags: [[MODULE-REGISTRY-v2], [SPECS-v2]]
Files Changed: [node/enforcer/agent_enforcer_daemon.js, node/bin/install.js,
                deploy/deploy-agent-enforcer.sh, deploy/deploy-ack-services.sh,
                AGENTS.md, .blueprint/blueprint.md]
Description : Direct user challenge: "you could still bypass, still fuck
              around and get rid of it" -- pointed out that user-mode's
              same-uid weakness had never actually been surfaced as a real
              setup decision, and asked for a real 3-way choice (system
              service / dedicated user / trust-the-agent) instead of a
              silent default. Tracing the actual privilege model to answer
              it properly surfaced a deeper, pre-existing bug: the
              daemon's unix socket was locked to 0600 (owner-only), which
              means root-mode -- already built, already the "strong"
              option -- was never actually usable, since a non-root agent
              physically cannot connect to an owner-only root-owned
              socket. Root-mode's entire stated purpose ("agent can use
              it, can't tamper with it") could not have worked as coded.

              Fixed the socket to 0660/2750 (group-restricted via a new
              shared `ack-clients` group) instead of owner-only --
              ACK_AUTH_TOKEN stays the actual authorization gate, group
              access only grants a raw connection. Found and fixed the
              identical bug duplicated in a second, independent
              socket-server implementation (startMultiWorkspaceDaemon) --
              logged as KD-16, not collapsed into one shared helper this
              session (too invasive a refactor this late).

              Added the real third option: a dedicated, unprivileged
              service user (default `ack-enforcer`), generalizing both
              deploy scripts (deploy-agent-enforcer.sh,
              deploy-ack-services.sh) from hardcoded root:root to a
              configurable ACK_SERVICE_USER, with user/group creation and
              client-group wiring. Rewrote the interactive wizard's binary
              root/no-root question into the actual 3-way prompt with real
              recommendations (system service = recommended, dedicated
              user = recommended if root is undesired, trust-the-agent =
              highly not recommended, explicitly labeled as such).
Tests Passing: 54/54 unchanged (this work adds new interactive/deploy-time
               code paths not exercised by the existing automated suite --
               see Known Defects below)
Rollback Ref: git diff against the commit prior to this entry -- 5 separate
              commits: 7031b05 (socket fix), ee9bdec (KD-16 doc),
              bfdfef8 (deploy scripts), b8a5823 (wizard), 7727221 (docs)
```

## Known Defects Register — addendum (2026-08-07, CL-0009 verification gap)

- **KD-17**: None of CL-0009's privilege-mode work has been live-verified
  end to end. This session has no sudo access (password required, no TTY
  to provide one), so `useradd`, the systemd unit deployment, and the
  actual cross-uid socket connection have only been syntax-checked
  (`bash -n`, `node --check`), never run for real. A human with real sudo
  access needs to run all three interactive-wizard paths
  (`ack configure`, choosing 1/2/3) and confirm: the service user gets
  created correctly, the agent can actually connect to the socket after
  the group-membership refresh, and the agent genuinely cannot kill/edit
  the daemon in modes 1/2.

## CL-0010 — Live root-mode deployment findings: real gaps found by drdeek's actual sudo test

```
Date        : 2026-08-07 21:00 UTC
Contributor : claude-code-session
Modules     : [MOD-005]
Section Tags: [[MODULE-REGISTRY-v2], [SPECS-v2]]
Files Changed: [.blueprint/blueprint.md only -- see "Files NOT yet changed" below]
Description : drdeek ran CL-0009's privilege-mode work for real, with real
              sudo, choosing root-mode. This surfaced real, previously
              undiscovered gaps that KD-17 (CL-0009) had already flagged as
              unverified. None of the following were fixed in this entry --
              this is the discovery record; fixes are tracked as KD-18
              through KD-23 below and are the next session's work queue.

              What actually happened, in order:
              1. Interactive wizard's real UX had genuine problems (see
                 KD-19 for the itemized list) -- confirmed by drdeek
                 actually using it, not by review.
              2. drdeek's real install correctly wired the Claude hook to
                 the root socket (/run/agent-enforcer/main.sock).
              3. claude-code-session got locked out of its own tools --
                 root cause: usermod added drdeek to the new ack-clients
                 group, but group membership only applies to NEW login
                 sessions; the already-running session kept its old group
                 list. Restarting the session was expected to fix this but
                 did NOT alone -- see KD-18.
              4. While locked out, `ack repair` (one of the few commands
                 reachable via the break-glass bypass) auto-started a
                 SECOND, unsupervised user-mode daemon alongside the real
                 root-mode one, purely as unwanted resource duplication --
                 a real regression, not intended behavior (KD-20).
              5. Independently, and NOT caused by tonight's socket-
                 permission/service-user work (the bug is in code that
                 wasn't touched), the real root-mode systemd service was
                 crash-looping: deploy-agent-enforcer.sh copies node/
                 source into /usr/local/lib/agent-character-kit/node/ but
                 never installs its npm dependencies there. No
                 node_modules -> `import ... from "js-yaml"` fails ->
                 ERR_MODULE_NOT_FOUND -> crash -> systemd's
                 StartLimitBurst=10/60s exhausted -> service gives up.
                 This means root-mode's systemd deploy has likely NEVER
                 actually started successfully for anyone, ever, until
                 drdeek hit it for real tonight (KD-18, the most severe
                 item here -- nothing in root/service-user mode works
                 without this fix).
              6. drdeek manually fixed the crash-loop himself (referenced
                 restoring something related to node/package.json;
                 claude-code-session was locked out throughout and could
                 not independently verify the exact mechanism) and
                 confirmed via real `systemctl status` that the daemon was
                 genuinely running.
              7. claude-code-session remained blocked even after that --
                 confirmed the group-membership theory was NOT the full
                 explanation on its own (a session restart did not
                 restore access either). Root cause not fully resolved in
                 this entry.
              8. drdeek disabled and removed the systemd service entirely
                 (manually, no ACK-provided command exists for this --
                 KD-23), which correctly left fail-closed enforcement
                 blocking everything (the socket is now gone; this is
                 correct behavior, not a bug). claude-code-session
                 recovered its OWN access via the already-reachable
                 bypass command `ack configure --yes` (plain user-mode,
                 safe, idempotent) -- this is what actually restored tool
                 access, not the session restart or the group fix.
              9. drdeek raised a new, separate, valid critique not yet
                 actioned: `main.sock` / `/run/agent-enforcer/` is too
                 generically named for a security-relevant enforcement
                 point, and doesn't match the real project name
                 (agent-character-kit) anywhere (KD-21).
              10. drdeek described a larger future direction: a real TUI
                 for viewing/configuring per-agent links, habits, blocked
                 commands, and variable enforcement strength per agent --
                 explicitly deferred, not started, tracked as KD-24 (a
                 feature direction, not a defect) for its own dedicated
                 design pass.
Tests Passing: 54/54 unchanged (no code touched in this entry -- pure
               discovery/documentation)
Rollback Ref: N/A -- no code changed in this entry
```

## Known Defects Register — addendum (2026-08-07, CL-0010 live findings)

- **KD-18** (severity: highest — blocks all of root/service-user mode):
  `deploy-agent-enforcer.sh` copies `node/` source but never runs
  `npm install`/copies `node_modules` into the deployed location. Fix:
  add `npm install --omit=dev --prefix "$INSTALL_LIB/node"` (or equivalent)
  as a real step in the deploy script, after the source copy.
- **KD-19**: Interactive wizard UX, itemized from drdeek's live use:
  (1) inconsistent interaction style — numbered choice for privilege mode
  vs. free-text typing for harness selection; (2) harness selection must
  use the already-built `detectHarnesses()` and present "Detected: X, Y.
  Add another?" instead of a blank prompt defaulting to hardcoded
  "claude"; (3) nothing should be printed/asked about a harness that
  wasn't actually detected; (4) the trailing "Install Agent Character Kit
  / npm install -g" banner prints unconditionally even when already
  running via a globally-installed copy — reconfirmed live twice tonight,
  including after this entry's own recovery command; (5) Python companion
  should be a contextual, per-harness prompt ("Hermes requires the Python
  companion. Continue?") triggered only when a Python-needing harness is
  actually selected, not asked generically. Plus a tone correction: wizard
  prose must describe the CURRENT system as fact, never narrate that
  something changed ("not two — pick..." reads like a changelog inside
  the live product).
- **KD-20**: `ack repair`'s daemon auto-activation doesn't check whether
  ANY daemon (root-mode, service-user-mode, or another user-mode instance)
  is already serving this agent before starting a new one — caused real,
  confirmed, unwanted resource duplication live tonight. Fix: reuse the
  same multi-socket check `ack status` already does before auto-activating
  anything.
- **KD-21**: Socket/directory naming (`main.sock`, `/run/agent-enforcer/`)
  is too generic for a security-relevant enforcement point and doesn't
  match the real project name anywhere. Needs an intentional rename —
  likely under `agent-character-kit`, not the informal internal label
  "agent-enforcer" — touching the daemon defaults, both deploy scripts,
  docs, and any tests that hardcode the path.
- **KD-22**: Root cause of claude-code-session's continued lockout even
  after a session restart was never fully resolved/confirmed in this
  session — the group-membership theory was the working hypothesis but a
  restart alone did not fix it. What actually restored access was
  recovering via the bypass-reachable `ack configure --yes` (a fresh
  user-mode daemon + hook rewire), not the theorized fix. Needs real
  investigation next session: was it actually a stale-group issue that
  the "restart" (terminal tab vs. real re-login) didn't correctly trigger,
  or something else entirely?
- **KD-23**: No ACK-provided command cleanly reverses what
  `deploy-agent-enforcer.sh`/service-user setup does. drdeek had to
  manually disable and remove the systemd service himself tonight; there
  is no equivalent of "undo root-mode" that removes the systemd units,
  the dedicated service user (if created), the `ack-clients` group
  memberships, and the system-owned directories. Needs a real
  `ack uninstall --root` (or similar) that mirrors `preuninstall.js`'s
  existing user-mode cleanup logic but for the systemd/service-user path.
- **KD-24** (feature direction, not a defect): drdeek described a real TUI
  for ACK — viewing which agent is linked to what daemon/workspace, how
  it's configured, walking through building/editing habits interactively,
  editing which commands/functions are allowed or blocked per agent, and
  setting variable enforcement strength per agent (lighter on some,
  stricter on others, depending on use case). Explicitly deferred tonight
  in favor of finishing the KD-18 through KD-23 backlog first. Needs its
  own dedicated design/scoping session — not started.

## Known Defects Register — addendum (2026-08-07, found while fixing KD-20)

- **KD-25** (feature gap, drdeek-flagged): the daemon's own acknowledgment
  prompt text says "No filler, no reuse" but nothing tracks or enforces
  habit reuse across a session -- `submitAck` accepts any
  syntactically-valid "habit: X because Y" statement regardless of
  whether that exact habit was already cited earlier in the same session.
  Needs real tracking (e.g. a per-session set of already-acknowledged
  habit names) and rejection of a repeat before the next hold's 2 slots
  are considered filled.
- **KD-26** (fixed same pass): `status` was silently gated behind
  `ACK_AUTH_TOKEN` like every other RPC method, but the CLI commands that
  most need to check liveness (`ack status`, `ack repair`, `ack doctor`)
  run as fresh processes with no token in their own env -- so every
  liveness check against a correctly-configured (tokened) daemon reported
  false "dead" results. This is what made KD-20's first fix attempt
  appear not to work when tested against a genuinely-alive daemon. Fixed
  by exempting `status` specifically (safe -- its response carries no
  secret). Duplicated in the second socket-server implementation (KD-16),
  fixed there too. Verified live: a real isolated daemon + `ack repair`
  against the same workspace now correctly reports reuse instead of
  spawning a duplicate.

## Known Defects Register — resolution update (2026-08-07, backlog session)

- **KD-18**: FIXED. `deploy-agent-enforcer.sh` now runs `npm install --omit=dev` after the source copy. Not live-verified (no sudo this session) -- syntax-checked only.
- **KD-19**: FIXED, all 5 items + tone correction. Interactive wizard now auto-detects harnesses (detectHarnesses(), pre-populates + confirms rather than forcing free-text with a hardcoded default), Python companion prompt is contextual (only asked when Hermes is actually selected), privilege-mode prompt describes current state without narrating that it changed. Item 4 (redundant install banner) fixed separately below.
- **KD-19 item 4 / redundant banner**: FIXED. `install.js` now checks `IS_GLOBAL_INSTALL` (same node_modules-path test postinstall.js already used) and only prints the "install the package" banner from a genuine local dev checkout, never when already running through a global/packed install.
- **KD-20**: FIXED, but required a second, deeper fix to actually work -- see KD-26.
- **KD-26**: FIXED (new defect found while verifying KD-20). `status` was silently gated behind ACK_AUTH_TOKEN like every other RPC method, so any fresh CLI invocation (no token in its own env) got a false "dead" reading against a healthy, correctly-tokened daemon. Exempted `status` specifically; verified live end to end (real isolated daemon + `ack repair` against it correctly reports reuse, no duplicate spawned).
- **KD-21, KD-23, KD-24, KD-25**: still open, not touched this pass.

Commits this pass: 8c90a38, bc016fa, 02c47c0, 5ead336, 18bffb5, ab1c6cc, cb14f03, f145df0.
