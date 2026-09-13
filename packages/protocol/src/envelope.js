import { normalizeContext } from "./context.js";
import { ERROR_CODES, pluginError } from "./errors.js";

export const PROTOCOL_NAME = "character-kit";
export const PROTOCOL_VERSION = "1";
export const PROTOCOL_V0 = "0";

/**
 * @param {object} input
 * @param {string} input.type
 * @param {string} input.requestId
 * @param {object} [input.context]
 * @param {unknown} input.payload
 */
export function createEnvelope(input) {
  if (!input || !input.type || !input.requestId) {
    throw new Error("envelope type and requestId are required");
  }
  return {
    protocol: PROTOCOL_NAME,
    version: PROTOCOL_VERSION,
    type: input.type,
    requestId: input.requestId,
    context: normalizeContext(input.context || {}),
    payload: input.payload,
  };
}

/**
 * @param {object} input
 * @param {string} input.requestId
 * @param {boolean} input.ok
 * @param {unknown} [input.payload]
 * @param {object} [input.error]
 */
export function createResponse(input) {
  if (!input || !input.requestId) {
    throw new Error("response requestId is required");
  }
  return {
    protocol: PROTOCOL_NAME,
    version: PROTOCOL_VERSION,
    requestId: input.requestId,
    ok: Boolean(input.ok),
    payload: input.payload,
    error: input.error,
  };
}

/**
 * Accept v1 envelope or v0 NDJSON RPC { method, params, token }.
 * @param {unknown} raw
 */
export function parseIncoming(raw) {
  if (!raw || typeof raw !== "object") {
    return {
      ok: false,
      error: pluginError(ERROR_CODES.CK_PROTOCOL_INVALID, "payload is not an object"),
    };
  }
  if (raw.protocol === PROTOCOL_NAME) {
    if (raw.version !== PROTOCOL_VERSION) {
      return {
        ok: false,
        error: pluginError(
          ERROR_CODES.CK_VERSION_UNSUPPORTED,
          "unsupported protocol version",
          { details: { version: raw.version } }
        ),
      };
    }
    if (!raw.type || !raw.requestId) {
      return {
        ok: false,
        error: pluginError(ERROR_CODES.CK_PROTOCOL_INVALID, "envelope missing type or requestId"),
      };
    }
    return { ok: true, version: PROTOCOL_VERSION, envelope: raw };
  }
  if (typeof raw.method === "string") {
    return {
      ok: true,
      version: PROTOCOL_V0,
      envelope: {
        protocol: PROTOCOL_NAME,
        version: PROTOCOL_V0,
        type: raw.method,
        requestId: raw.requestId || raw.method,
        context: normalizeContext(raw.params || {}),
        payload: { params: raw.params || {}, token: raw.token },
      },
    };
  }
  return {
    ok: false,
    error: pluginError(ERROR_CODES.CK_PROTOCOL_INVALID, "neither v1 envelope nor v0 RPC"),
  };
}
