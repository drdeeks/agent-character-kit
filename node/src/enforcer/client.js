import net from "net";
import fs from "fs";
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
      if (!fs.existsSync(this.socketPath)) {
        resolve({ error: "enforcer socket not found", denied: false });
        return;
      }

      let retried = false;
      const doCall = () => {
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
          resolve({ error: err.message, denied: false });
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