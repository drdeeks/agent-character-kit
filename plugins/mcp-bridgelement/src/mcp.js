import { HOSTED_TOOLS } from "@drdeeks/character-kit-mcp-contract";
import { AuthError, resolveIdentity } from "./auth.js";
import { buildRlEvent } from "./rl-events.js";
import { runHostedTool } from "./tools.js";

export const MCP_PROTOCOL_VERSION = "2025-03-26";

export function mcpReadable(data) {
  if (!data || typeof data !== "object") return String(data ?? "");
  if (data.error) return String(data.error);
  if (data.decision) return `${data.decision}: ${(data.reasonCodes || []).join(", ") || "ok"}`;
  if (data.ok === true) return "ok";
  if (data.profileId) return `profile ${data.profileId}`;
  return JSON.stringify(data);
}

export function mcpToolResult(data) {
  const isError = !!(data && typeof data.error === "string");
  return {
    structuredContent: data && typeof data === "object" ? data : { value: data },
    content: [{ type: "text", text: mcpReadable(data) }],
    isError,
  };
}

export async function handleMcpJsonRpc(body, ctx) {
  const id = body?.id ?? null;
  const method = body?.method;
  if (method === "notifications/initialized") return null;
  if (method === "initialize") {
    return {
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "mcp-bridgelement", version: ctx.version || "1.9.1" },
      },
    };
  }
  if (method === "tools/list") {
    return { jsonrpc: "2.0", id, result: { tools: HOSTED_TOOLS } };
  }
  if (method === "tools/call") {
    const name = body?.params?.name;
    const args = body?.params?.arguments || {};
    const data = await runHostedTool(name, args, ctx);
    return { jsonrpc: "2.0", id, result: mcpToolResult(data) };
  }
  return {
    jsonrpc: "2.0",
    id,
    error: { code: -32601, message: `unknown method ${method}` },
  };
}

export async function handleFetch(request, env, store) {
  const url = new URL(request.url);
  if (request.method === "GET" && url.pathname === "/health") {
    return json({ ok: true, service: "mcp-bridgelement" });
  }
  let identity;
  try {
    identity = resolveIdentity(request, env);
  } catch (err) {
    const status = err instanceof AuthError ? 401 : 400;
    return json({ error: err.message }, status);
  }
  if (request.method === "POST" && url.pathname === "/events") {
    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: "parse error" }, 400);
    }
    const items = Array.isArray(body?.events) ? body.events : [body];
    const accepted = [];
    for (const item of items) {
      if (!item || !item.eventType) continue;
      try {
        const event = buildRlEvent(identity, item.eventType, item);
        await store.appendEvent(identity, event);
        accepted.push(event.eventId);
      } catch (err) {
        if (err.code === "invalid") continue;
        return json({ error: err.message }, 400);
      }
    }
    return json({ ok: true, accepted: accepted.length, eventIds: accepted });
  }
  if (request.method !== "POST" || url.pathname !== "/mcp") {
    return new Response("Not found", { status: 404 });
  }
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ jsonrpc: "2.0", error: { code: -32700, message: "parse error" } }, 400);
  }
  const rpc = await handleMcpJsonRpc(body, {
    identity,
    store,
    version: env.ACK_VERSION,
  });
  if (rpc == null) return new Response(null, { status: 204 });
  return json(rpc);
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json" },
  });
}
