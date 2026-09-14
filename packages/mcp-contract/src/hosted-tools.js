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

export const HOSTED_TOOL_NAMES = HOSTED_TOOLS.map((t) => t.name);
