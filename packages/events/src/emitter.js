import { randomUUID } from "crypto";
import { EVENT_SCHEMA_VERSION } from "./types.js";
import { redact } from "./redact.js";

/**
 * In-process event bus plus optional durable sink.
 * Reward is never computed here.
 */
export class EventEmitter {
  /**
   * @param {{ sink?: { append: Function }, source?: string }} [options]
   */
  constructor(options = {}) {
    this.handlers = new Map();
    this.sink = options.sink;
    this.source = options.source || "character-kit";
    this.sequences = new Map();
  }

  on(eventType, handler) {
    const list = this.handlers.get(eventType) || [];
    list.push(handler);
    this.handlers.set(eventType, list);
  }

  /**
   * @param {string} eventType
   * @param {object} fields
   */
  async emit(eventType, fields = {}) {
    const sessionId = fields.sessionId || "session-unknown";
    const episodeId = fields.episodeId || "episode-unknown";
    const taskId = fields.taskId || "task-unknown";
    const runId = fields.runId || "run-unknown";
    
    const seq = (this.sequences.get(sessionId) || 0) + 1;
    this.sequences.set(sessionId, seq);
    
    const event = {
      eventId: fields.eventId || randomUUID(),
      eventType,
      timestamp: fields.timestamp || new Date().toISOString(),
      sessionId,
      episodeId,
      taskId,
      runId,
      agentId: fields.agentId || "agent-unknown",
      sequence: seq,
      schemaVersion: EVENT_SCHEMA_VERSION,
      source: this.source,
      component: fields.component || this.source,
      componentVersion: fields.componentVersion,
      modelId: fields.modelId,
      modelVersion: fields.modelVersion,
      parentEventId: fields.parentEventId,
      action: redact(fields.action || null),
      observation: redact(fields.observation || null),
      decision: redact(fields.decision || null),
      outcome: redact(fields.outcome || null),
      metadata: redact(fields.metadata || {}),
      payload: redact(fields.payload || {}),
    };
    const list = this.handlers.get(eventType) || [];
    for (const handler of list) {
      await handler(event);
    }
    if (this.sink) {
      try {
        await this.sink.append(event);
      } catch {
        // Sink failure is recorded by absence of the line, not by allowing a tool.
      }
    }
    return event;
  }
}
