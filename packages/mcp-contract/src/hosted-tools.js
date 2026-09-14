const RO = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
const RW = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };
const DEST = { readOnlyHint: false, destructiveHint: true, openWorldHint: false };

const ctxProps = {
  conversation_id: { type: "string" },
  user_id: { type: "string", description: "Ignored. Identity comes from the authenticated connection." },
};

export const DECISION_OUTPUT = {
  type: "object",
  properties: {
    decision: { type: "string", enum: ["allow", "hold", "deny", "acknowledge", "unavailable"] },
    decisionId: { type: "string" },
    profileId: { type: "string" },
    reasonCodes: { type: "array", items: { type: "string" } },
    requiredAcknowledgment: { type: "boolean" },
    expiresAt: { type: ["string", "null"] },
    nextAction: { type: "string", enum: ["continue", "acknowledge_hold", "reconfigure", "retry"] },
  },
};

export const HOSTED_TOOLS = [
  {
    name: "ack_get_status",
    title: "ACK status",
    description: "Use when the user asks whether ACK is connected, which profile is active, or if enforcement is up.",
    inputSchema: { type: "object", properties: ctxProps },
    outputSchema: { type: "object", properties: { ok: { type: "boolean" }, mode: { type: "string" }, profileId: { type: "string" } } },
    annotations: RO,
  },
  {
    name: "ack_get_active_profile",
    title: "Active profile",
    description: "Use when the user asks which character profile is currently enforcing.",
    inputSchema: { type: "object", properties: ctxProps },
    outputSchema: { type: "object" },
    annotations: RO,
  },
  {
    name: "ack_list_profiles",
    title: "List profiles",
    description: "Use when the user wants to see their ACK profiles.",
    inputSchema: { type: "object", properties: ctxProps },
    outputSchema: { type: "object", properties: { profiles: { type: "array" } } },
    annotations: RO,
  },
  {
    name: "ack_get_policy",
    title: "Get policy",
    description: "Use when the user asks what tool rules or habits the active profile uses.",
    inputSchema: { type: "object", properties: { ...ctxProps, profileId: { type: "string" } } },
    outputSchema: { type: "object" },
    annotations: RO,
  },
  {
    name: "ack_get_recent_decisions",
    title: "Recent decisions",
    description: "Use when the user asks what ACK allowed, held, or denied recently.",
    inputSchema: { type: "object", properties: { ...ctxProps, limit: { type: "integer" } } },
    outputSchema: { type: "object", properties: { decisions: { type: "array" } } },
    annotations: RO,
  },
  {
    name: "ack_create_profile",
    title: "Create profile",
    description: "Use when the user wants a new ACK character profile.",
    inputSchema: { type: "object", properties: { ...ctxProps, name: { type: "string" }, mode: { type: "string" } }, required: ["name"] },
    outputSchema: { type: "object" },
    annotations: RW,
  },
  {
    name: "ack_update_profile",
    title: "Update profile",
    description: "Use when the user wants to change an existing ACK profile they own.",
    inputSchema: { type: "object", properties: { ...ctxProps, profileId: { type: "string" }, patch: { type: "object" } }, required: ["profileId"] },
    outputSchema: { type: "object" },
    annotations: RW,
  },
  {
    name: "ack_select_profile",
    title: "Select profile",
    description: "Use when the user wants this ChatGPT installation to use a different profile.",
    inputSchema: { type: "object", properties: { ...ctxProps, profileId: { type: "string" } }, required: ["profileId"] },
    outputSchema: { type: "object" },
    annotations: RW,
  },
  {
    name: "ack_configure_habit",
    title: "Configure habit",
    description: "Use when the user wants to add or retune a habit on the active profile.",
    inputSchema: {
      type: "object",
      properties: { ...ctxProps, name: { type: "string" }, requiresAck: { type: "boolean" }, remove: { type: "boolean" } },
      required: ["name"],
    },
    outputSchema: { type: "object" },
    annotations: RW,
  },
  {
    name: "ack_set_enforcement_mode",
    title: "Set enforcement mode",
    description: "Use when the user wants fail-closed or fail-open on the active profile.",
    inputSchema: { type: "object", properties: { ...ctxProps, mode: { type: "string" } }, required: ["mode"] },
    outputSchema: { type: "object" },
    annotations: RW,
  },
  {
    name: "ack_check_action",
    title: "Check action",
    description: "Use when a ChatGPT tool is about to run. Server-side ACK decision. Fail-closed when mode is fail-closed.",
    inputSchema: { type: "object", properties: { ...ctxProps, tool: { type: "string" }, command: { type: "string" } }, required: ["tool"] },
    outputSchema: DECISION_OUTPUT,
    annotations: RW,
  },
  {
    name: "ack_acknowledge_hold",
    title: "Acknowledge hold",
    description: "Use when ACK held a tool and the user or model must acknowledge a habit.",
    inputSchema: {
      type: "object",
      properties: { ...ctxProps, habitName: { type: "string" }, reason: { type: "string" }, decisionId: { type: "string" } },
      required: ["habitName", "reason"],
    },
    outputSchema: DECISION_OUTPUT,
    annotations: RW,
  },
  {
    name: "ack_record_decision",
    title: "Record decision",
    description: "Use when a host already decided and must log the ACK-shaped result. Does not bypass check_action.",
    inputSchema: {
      type: "object",
      properties: { ...ctxProps, decision: { type: "string" }, tool: { type: "string" }, reasonCodes: { type: "array", items: { type: "string" } } },
      required: ["decision"],
    },
    outputSchema: DECISION_OUTPUT,
    annotations: RW,
  },
  {
    name: "ack_report_watchdog_state",
    title: "Watchdog heartbeat",
    description: "Use when reporting hosted watchdog liveness. Idempotent. Lease/version in D1, not a Worker timer.",
    inputSchema: { type: "object", properties: { ...ctxProps, leaseVersion: { type: "integer" } } },
    outputSchema: { type: "object" },
    annotations: RW,
  },
  {
    name: "ack_ingest_event",
    title: "Ingest RL/telemetry event",
    description: "Use when a local ACK, Gate, or other component must print a canonical enforcement fact into D1. Facts only, no rewards. Identity is the connection, not user_id.",
    inputSchema: {
      type: "object",
      properties: {
        ...ctxProps,
        eventType: { type: "string" },
        sessionId: { type: "string" },
        episodeId: { type: "string" },
        taskId: { type: "string" },
        runId: { type: "string" },
        source: { type: "string" },
        component: { type: "string" },
        payload: { type: "object" },
      },
      required: ["eventType"],
    },
    outputSchema: { type: "object", properties: { eventId: { type: "string" }, eventType: { type: "string" } } },
    annotations: RW,
  },
  {
    name: "ack_list_events",
    title: "List workspace RL events",
    description: "Use when gathering everyone's canonical ACK/Gate events in this workspace for evaluation or RL dataset building.",
    inputSchema: {
      type: "object",
      properties: {
        ...ctxProps,
        limit: { type: "integer" },
        eventType: { type: "string" },
        mineOnly: { type: "boolean" },
      },
    },
    outputSchema: { type: "object", properties: { events: { type: "array" } } },
    annotations: RO,
  },
  {
    name: "ack_export_user_data",
    title: "Export my ACK data",
    description: "Use when the user asks to export their ACK profiles and recent decisions.",
    inputSchema: { type: "object", properties: ctxProps },
    outputSchema: { type: "object" },
    annotations: RO,
  },
  {
    name: "ack_delete_user_data",
    title: "Delete my ACK data",
    description: "Use when the user asks to delete their ACK data for this workspace.",
    inputSchema: { type: "object", properties: ctxProps },
    outputSchema: { type: "object" },
    annotations: DEST,
  },
  {
    name: "ack_revoke_installation",
    title: "Revoke installation",
    description: "Use when the user disconnects the ACK ChatGPT app.",
    inputSchema: { type: "object", properties: ctxProps },
    outputSchema: { type: "object" },
    annotations: DEST,
  },
];

export const TELEMETRY_REGISTRY_TOOLS = [
  { name: "ack_register_component", title: "Register telemetry component", description: "Register a versioned enforcement or telemetry component and its capabilities. Facts and schemas only; no rewards.", inputSchema: { type: "object", properties: { componentId: { type: "string" }, version: { type: "string" }, displayName: { type: "string" }, capabilities: { type: "array", items: { type: "string" } }, eventTypes: { type: "array", items: { type: "string" } }, attributeNamespaces: { type: "array", items: { type: "string" } } }, required: ["componentId", "version"] }, outputSchema: { type: "object" }, annotations: RW },
  { name: "ack_list_components", title: "List telemetry components", description: "List active versioned telemetry components in this workspace.", inputSchema: { type: "object", properties: ctxProps }, outputSchema: { type: "object" }, annotations: RO },
  { name: "ack_register_attribute", title: "Register telemetry attribute", description: "Register a namespaced, versioned attribute definition for canonical events.", inputSchema: { type: "object", properties: { ...ctxProps, namespace: { type: "string" }, name: { type: "string" }, version: { type: "string" }, dataType: { type: "string" }, schema: { type: "object" }, sensitivity: { type: "string" }, required: { type: "boolean" } }, required: ["namespace", "name", "version", "dataType"] }, outputSchema: { type: "object" }, annotations: RW },
  { name: "ack_list_attributes", title: "List telemetry attributes", description: "List active namespaced telemetry attributes.", inputSchema: { type: "object", properties: { ...ctxProps, namespace: { type: "string" } } }, outputSchema: { type: "object" }, annotations: RO },
  { name: "ack_register_event_schema", title: "Register event schema", description: "Register a versioned schema for a canonical event type.", inputSchema: { type: "object", properties: { ...ctxProps, eventType: { type: "string" }, version: { type: "string" }, schema: { type: "object" } }, required: ["eventType", "version", "schema"] }, outputSchema: { type: "object" }, annotations: RW },
  { name: "ack_list_event_schemas", title: "List event schemas", description: "List active canonical event schemas.", inputSchema: { type: "object", properties: { ...ctxProps, eventType: { type: "string" } } }, outputSchema: { type: "object" }, annotations: RO },
  { name: "ack_record_intervention", title: "Record intervention", description: "Record which component and policy intervened, including requirements and resolution linkage. Facts only; no reward.", inputSchema: { type: "object", properties: { ...ctxProps, eventId: { type: "string" }, componentId: { type: "string" }, componentVersion: { type: "string" }, policyId: { type: "string" }, policyVersion: { type: "string" }, decision: { type: "string" }, requirements: { type: "array", items: { type: "string" } }, resolvedBy: { type: "string" }, resolutionEventId: { type: "string" } }, required: ["eventId", "componentId", "decision"] }, outputSchema: { type: "object" }, annotations: RW },
  { name: "ack_list_interventions", title: "List interventions", description: "List intervention facts for downstream evaluation or trajectory building.", inputSchema: { type: "object", properties: { ...ctxProps, limit: { type: "integer" } } }, outputSchema: { type: "object" }, annotations: RO },
];

HOSTED_TOOLS.push(...TELEMETRY_REGISTRY_TOOLS);
export const HOSTED_TOOL_NAMES = HOSTED_TOOLS.map((t) => t.name);
