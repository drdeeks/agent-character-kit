/**
 * Host capability negotiation. Unsupported enforcement modes must fail closed.
 *
 * @typedef {object} RuntimeCapabilities
 * @property {boolean} supportsDeveloperMessages
 * @property {boolean} supportsToolInterception
 * @property {boolean} supportsStreaming
 * @property {boolean} supportsStructuredOutputs
 * @property {boolean} supportsContinuation
 */

/** @returns {RuntimeCapabilities} */
export function emptyCapabilities() {
  return {
    supportsDeveloperMessages: false,
    supportsToolInterception: false,
    supportsStreaming: false,
    supportsStructuredOutputs: false,
    supportsContinuation: false,
  };
}

/**
 * @param {RuntimeCapabilities} have
 * @param {Partial<RuntimeCapabilities>} need
 * @returns {string[]} missing capability keys
 */
export function missingCapabilities(have, need) {
  const missing = [];
  for (const [key, required] of Object.entries(need || {})) {
    if (required && !have[key]) missing.push(key);
  }
  return missing;
}
