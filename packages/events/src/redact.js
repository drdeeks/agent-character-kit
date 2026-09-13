const SENSITIVE_KEYS = new Set([
  "password",
  "passwd",
  "secret",
  "token",
  "api_key",
  "apikey",
  "authorization",
  "command",
  "content",
  "prompt",
  "statement",
]);

/**
 * Shallow redaction for event payloads. Enforcement continues even if this throws.
 * @param {unknown} value
 * @returns {unknown}
 */
export function redact(value) {
  if (value == null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(redact);
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    if (SENSITIVE_KEYS.has(key.toLowerCase())) {
      out[key] = "[redacted]";
    } else if (item && typeof item === "object") {
      out[key] = redact(item);
    } else {
      out[key] = item;
    }
  }
  return out;
}
