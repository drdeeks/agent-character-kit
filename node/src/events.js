/**
 * Canonical Event Schema — @drdeeks/loop-events
 * 
 * The most important shared interface across the entire architecture is the
 * event schema. Both Character Kit and The Gate enforce → emit event.
 * Everything downstream consumes the same event language.
 * 
 * See RL_INTEGRATION.md §11 for full requirements.
 */

// Unique event identifier (v4 UUID compatible format)
export function generateEventId() {
  return 'evt_' + Math.random().toString(36).substr(2, 24);
}

// Sequence counter per session
let sessionSequence = 0;

// Hierarchical identifier builders
export function buildAgentId(agentName) {
  // Priority: agent.json name → soul.md → harness name → "generic"
  if (agentName && agentName !== 'generic') return `agent:${agentName}`;
  return 'agent:generic';
}

export function buildSessionId(workspace, harnessName) {
  return `session:${workspace}:${harnessName || 'unknown'}`;
}

export function buildEpisodeId(taskId, runCount) {
  return `episode:${taskId}:run-${runCount}`;
}

export function buildTaskId(objective) {
  return `task:${objective || 'unknown'}`;
}

export function buildRunId(attempt) {
  return `run:${attempt}`;
}

// Core event type vocabulary (RL_INTEGRATION.md §11.5)
export const EventType = {
  // Lifecycle
  SESSION_STARTED: 'session.started',
  SESSION_ENDED: 'session.ended',
  EPISODE_STARTED: 'episode.started',
  EPISODE_ENDED: 'episode.ended',
  TASK_STARTED: 'task.started',
  TASK_COMPLETED: 'task.completed',
  TASK_FAILED: 'task.failed',
  TASK_ABORTED: 'task.aborted',

  // Model
  MODEL_REQUESTED: 'model.requested',
  MODEL_RESPONDED: 'model.responded',
  MODEL_STREAM_STARTED: 'model.stream.started',
  MODEL_STREAM_COMPLETED: 'model.stream.completed',
  MODEL_ERROR: 'model.error',

  // Actions
  ACTION_PROPOSED: 'action.proposed',
  TOOL_REQUESTED: 'tool.requested',
  TOOL_ALLOWED: 'tool.allowed',
  TOOL_HELD: 'tool.held',
  TOOL_DENIED: 'tool.denied',
  TOOL_STARTED: 'tool.started',
  TOOL_COMPLETED: 'tool.completed',
  TOOL_FAILED: 'tool.failed',

  // Character Kit
  HABIT_INJECTED: 'habit.injected',
  ACKNOWLEDGMENT_REQUESTED: 'acknowledgment.requested',
  ACKNOWLEDGMENT_SUBMITTED: 'acknowledgment.submitted',
  ACKNOWLEDGMENT_ACCEPTED: 'acknowledgment.accepted',
  ACKNOWLEDGMENT_REJECTED: 'acknowledgment.rejected',
  ACKNOWLEDGMENT_REUSED: 'acknowledgment.reused',
  POLICY_EVALUATED: 'policy.evaluated',
  POLICY_TRIGGERED: 'policy.triggered',
  POLICY_HELD: 'policy.held',
  POLICY_RELEASED: 'policy.released',
  POLICY_DENIED: 'policy.denied',
  CONSTRAINT_VIOLATED: 'constraint.violated',
  CONSTRAINT_SATISFIED: 'constraint.satisfied',

  // Accountability
  FILE_CHANGED: 'file.changed',
  FILE_CREATED: 'file.created',
  FILE_DELETED: 'file.deleted',
  COMMIT_CREATED: 'commit.created',
  COMMIT_COMPLETED: 'commit.completed',
  COMMIT_REJECTED: 'commit.rejected',
  VALIDATION_STARTED: 'validation.started',
  VALIDATION_COMPLETED: 'validation.completed',
  VALIDATION_FAILED: 'validation.failed',

  // Infrastructure
  ENFORCER_CONNECTED: 'enforcer.connected',
  ENFORCER_DISCONNECTED: 'enforcer.disconnected',
  ENFORCER_RECOVERED: 'enforcer.recovered',
  PROTOCOL_ERROR: 'protocol.error',
  STATE_RECOVERED: 'state.recovered',
  CONFIGURATION_CHANGED: 'configuration.changed',
};

// Base event structure (RL_INTEGRATION.md §11.2)
export function baseEvent(eventType, options = {}) {
  sessionSequence++;
  return {
    eventId: options.eventId || generateEventId(),
    eventType,
    timestamp: new Date().toISOString(),
    sequence: sessionSequence,
    schemaVersion: '1.0.0',
    source: 'character-kit',
    ...options,
  };
}

// Action record (RL_INTEGRATION.md §11.6)
export function actionRecord(options = {}) {
  return {
    actionId: options.actionId || generateEventId(),
    type: options.type,
    target: options.target,
    parametersHash: options.parametersHash,
    proposedAt: options.proposedAt || new Date().toISOString(),
    executedAt: options.executedAt,
    completedAt: options.completedAt,
    attempt: options.attempt || 1,
  };
}

// Outcome record (RL_INTEGRATION.md §11.6)
export function outcomeRecord(options = {}) {
  return {
    status: options.status || 'success',
    exitCode: options.exitCode,
    durationMs: options.durationMs,
    resultClass: options.resultClass,
    errorCode: options.errorCode,
    artifactRefs: options.artifactRefs,
    metrics: options.metrics,
  };
}

// Intervention metadata (RL_INTEGRATION.md §11.17)
export function interventionRecord(options = {}) {
  return {
    interventionId: options.interventionId || generateEventId(),
    component: options.component || 'character-kit',
    policyId: options.policyId,
    policyVersion: options.policyVersion,
    triggerEventId: options.triggerEventId,
    decision: options.decision,
    requirements: options.requirements,
    resolvedBy: options.resolvedBy,
    resolutionEventId: options.resolutionEventId,
  };
}

// Convenience exports for common event types
export function habitInjectedEvent(sessionId, habitId, injectionId, channel, options = {}) {
  return baseEvent(EventType.HABIT_INJECTED, {
    sessionId,
    agentId: options.agentId,
    'habit.id': habitId,
    'injection.id': injectionId,
    'channel': channel,
    ...options,
  });
}

export function acknowledgmentSubmittedEvent(sessionId, acknowledgmentId, requirementsSatisfied, options = {}) {
  return baseEvent(EventType.ACKNOWLEDGMENT_SUBMITTED, {
    sessionId,
    agentId: options.agentId,
    'acknowledgment.id': acknowledgmentId,
    'requirements.satisfied': requirementsSatisfied,
    ...options,
  });
}

export function policyReleasedEvent(sessionId, policy, options = {}) {
  return baseEvent(EventType.POLICY_RELEASED, {
    sessionId,
    agentId: options.agentId,
    'policy': policy,
    ...options,
  });
}

export function toolRequestedEvent(sessionId, tool, options = {}) {
  return baseEvent(EventType.TOOL_REQUESTED, {
    sessionId,
    agentId: options.agentId,
    'tool.name': tool,
    ...options,
  });
}

export function toolHeldEvent(sessionId, tool, reason, options = {}) {
  return baseEvent(EventType.TOOL_HELD, {
    sessionId,
    agentId: options.agentId,
    'tool.name': tool,
    'hold.reason': reason,
    ...options,
  });
}

export function toolCompletedEvent(sessionId, tool, outcome, options = {}) {
  return baseEvent(EventType.TOOL_COMPLETED, {
    sessionId,
    agentId: options.agentId,
    'tool.name': tool,
    'outcome.status': outcome.status,
    'outcome.durationMs': outcome.durationMs,
    ...options,
  });
}

// Export the full schema for use by all components
export default {
  baseEvent,
  actionRecord,
  outcomeRecord,
  interventionRecord,
  EventType,
  habitInjectedEvent,
  acknowledgmentSubmittedEvent,
  policyReleasedEvent,
  toolRequestedEvent,
  toolHeldEvent,
  toolCompletedEvent,
};

