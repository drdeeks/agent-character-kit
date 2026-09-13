import { emptyCapabilities } from "@drdeeks/character-kit-protocol";

/**
 * Detect OpenAI-compatible host capabilities from a request body.
 * @param {object} body
 */
export function detectOpenAiCapabilities(body = {}) {
  const caps = emptyCapabilities();
  caps.supportsStreaming = body.stream === true;
  caps.supportsToolInterception = Array.isArray(body.tools) && body.tools.length > 0;
  caps.supportsStructuredOutputs = Boolean(body.response_format);
  caps.supportsDeveloperMessages = Array.isArray(body.messages)
    && body.messages.some((m) => m && m.role === "developer");
  caps.supportsContinuation = true;
  return caps;
}
