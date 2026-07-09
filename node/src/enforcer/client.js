import net from "net";
import fs from "fs";
import path from "path";

const DEFAULT_SOCKET = path.join(
  process.env.HOME || "/root",
  "run", "agent-enforcer", "main.sock"
);

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
    const response = await this.call("execute_tool", {
      tool,
      params,
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
