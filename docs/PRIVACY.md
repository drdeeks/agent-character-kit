# Privacy — hosted ChatGPT ACK

The ChatGPT app stores per-user configuration and audit records in Cloudflare
D1 (and optional Durable Object leases). It does not store OAuth refresh
tokens in D1.

Stored: workspace/user/installation ids, character profiles, habits, tool
decisions, acknowledgments, watchdog heartbeats, audit events.

Default audit retention is 90 days (`profile.audit.retentionDays`). Export
with `ack_export_user_data`. Delete with `ack_delete_user_data`. Revoke with
`ack_revoke_installation`.

The local Codex plugin is a different path: it talks to a loopback daemon
and writes JSONL on disk. See `plugins/openai/PRIVACY.md`.
