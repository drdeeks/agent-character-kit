import net from "net";
import path from "path";

// Socket default MUST match the daemon (agent_enforcer_daemon.js): it lives
// under AGENT_WORKSPACE/.agent/enforcer.sock so the kit is portable (no /run).
// Override with ENFORCER_SOCKET if your deployment differs.
const DEFAULT_SOCKET = process.env.AGENT_WORKSPACE
  ? path.join(process.env.AGENT_WORKSPACE, ".agent", "enforcer.sock")
  : path.join(process.env.HOME || "/root", ".agent-character-kit", "workspace", ".agent", "enforcer.sock");

const SOCKET_PATH = process.env.ENFORCER_SOCKET || DEFAULT_SOCKET;

/**
 * Enforcer Client — RPC to the character enforcer daemon.
 *
 * The enforcer daemon runs as a separate systemd service.
 * The agent CANNOT modify, patch, or kill it.
 * All tool calls go through here for validation.
 */
export class EnforcerClient {
  constructor(socketPath) {
    this.socketPath = socketPath || SOCKET_PATH;
  }

  /**
   * Send RPC request to enforcer daemon.
   * @param {string} method - RPC method name
   * @param {object} params - Method parameters
   * @returns {Promise<object>} - Response from enforcer
   */
  async call(method, params = {}) {
    return new Promise((resolve, reject) => {
      let retried = false;
      const doCall = () => {
        const socket = net.createConnection(this.socketPath);
      const request = JSON.stringify({ method, params, token: process.env.ACK_AUTH_TOKEN }) + "\n";
        let data = "";

        const timeout = setTimeout(() => {
          socket.destroy();
          resolve({ error: "enforcer timeout", denied: false });
        }, 5000);

        socket.on("connect", () => {
          socket.write(request);
        });

        socket.on("data", (chunk) => {
          data += chunk.toString();
          if (data.includes("\n")) {
            clearTimeout(timeout);
            socket.destroy();
            try {
              const parsed = JSON.parse(data.trim());
              // Retry once on "invalid request" (first-request buffering issue)
              if (parsed.error === "invalid request" && !retried) {
                retried = true;
                console.error("[EnforcerClient] Retrying after invalid request...");
                setTimeout(doCall, 10);
                return;
              }
              resolve(parsed);
            } catch (e) {
              resolve({ error: "invalid response", denied: false });
            }
          }
        });

        socket.on("error", (err) => {
          clearTimeout(timeout);
          // Distinguish real causes instead of collapsing every connect
          // failure into one string -- found live, 2026-08-07, after a real
          // EACCES (socket's group ownership was wrong) got reported as
          // "socket not found" and cost real time to diagnose, because the
          // old fs.existsSync() pre-check this replaced can't tell "doesn't
          // exist" apart from "exists but I can't reach it": existsSync
          // swallows every stat error into a bare `false`. Connecting
          // directly and reading err.code gives the real reason instead.
          let reason;
          if (err.code === "ENOENT") reason = "enforcer socket not found";
          else if (err.code === "EACCES") reason = `permission denied connecting to enforcer socket (${this.socketPath}) -- check the socket's group ownership and that this user is a member of it`;
          else if (err.code === "ECONNREFUSED") reason = "enforcer socket exists but nothing is listening (daemon not running?)";
          else reason = err.message;
          resolve({ error: reason, denied: false });
        });

        socket.on("timeout", () => {
          clearTimeout(timeout);
          socket.destroy();
          resolve({ error: "socket timeout", denied: false });
        });
      };
      doCall();
    });
  }

  /**
   * Validate a tool call through the enforcer.
   * @param {string} tool - Tool name
   * @param {object} params - Tool parameters
   * @param {string} characterHash - Agent character hash
   * @returns {Promise<{allowed: boolean, reason?: string, reflection?: string}>}
   */
  async validateTool(tool, params, characterHash = "unknown") {
    // The daemon's socket contract is FLAT: { method:"execute_tool",
    // params:{ tool, command, character_hash } }. executeTool(tool, params)
    // reads params.command via _extractCommand. Do NOT nest params inside
    // params — that was the bug that made every call pass (command resolved
    // to the tool name instead of the real command).
    const command =
      (params && (params.command || params.cmd || params.code)) || "";
    const response = await this.call("execute_tool", {
      tool,
      command,
      character_hash: characterHash,
    });

    // Enforcer unreachable → fail closed by default (see processToolCall).
    if (response.error) {
      return {
        allowed: false,
        error: true,
        reason: `Enforcer unavailable: ${response.error}`,
        reflection:
          "The enforcer could not be reached. character cannot be verified, " +
          "so the action is blocked. A guard that fails open is no guard.",
      };
    }

    if (response.denied) {
      return {
        allowed: false,
        reason: response.reason || "Denied by enforcer",
        reflection: response.reflection || "",
      };
    }

    return { allowed: true };
  }

  /**
   * Ask the daemon whether this (non-search) tool call should be held for
   * habit acknowledgment / commit discipline. The daemon owns ALL hold
   * state (per-session count, ack ledger, file-touch tracking) — this is a
   * thin ask-and-obey call, same fail-closed posture as validateTool.
   * @param {string} tool
   * @param {string} sessionId
   * @param {string} [filePath] - best-effort file path from tool params,
   *   used for the distinct-file-count commit trigger. Undefined is fine.
   * @returns {Promise<{hold: boolean, reason?: string, commit_required?: boolean}>}
   */
  async toolTick(tool, sessionId = "default", filePath) {
    const response = await this.call("tool_tick", {
      session_id: sessionId,
      tool,
      file_path: filePath,
    });
    // Fail-closed: if the daemon can't be reached, treat it as a hold so the
    // agent re-grounds rather than silently sailing through unmonitored.
    if (response.error) {
      return { hold: true, reason: "Enforcer unavailable — treating as held (fail-closed)." };
    }
    return response;
  }

  /**
   * Ask the daemon for this session's next rotating habit-prompt subset.
   * The daemon owns the rotation state (per session) so it works correctly
   * even when the caller is a fresh CLI process per call (Claude/Cursor/
   * Gemini via `ack hook`), not just long-lived in-process companions.
   * @param {string} sessionId
   * @returns {Promise<{prompts: Array<{prompt:string}>}>}
   */
  async pickPrompt(sessionId = "default") {
    const response = await this.call("pick_prompt", { session_id: sessionId });
    if (response.error) return { prompts: [] };
    return response;
  }

  /**
   * Send heartbeat to enforcer.
   */
  async heartbeat(status = "ok") {
    return this.call("heartbeat", { status });
  }

  /**
   * Validate workspace integrity.
   */
  async validateWorkspace() {
    return this.call("validate_workspace");
  }
}

export default new EnforcerClient();