/**
 * Opt-in MCP streamable HTTP (POST JSON-RPC).
 * Off unless ACK_MCP_HTTP is set. Unix/tcp v0 is unchanged.
 * Watchtower stays on NDJSON; this is an extra surface over dispatchV0.
 */

import http from "http";
import { readFileSync } from "fs";
import { VERSION } from "../../../node/src/version.js";
import { dispatchV0 } from "./dispatch-v0.js";
import { parseListenTarget } from "./jsonl-server.js";
import { CONFIG_TOOLS, CONFIG_TOOL_NAMES, runConfigTool } from "./config-tools.js";

const CONFIG_WIDGET_HTML = readFileSync(new URL("./config-widget.html", import.meta.url), "utf8");

export const MCP_PROTOCOL_VERSION = "2025-03-26";

const V0_METHODS = [
  "execute_tool",
  "get_habit",
  "submit_ack",
  "heartbeat",
  "status",
  "reload",
  "pick_prompt",
  "tool_tick",
  "validate_workspace",
  "register_workspace",
];

const RO = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
const RW = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };

export function mcpReadable(data) {
  if (!data || typeof data !== "object") return String(data ?? "");
  if (typeof data.error === "string") return data.error;
  if (data.denied === true) return `Blocked: ${data.reason || "denied"}`;
  if (data.denied === false) return "Allowed";
  if (Array.isArray(data.habits)) return `Found ${data.habits.length} habits`;
  if (Array.isArray(data.prompts)) return `Found ${data.prompts.length} habit prompts`;
  if (data.status === "ok") return `Heartbeat ok (${data.version || "ack"})`;
  if (data.ok === true && data.character_hash) return `Reloaded ${data.character_hash}`;
  if (data.ok === true) return "ok";
  if (typeof data.name === "string") return `Habit ${data.name}`;
  return JSON.stringify(data);
}

export function mcpToolResult(data) {
  const isError = !!(data && typeof data.error === "string");
  const structuredContent = data && typeof data === "object" ? data : { value: data };
  return {
    structuredContent,
    content: [{ type: "text", text: mcpReadable(data) }],
    isError,
  };
}

export const MCP_TOOLS = [
  {
    name: "execute_tool",
    title: "Gate tool call",
    description: "Use when a host tool is about to run. Fail-closed. Same v0 method Watchtower uses. Does not replace authorization.",
    inputSchema: {
      type: "object",
      properties: {
        tool: { type: "string" },
        command: { type: "string" },
        session_id: { type: "string" },
      },
      required: ["tool"],
    },
    outputSchema: {
      type: "object",
      properties: {
        denied: { type: "boolean" },
        reason: { type: "string" },
        reflection: { type: "string" },
        error: { type: "string" },
      },
    },
    annotations: RW,
  },
  {
    name: "get_habit",
    title: "Get habit",
    description: "Use when the user or agent needs one habit's prompt, assert, evidence, and logic.",
    inputSchema: {
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
    },
    outputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        prompt: { type: "string" },
        error: { type: "string" },
      },
      additionalProperties: true,
    },
    annotations: RO,
  },
  {
    name: "submit_ack",
    title: "Submit acknowledgment",
    description: "Use when the agent must submit a habit acknowledgment with real work attribution.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: { type: "string" },
        statement: { type: "string" },
      },
      required: ["statement"],
    },
    outputSchema: {
      type: "object",
      properties: {
        ok: { type: "boolean" },
        error: { type: "string" },
      },
    },
    annotations: RW,
  },
  {
    name: "heartbeat",
    title: "Heartbeat",
    description: "Use to ping daemon liveness. Same v0 method Watchtower uses.",
    inputSchema: { type: "object", properties: {} },
    outputSchema: {
      type: "object",
      properties: {
        status: { type: "string" },
        version: { type: "string" },
        character_hash: { type: "string" },
        error: { type: "string" },
      },
    },
    annotations: RO,
  },
  {
    name: "status",
    title: "Daemon status",
    description: "Use to read daemon health. v0 status is unauthenticated; MCP still sends the bearer token when ACK_AUTH_TOKEN is set.",
    inputSchema: { type: "object", properties: {} },
    outputSchema: {
      type: "object",
      properties: {
        ok: { type: "boolean" },
        version: { type: "string" },
        workspace: { type: "string" },
        error: { type: "string" },
      },
    },
    annotations: RO,
  },
  {
    name: "reload",
    title: "Reload character",
    description: "Use after YAML edits to re-read constitution, habits, and policy.",
    inputSchema: { type: "object", properties: {} },
    outputSchema: {
      type: "object",
      properties: {
        ok: { type: "boolean" },
        character_hash: { type: "string" },
        error: { type: "string" },
      },
    },
    annotations: RW,
  },
  {
    name: "pick_prompt",
    title: "Pick habit prompts",
    description: "Use for fail-open injection: next 2–3 habit prompt strings only.",
    inputSchema: {
      type: "object",
      properties: { session_id: { type: "string" } },
    },
    outputSchema: {
      type: "object",
      properties: {
        prompts: { type: "array", items: { type: "string" } },
        error: { type: "string" },
      },
    },
    annotations: RO,
  },
  {
    name: "tool_tick",
    title: "Count tool tick",
    description: "Use to count a non-search tool toward the hold window. Not a Watchtower v0 method.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: { type: "string" },
        tool: { type: "string" },
        file_path: { type: "string" },
      },
    },
    outputSchema: {
      type: "object",
      properties: {
        hold: { type: "boolean" },
        reason: { type: "string" },
        error: { type: "string" },
      },
    },
    annotations: RW,
  },
  ...CONFIG_TOOLS,
];

export function parseMcpListenTarget(raw) {
  if (!raw || typeof raw !== "string") return null;
  const s = raw.trim();
  if (!s) return null;
  if (s.startsWith("tcp://")) return parseListenTarget(s);
  if (/^\d+$/.test(s)) return { isTcp: true, host: "127.0.0.1", port: parseInt(s, 10) };
  const colon = s.lastIndexOf(":");
  if (colon > 0) {
    return {
      isTcp: true,
      host: s.slice(0, colon) || "127.0.0.1",
      port: parseInt(s.slice(colon + 1), 10) || 8754,
    };
  }
  return { isTcp: true, host: "127.0.0.1", port: 8754 };
}

export function bearerToken(headers = {}) {
  const raw = headers.authorization || headers.Authorization || headers["x-ack-token"] || headers["X-Ack-Token"] || "";
  const s = String(raw);
  if (s.toLowerCase().startsWith("bearer ")) return s.slice(7).trim();
  return s.trim() || undefined;
}

function rpcError(id, code, message) {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}

function rpcResult(id, result) {
  return { jsonrpc: "2.0", id, result };
}

export function handleMcpJsonRpc(enforcer, message, options = {}) {
  if (message === null || typeof message !== "object" || Array.isArray(message)) {
    return rpcError(null, -32600, "invalid request");
  }
  if (message.jsonrpc && message.jsonrpc !== "2.0") {
    return rpcError(message.id ?? null, -32600, "invalid request");
  }
  const method = message.method;
  const id = Object.prototype.hasOwnProperty.call(message, "id") ? message.id : undefined;
  const isNotification = id === undefined;

  if (method === "notifications/initialized" || method === "initialized") {
    return isNotification ? null : rpcResult(id, {});
  }
  if (method === "ping") {
    return isNotification ? null : rpcResult(id, {});
  }
  if (method === "initialize") {
    return rpcResult(id ?? null, {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: { tools: { listChanged: false } },
      serverInfo: {
        name: "agent-character-kit",
        version: options.version || VERSION,
      },
    });
  }
  if (method === "tools/list") {
    return rpcResult(id ?? null, { tools: MCP_TOOLS });
  }
  if (method === "tools/call") {
    const name = message.params?.name;
    const args = message.params?.arguments || {};
    if (name && CONFIG_TOOL_NAMES.includes(name)) {
      const expected = process.env.ACK_AUTH_TOKEN;
      if (expected && options.token !== expected) {
        return rpcResult(id ?? null, {
          content: [{ type: "text", text: JSON.stringify({ error: "unauthorized" }) }],
          isError: true,
        });
      }
      const out = runConfigTool(enforcer, name, args);
      return rpcResult(id ?? null, mcpToolResult(out));
    }
    if (!name || !V0_METHODS.includes(name)) {
      return rpcError(id ?? null, -32602, `unknown tool: ${name || "(missing)"}`);
    }
    const v0 = dispatchV0(enforcer, {
      method: name,
      params: args,
      token: options.token,
    }, {
      version: options.version,
      includePid: options.includePid,
      registerWorkspace: options.registerWorkspace,
    });
    return rpcResult(id ?? null, mcpToolResult(v0));
  }
  return rpcError(id ?? null, -32601, `method not found: ${method}`);
}

export function startMcpHttpServer(enforcer, raw, options = {}) {
  const target = parseMcpListenTarget(raw);
  if (!target || !target.isTcp) {
    console.error("ACK_MCP_HTTP must be tcp://host:port, host:port, or a port");
    return null;
  }
  const server = http.createServer((req, res) => {
    const url = (req.url || "/").split("?")[0];
    if (req.method === "GET" && (url === "/config" || url === "/config/")) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(CONFIG_WIDGET_HTML);
      return;
    }
    if (req.method === "GET" && (url === "/" || url === "/health" || url === "/mcp")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        ok: true,
        transport: "mcp-http",
        protocolVersion: MCP_PROTOCOL_VERSION,
      }));
      return;
    }
    if (req.method !== "POST" || (url !== "/" && url !== "/mcp")) {
      res.writeHead(405, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "method not allowed" }));
      return;
    }
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      let parsed;
      try {
        parsed = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
      } catch {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify(rpcError(null, -32700, "parse error")));
        return;
      }
      const token = bearerToken(req.headers);
      if (Array.isArray(parsed)) {
        const out = parsed.map((m) => handleMcpJsonRpc(enforcer, m, { ...options, token })).filter((x) => x !== null);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(out));
        return;
      }
      const out = handleMcpJsonRpc(enforcer, parsed, { ...options, token });
      if (out === null) {
        res.writeHead(202);
        res.end();
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(out));
    });
  });
  server.listen(target.port, target.host, () => {
    console.log(`ACK MCP HTTP v${options.version || ""} listening on http://${target.host}:${target.port}/mcp (config UI /config)`);
  });
  server.on("error", (err) => {
    console.error("Failed to start ACK MCP HTTP server:", err);
  });
  return server;
}

export function maybeStartMcpHttp(enforcer, options = {}) {
  const raw = process.env.ACK_MCP_HTTP;
  if (!raw) return null;
  return startMcpHttpServer(enforcer, raw, options);
}
