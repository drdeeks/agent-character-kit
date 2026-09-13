# Workspace and reload

## Layout

```
$AGENT_WORKSPACE/
  .env
  .agent/
    constitution.yaml
    enforcer.yaml
    habits/
      <name>.yaml
```

Default workspace if unset: `$HOME/.agent-character-kit/workspace`.
Set with `export AGENT_WORKSPACE=...` or `ack configure`.

`ack configure` / `ack config write-env` write `$AGENT_WORKSPACE/.env`.
The daemon reads `$AGENT_WORKSPACE/.agent/.env` first, then CWD, then the
repo root. Keep those two paths in mind when debugging a missing token.
`.env` carries `AGENT_WORKSPACE`, `ENFORCER_SOCKET`, `ACK_ACK_LOG`.
`ACK_AUTH_TOKEN` is the RPC auth check; do not regenerate it on a live
workspace (that breaks `ack configure --yes` idempotence).

## Apply changes

The daemon `reload` RPC re-reads constitution, habits, and policy. There is
no `ack reload` flag yet. Restart the daemon:

- user-mode: stop/start via `ack manage` or the supervisor
- root-mode: `systemctl restart agent-enforcer.service`

Then `ack status` (version, character hash, enforcing).

## Privilege modes

- user-mode: same UID as the agent; the agent can kill the daemon
- service-user-mode: dedicated `ack-enforcer` account (write/kill boundary
  without full root)
- root-mode: systemd units (same class of boundary, plus root)

ACK remains a deterrent in every mode.

## Interactive surfaces

- `ack configure` / `ack configure --yes` — first-time and idempotent setup
- `ack manage` — list agents, habits, start/stop daemon, scoped configure
- `ack doctor` / `ack repair` / `ack config show|verify|write-env|set`
