# Security — hosted ChatGPT ACK

- Tenant isolation on every read and write (`workspace_id` + `owner_user_id`).
- Identity from the authenticated connection. Ignore model `user_id` arguments.
- Fail-closed: storage or Worker failure returns `decision: unavailable`, never silent allow.
- No plaintext access tokens in D1.
- Rate-limit configuration writes.
- ACK is a deterrent, not a cage. ChatGPT cannot enforce tools that never call `ack_check_action`.
- Revoke, export, and delete are MCP tools scoped to the caller.
