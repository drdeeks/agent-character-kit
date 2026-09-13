/**
 * v0 RPC method table.
 * Watchtower uses execute_tool, get_habit, submit_ack, heartbeat only.
 * Do not rename those four.
 */

export function dispatchV0(enforcer, request, options = {}) {
  const expected = process.env.ACK_AUTH_TOKEN;
  if (expected && request.method !== "status" && request.token !== expected) {
    return { error: "unauthorized" };
  }
  const params = request.params;
  switch (request.method) {
    case "status": {
      const body = { ok: true };
      if (options.includePid) body.pid = process.pid;
      body.version = options.version;
      body.workspace = enforcer.cfg.WORKSPACE;
      body.socket = enforcer.cfg.SOCKET;
      body.habits = enforcer.habits.length;
      body.sessions = enforcer.HOLD_STATE.size;
      return body;
    }
    case "execute_tool":
      return enforcer.executeTool(params.tool, params);
    case "heartbeat":
      return enforcer.heartbeat();
    case "validate_workspace":
      return enforcer.validate_workspace();
    case "reload":
      enforcer.reload();
      return { ok: true, character_hash: enforcer.characterHash };
    case "get_habit":
      return enforcer.getHabit(params?.name);
    case "pick_prompt":
      return enforcer.pickPrompt(params?.session_id || "default");
    case "tool_tick":
      return enforcer.toolTick(
        params?.session_id || "default",
        params?.tool || "",
        params?.file_path
      );
    case "submit_ack":
      return enforcer.submitAck(
        params?.session_id || "default",
        params?.statement || ""
      );
    case "register_workspace":
      if (typeof options.registerWorkspace === "function") {
        return options.registerWorkspace(params?.workspace);
      }
      return { error: "unknown method" };
    default:
      return { error: "unknown method" };
  }
}
