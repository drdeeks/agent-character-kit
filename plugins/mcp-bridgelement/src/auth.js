/**
 * Identity comes from the authenticated connection, never from tool args.
 */

export class AuthError extends Error {
  constructor(message) {
    super(message);
    this.name = "AuthError";
    this.code = "unauthorized";
  }
}

/**
 * @param {Request} request
 * @param {object} [env]
 */
export function resolveIdentity(request, env = {}) {
  const provider = env.ACK_PROVIDER || "agnostic";
  const defaultAgent = env.ACK_DEFAULT_AGENT || "default-agent";
  const url = new URL(request.url);
  const headers = request.headers;
  const bearer = bearerToken(headers.get("authorization"));

  if (env.ACK_ALLOW_TEST_IDENTITY === "1") {
    const test = headers.get("x-ack-test-identity");
    if (test) return parseTestIdentity(test, { provider, defaultAgent });
  }

  const accessEmail = headers.get("cf-access-authenticated-user-email");
  const workspace = headers.get("x-ack-workspace-id") || env.ACK_DEFAULT_WORKSPACE_ID;
  if (accessEmail && workspace) {
    return identityFromParts({
      workspaceId: workspace,
      userId: `user_${slug(provider)}_${slug(accessEmail)}`,
      installationId: headers.get("x-ack-installation-id") || `install_${slug(workspace)}_${slug(accessEmail)}`,
      agentId: headers.get("x-ack-agent-id") || defaultAgent,
      conversationId: headers.get("x-ack-conversation-id") || null,
      provider,
    });
  }

  if (bearer && env.ACK_BOOTSTRAP_TOKEN && bearer === env.ACK_BOOTSTRAP_TOKEN) {
    throw new AuthError("bootstrap token is not a user identity");
  }

  if (url.pathname === "/health") return null;
  throw new AuthError("missing ChatGPT/OAuth identity");
}

function bearerToken(header) {
  if (!header) return "";
  const m = String(header).match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : "";
}

function slug(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 80);
}

function parseTestIdentity(raw, defaults = {}) {
  const parts = Object.fromEntries(
    String(raw).split(",").map((kv) => {
      const i = kv.indexOf("=");
      return i === -1 ? [kv, ""] : [kv.slice(0, i).trim(), kv.slice(i + 1).trim()];
    })
  );
  return identityFromParts({
    workspaceId: parts.workspace || parts.workspaceId,
    userId: parts.user || parts.userId,
    installationId: parts.installation || parts.installationId,
    agentId: parts.agent || parts.agentId || defaults.defaultAgent || "default-agent",
    provider: parts.provider || defaults.provider || "agnostic",
    conversationId: parts.conversation || parts.conversationId || null,
  });
}

export function identityFromParts(parts) {
  const workspaceId = String(parts.workspaceId || "").trim();
  const userId = String(parts.userId || "").trim();
  const installationId = String(parts.installationId || "").trim();
  const agentId = String(parts.agentId || parts.defaultAgent || "default-agent").trim();
  if (!workspaceId || !userId || !installationId) {
    throw new AuthError("identity requires workspace, user, and installation");
  }
  return {
    provider: parts.provider || parts.defaultProvider || "agnostic",
    workspaceId,
    userId,
    installationId,
    agentId,
    conversationId: parts.conversationId || null,
  };
}

/** Model-supplied user_id must never win. */
export function ignoreModelIdentity(args = {}) {
  const out = { ...args };
  delete out.user_id;
  delete out.userId;
  delete out.workspace_id;
  delete out.workspaceId;
  return out;
}
