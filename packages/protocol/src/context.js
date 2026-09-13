/**
 * Runtime context required on every protocol request.
 * Character Kit records host-supplied identity; it never owns identity files.
 *
 * @typedef {object} RuntimeContext
 * @property {string} sessionId
 * @property {string} runId
 * @property {string} timestamp
 * @property {string} [agentId]
 * @property {string} [workspaceId]
 * @property {string} [toolCallId]
 * @property {string} [parentRunId]
 * @property {string} [episodeId]
 * @property {string} [taskId]
 */

/**
 * @param {Partial<RuntimeContext> & { sessionId?: string, runId?: string }} input
 * @returns {RuntimeContext}
 */
export function normalizeContext(input = {}) {
  const sessionId = input.sessionId || "session-unknown";
  const runId = input.runId || sessionId;
  return {
    sessionId,
    runId,
    timestamp: input.timestamp || new Date().toISOString(),
    agentId: input.agentId,
    workspaceId: input.workspaceId,
    toolCallId: input.toolCallId,
    parentRunId: input.parentRunId,
    episodeId: input.episodeId,
    taskId: input.taskId,
  };
}
