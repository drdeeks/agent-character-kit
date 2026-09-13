# Error taxonomy

Machine-readable codes. Plugins must branch on `code`, not on English.

| Code | Meaning |
|---|---|
| CK_CONFIG_INVALID | Config failed schema or merge |
| CK_SESSION_INVALID | Missing or unusable session context |
| CK_STATE_UNAVAILABLE | State store failed |
| CK_DAEMON_UNAVAILABLE | Socket missing, refused, or timed out |
| CK_PROTOCOL_INVALID | Not v0 RPC and not v1 envelope |
| CK_ACK_REQUIRED | Hold: structured requirements attached |
| CK_ACK_INVALID | Acknowledgment did not match Habit format |
| CK_TOOL_BLOCKED | Tool not executed |
| CK_POLICY_DENIED | Hard constraint or deny/allow list |
| CK_REQUEST_TIMEOUT | Bound exceeded |
| CK_VERSION_UNSUPPORTED | Envelope version not 1 |
| CK_CAPABILITY_UNSUPPORTED | Host cannot intercept tools (or similar) |

Every error is `{ code, message, retryable, requestId?, details? }`.
