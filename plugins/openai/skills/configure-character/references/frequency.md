# Hold frequency and related knobs

Resolution order: environment variable, then `enforcer.yaml` key, then
embedded default.

| Purpose | Env | YAML key | Default |
|---|---|---|---|
| Non-search calls between holds | ACK_HOLD_EVERY_N_CALLS | hold_every_n_calls | 5 |
| Habits required to lift a hold | ACK_REQUIRED_ACKS | required_acks | 2 |
| Min ack reason length | ACK_MIN_ACK_REASON_CHARS | min_ack_reason_chars | 12 |
| Ack-reason reuse window | ACK_MAX_ACK_REASON_HISTORY | max_ack_reason_history | 10 |
| Habit-name reuse window | ACK_MAX_HABIT_NAME_HISTORY | max_habit_name_history | 10 |
| Distinct files before commit | ACK_FILE_CHANGE_THRESHOLD | file_change_threshold | 5 |
| Hold-cycles before commit | ACK_COMMIT_EVERY_N_CYCLES | commit_every_n_cycles | 4 |
| Min git commit message chars | ACK_COMMIT_MIN_CHARS | commit_min_chars | 150 |
| Tools exempt from hold | ACK_SEARCH_TOOLS | search_tools | search_files,read_file,web_search,web_extract,glob,grep,read |

Example `enforcer.yaml` fragment:

```yaml
hold_every_n_calls: 5
required_acks: 2
file_change_threshold: 5
commit_every_n_cycles: 4
commit_min_chars: 150
```

Commit is required at a hold boundary only after **either** file or cycle
threshold is crossed. Both trackers reset on a qualifying commit.

Injection (prompt rotation) is independent of these numbers. Hermes can
set `inject_enabled` in its plugin config; that is a reminder switch, not
a gate.

Watchdog/audit-only (parsed by the daemon, unused by the hold loop):
`heartbeat_stale_seconds` / `ACK_HEARTBEAT_STALE_SECONDS` (600),
`validation_interval_ms` / `ACK_VALIDATION_INTERVAL_MS` (30000),
`audit_max_command_chars` / `ACK_AUDIT_MAX_COMMAND_CHARS` (500).
