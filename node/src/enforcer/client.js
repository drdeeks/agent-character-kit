import net from "net";
import fs from "fs";
import path from "path";

// Socket path MUST match the daemon (agent_enforcer_daemon.js) and the
// systemd unit's ENFORCER_SOCKET: /run/agent-enforcer/main.sock.
// Override with ENFORCER_SOCKET if your deployment differs.
const DEFAULT_SOCKET = "/run/agent-enforcer/main.sock";

const SOCKET_PATH = process.env.ENFORCER_SOCKET || DEFAULT_SOCKET;

/**
 * Enforcer Client — RPC to the identity enforcer daemon.
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
      if (!fs.existsSync(this.socketPath)) {
        resolve({ error: "enforcer socket not found", denied: false });
        return;
      }

      const socket = net.createConnection(this.socketPath);
      const request = JSON.stringify({ method, params }) + "\n";
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
            resolve(JSON.parse(data.trim()));
          } catch (e) {
            resolve({ error: "invalid response", denied: false });
          }
        }
      });

      socket.on("error", (err) => {
        clearTimeout(timeout);
        resolve({ error: err.message, denied: false });
      });

      socket.on("timeout", () => {
        clearTimeout(timeout);
        socket.destroy();
        resolve({ error: "socket timeout", denied: false });
      });
    });
  }

  /**
   * Validate a tool call through the enforcer.
   * @param {string} tool - Tool name
   * @param {object} params - Tool parameters
   * @param {string} identityHash - Agent identity hash
   * @returns {Promise<{allowed: boolean, reason?: string, reflection?: string}>}
   */
  async validateTool(tool, params, identityHash = "unknown") {
    // The daemon's socket contract is FLAT: { method:"execute_tool",
    // params:{ tool, command, identity_hash } }. executeTool(tool, params)
    // reads params.command via _extractCommand. Do NOT nest params inside
    // params — that was the bug that made every call pass (command resolved
    // to the tool name instead of the real command).
    const command =
      (params && (params.command || params.cmd || params.code)) || "";
    const response = await this.call("execute_tool", {
      tool,
      command,
      identity_hash: identityHash,
    });

    // Enforcer unreachable → fail closed by default (see processToolCall).
    if (response.error) {
      return {
        allowed: false,
        error: true,
        reason: `Enforcer unavailable: ${response.error}`,
        reflection:
          "The enforcer could not be reached. Identity cannot be verified, " +
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
