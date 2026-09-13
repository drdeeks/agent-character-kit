import { normalizeContext } from "@drdeeks/character-kit-protocol";

/**
 * Map an OpenAI-compatible chat/completions or Responses-shaped body
 * onto Character Kit ModelInput / ToolInput. Core stays SDK-free.
 * @param {object} body
 * @param {object} [headers]
 */
export function mapOpenAiRequest(body = {}, headers = {}) {
  const requestId = headers["x-request-id"] || body.request_id || "openai-run";
  const context = normalizeContext({
    sessionId: body.user || body.conversation_id || requestId,
    runId: requestId,
    agentId: body.model,
  });
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const last = messages[messages.length - 1] || {};
  const toolCalls = last.tool_calls || body.tool_calls || [];
  const firstTool = toolCalls[0];
  let command;
  let toolName;
  let params = {};
  if (firstTool) {
    toolName = firstTool.function?.name || firstTool.name || "tool";
    try {
      params = JSON.parse(firstTool.function?.arguments || firstTool.arguments || "{}");
    } catch {
      params = {};
    }
    command = params.command;
  }
  return {
    context,
    model: body.model,
    messages,
    tool: toolName,
    command,
    params,
    hasToolCall: Boolean(firstTool),
  };
}
