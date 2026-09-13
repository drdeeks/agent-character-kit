/** Stable Character Kit error codes. Human text is not the contract. */

export const ERROR_CODES = Object.freeze({
  CK_CONFIG_INVALID: "CK_CONFIG_INVALID",
  CK_SESSION_INVALID: "CK_SESSION_INVALID",
  CK_STATE_UNAVAILABLE: "CK_STATE_UNAVAILABLE",
  CK_DAEMON_UNAVAILABLE: "CK_DAEMON_UNAVAILABLE",
  CK_PROTOCOL_INVALID: "CK_PROTOCOL_INVALID",
  CK_ACK_REQUIRED: "CK_ACK_REQUIRED",
  CK_ACK_INVALID: "CK_ACK_INVALID",
  CK_TOOL_BLOCKED: "CK_TOOL_BLOCKED",
  CK_POLICY_DENIED: "CK_POLICY_DENIED",
  CK_REQUEST_TIMEOUT: "CK_REQUEST_TIMEOUT",
  CK_VERSION_UNSUPPORTED: "CK_VERSION_UNSUPPORTED",
  CK_CAPABILITY_UNSUPPORTED: "CK_CAPABILITY_UNSUPPORTED",
});

/**
 * @param {string} code
 * @param {string} message
 * @param {{ retryable?: boolean, requestId?: string, details?: Record<string, unknown> }} [extra]
 */
export function pluginError(code, message, extra = {}) {
  if (!Object.values(ERROR_CODES).includes(code)) {
    throw new Error("unknown Character Kit error code");
  }
  return {
    code,
    message,
    retryable: Boolean(extra.retryable),
    requestId: extra.requestId,
    details: extra.details || {},
  };
}
