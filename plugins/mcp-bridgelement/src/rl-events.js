import { EVENT_TYPE, createEventSink, redact } from "@drdeeks/character-kit-events";
import { newId, nowIso } from "./ids.js";

export const KNOWN_EVENT_TYPES = new Set(Object.values(EVENT_TYPE));

export function decisionEventType(decision) {
  if (decision === "hold") return EVENT_TYPE.TOOL_HELD;
  if (decision === "deny") return EVENT_TYPE.TOOL_DENIED;
  if (decision === "allow") return EVENT_TYPE.TOOL_ALLOWED;
  if (decision === "acknowledge") return EVENT_TYPE.ACK_ACCEPTED;
  if (decision === "unavailable") return EVENT_TYPE.PROTOCOL_ERROR;
  return EVENT_TYPE.POLICY_EVALUATED;
}

/**
 * Facts only. Tenant comes from the authenticated connection.
 * Model-supplied user_id is ignored by the caller.
 */
export function buildRlEvent(identity, eventType, fields = {}) {
  if (!KNOWN_EVENT_TYPES.has(eventType)) {
    const err = new Error(`unknown eventType ${eventType}`);
    err.code = "invalid";
    throw err;
  }
  return {
    eventId: fields.eventId || newId("evt"),
    eventType,
    timestamp: fields.timestamp || nowIso(),
    sessionId: fields.sessionId || identity.conversationId || identity.installationId,
    episodeId: fields.episodeId || null,
    taskId: fields.taskId || null,
    runId: fields.runId || identity.installationId,
    agentId: fields.agentId || identity.agentId,
    sequence: Number(fields.sequence) || 0,
    source: fields.source || "mcp-bridgelement",
    component: fields.component || "mcp-bridgelement",
    parentEventId: fields.parentEventId || null,
    schemaVersion: "2",
    modelId: fields.modelId || null,
    modelVersion: fields.modelVersion || null,
    componentVersion: fields.componentVersion || null,
    action: redactObject(fields.action),
    observation: redactObject(fields.observation),
    decision: redactObject(fields.decision),
    outcome: redactObject(fields.outcome),
    metadata: redactObject(fields.metadata) || {},
    payload: redact(fields.payload || {}),
    workspaceId: identity.workspaceId,
    ownerUserId: identity.userId,
    installationId: identity.installationId,
  };
}

function redactObject(value) {
  return value == null ? null : redact(value);
}

export async function emitRlEvent(store, identity, eventType, fields = {}, env = {}) {
  try {
    const event = buildRlEvent(identity, eventType, fields);
    const sink = createEventSink({
      service: env.ACK_EVENT_SERVICE || "agnostic",
      env,
      store,
      identity,
    });
    await sink.append(event);
    return event;
  } catch {
    return null;
  }
}
