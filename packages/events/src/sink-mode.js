/**
 * Where canonical events print. Defaults follow the service; env can override.
 *
 * ACK_EVENT_SINK=local|d1|both
 * ACK_EVENT_SERVICE=daemon|chatgpt|codex|claude|hermes|gate
 * ACK_EVENT_URL=https://<host>/events  (local process posting into hosted D1)
 */

export const SINK_LOCAL = "local";
export const SINK_D1 = "d1";
export const SINK_BOTH = "both";

export const SERVICE_DEFAULTS = Object.freeze({
  chatgpt: SINK_D1,
  hosted: SINK_D1,
  "chatgpt-ack-mcp": SINK_D1,
  "plugin.chatgpt": SINK_D1,
  daemon: SINK_LOCAL,
  local: SINK_LOCAL,
  codex: SINK_LOCAL,
  claude: SINK_LOCAL,
  hermes: SINK_LOCAL,
  gate: SINK_LOCAL,
  "forever-gate": SINK_LOCAL,
});

export function resolveEventService(options = {}) {
  const env = options.env || {};
  return String(
    options.service || env.ACK_EVENT_SERVICE || ""
  )
    .trim()
    .toLowerCase() || "local";
}

export function resolveEventSinkMode(options = {}) {
  const env = options.env || {};
  const raw = String(env.ACK_EVENT_SINK || "").trim().toLowerCase();
  if (raw === SINK_LOCAL || raw === SINK_D1 || raw === SINK_BOTH) return raw;
  const service = resolveEventService(options);
  return SERVICE_DEFAULTS[service] || SINK_LOCAL;
}
