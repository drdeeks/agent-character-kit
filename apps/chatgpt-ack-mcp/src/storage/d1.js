import { defaultProfile, validateProfile } from "@drdeeks/character-kit-config-schema";
import { newId, nowIso } from "../ids.js";

/** Production D1 implementation of the store consumed by hosted tools. */
export class D1Store {
  constructor(db, { provider = "chatgpt" } = {}) {
    if (!db || typeof db.prepare !== "function") throw new TypeError("ACK_DB must be a D1 binding");
    this.db = db;
    this.provider = String(provider || "chatgpt");
    this.writeCounts = new Map();
  }

  async query(sql, ...values) {
    try {
      return await this.db.prepare(sql).bind(...values).all();
    } catch (err) {
      throw storageError(err);
    }
  }
  async first(sql, ...values) {
    try {
      return await this.db.prepare(sql).bind(...values).first();
    } catch (err) {
      throw storageError(err);
    }
  }
  async run(sql, ...values) {
    try {
      return await this.db.prepare(sql).bind(...values).run();
    } catch (err) {
      throw storageError(err);
    }
  }

  async ensureTenant(identity) {
    const ts = nowIso();
    await this.run("INSERT OR IGNORE INTO workspaces (id, provider, created_at, updated_at, status) VALUES (?, ?, ?, ?, 'active')", identity.workspaceId, this.provider, ts, ts);
    await this.run("INSERT OR IGNORE INTO users (id, provider, external_id, created_at, updated_at, status) VALUES (?, ?, ?, ?, ?, 'active')", identity.userId, this.provider, identity.userId, ts, ts);
    await this.run("INSERT OR IGNORE INTO workspace_members (workspace_id, user_id, created_at) VALUES (?, ?, ?)", identity.workspaceId, identity.userId, ts);
    await this.run("INSERT OR IGNORE INTO installations (id, workspace_id, owner_user_id, provider, created_at, updated_at, status) VALUES (?, ?, ?, ?, ?, ?, 'active')", identity.installationId, identity.workspaceId, identity.userId, this.provider, ts, ts);
    const install = await this.first("SELECT id, workspace_id, owner_user_id, status FROM installations WHERE id = ?", identity.installationId);
    if (!install) throw storageError(new Error("installation not found"));
    if (install.status !== "active") throw codeError("installation revoked", "revoked");
    if (install.workspace_id !== identity.workspaceId || install.owner_user_id !== identity.userId) throw codeError("installation tenant mismatch", "forbidden");
    await this.run("INSERT OR IGNORE INTO agents (id, workspace_id, installation_id, created_at, updated_at, status) VALUES (?, ?, ?, ?, ?, 'active')", identity.agentId, identity.workspaceId, identity.installationId, ts, ts);
    const binding = await this.first("SELECT profile_id FROM agent_profile_bindings WHERE installation_id = ? AND agent_id = ? AND workspace_id = ? AND status = 'active'", identity.installationId, identity.agentId, identity.workspaceId);
    if (!binding) {
      const profile = await this.createProfile(identity, { name: "default" });
      await this.run("INSERT INTO agent_profile_bindings (installation_id, agent_id, profile_id, workspace_id, created_at, updated_at, status) VALUES (?, ?, ?, ?, ?, ?, 'active')", identity.installationId, identity.agentId, profile.profileId, identity.workspaceId, ts, ts);
    }
    return this.getActiveProfile(identity);
  }

  profileFromRow(row) {
    if (!row) return null;
    let body;
    try { body = JSON.parse(row.body || "{}"); } catch { throw storageError(new Error("invalid profile body")); }
    return { ...body, profileId: row.id, workspaceId: row.workspace_id, ownerUserId: row.owner_user_id, version: row.version, status: row.status, updatedAt: row.updated_at };
  }
  async createProfile(identity, input) {
    const profileId = newId("profile");
    const checked = validateProfile({ ...input, profileId, name: input.name || "default" });
    if (!checked.ok) throw codeError(checked.errors.join("; "), "invalid");
    const profile = defaultProfile(checked.profile);
    const ts = nowIso();
    await this.run("INSERT INTO character_profiles (id, workspace_id, owner_user_id, name, body, created_at, updated_at, version, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active')", profileId, identity.workspaceId, identity.userId, profile.name, JSON.stringify(profile), ts, ts, profile.version || 1);
    await this.auditEvent(identity, "profile.create", { profileId });
    return this.getProfile(identity, profileId);
  }
  async listProfiles(identity) {
    const result = await this.query("SELECT * FROM character_profiles WHERE workspace_id = ? AND owner_user_id = ? AND status != 'deleted' ORDER BY created_at ASC", identity.workspaceId, identity.userId);
    return (result.results || []).map((r) => this.profileFromRow(r));
  }
  async getProfile(identity, profileId) {
    const row = await this.first("SELECT * FROM character_profiles WHERE id = ? AND workspace_id = ? AND owner_user_id = ? AND status != 'deleted'", profileId, identity.workspaceId, identity.userId);
    return this.profileFromRow(row);
  }
  async getActiveProfile(identity) {
    const row = await this.first("SELECT profile_id FROM agent_profile_bindings WHERE installation_id = ? AND agent_id = ? AND workspace_id = ? AND status = 'active'", identity.installationId, identity.agentId, identity.workspaceId);
    return row ? this.getProfile(identity, row.profile_id) : null;
  }
  async updateProfile(identity, profileId, patch) {
    const current = await this.getProfile(identity, profileId);
    if (!current) throw codeError("profile not found", "not_found");
    const checked = validateProfile({ ...current, ...patch, profileId, version: (current.version || 1) + 1 });
    if (!checked.ok) throw codeError(checked.errors.join("; "), "invalid");
    const profile = defaultProfile(checked.profile);
    const ts = nowIso();
    await this.run("UPDATE character_profiles SET name = ?, body = ?, updated_at = ?, version = ? WHERE id = ? AND workspace_id = ? AND owner_user_id = ? AND status = 'active'", profile.name, JSON.stringify(profile), ts, profile.version, profileId, identity.workspaceId, identity.userId);
    await this.auditEvent(identity, "profile.update", { profileId, version: profile.version });
    return this.getProfile(identity, profileId);
  }
  async selectProfile(identity, profileId) {
    const profile = await this.getProfile(identity, profileId);
    if (!profile) throw codeError("profile not found", "not_found");
    const result = await this.run("UPDATE agent_profile_bindings SET profile_id = ?, updated_at = ? WHERE installation_id = ? AND agent_id = ? AND workspace_id = ? AND status = 'active'", profileId, nowIso(), identity.installationId, identity.agentId, identity.workspaceId);
    if (!result?.meta?.changes) throw codeError("profile binding not found", "not_found");
    await this.auditEvent(identity, "profile.select", { profileId });
    return profile;
  }
  async recordDecision(identity, row) {
    const rec = { id: row.decisionId || newId("decision"), workspaceId: identity.workspaceId, ownerUserId: identity.userId, installationId: identity.installationId, profileId: row.profileId, profileVersion: row.profileVersion, decision: row.decision, tool: row.tool || null, command: (row.command || "").slice(0, 200), reasonCodes: row.reasonCodes || [], createdAt: nowIso() };
    await this.run("INSERT INTO tool_decisions (id, workspace_id, owner_user_id, installation_id, profile_id, profile_version, decision, tool, command, reason_codes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", rec.id, rec.workspaceId, rec.ownerUserId, rec.installationId, rec.profileId, rec.profileVersion, rec.decision, rec.tool, rec.command, JSON.stringify(rec.reasonCodes), rec.createdAt);
    if (row.decision === "hold") await this.run("INSERT INTO holds (id, workspace_id, owner_user_id, decision_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'open', ?, ?)", newId("hold"), identity.workspaceId, identity.userId, rec.id, rec.createdAt, rec.createdAt);
    return rec;
  }
  async listDecisions(identity, limit = 20) {
    const cap = Math.max(1, Math.min(100, Number(limit) || 20));
    const result = await this.query("SELECT * FROM tool_decisions WHERE workspace_id = ? AND owner_user_id = ? ORDER BY created_at DESC LIMIT ?", identity.workspaceId, identity.userId, cap);
    return (result.results || []).map((r) => ({ id: r.id, workspaceId: r.workspace_id, ownerUserId: r.owner_user_id, installationId: r.installation_id, profileId: r.profile_id, profileVersion: r.profile_version, decision: r.decision, tool: r.tool, command: r.command, reasonCodes: parseJson(r.reason_codes, []), createdAt: r.created_at }));
  }
  async addAck(identity, { habitName, reason, decisionId }) {
    const rec = { id: newId("ack"), workspaceId: identity.workspaceId, ownerUserId: identity.userId, decisionId: decisionId || null, habitName, reason, createdAt: nowIso() };
    await this.run("INSERT INTO acknowledgments (id, workspace_id, owner_user_id, decision_id, habit_name, reason, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)", rec.id, rec.workspaceId, rec.ownerUserId, rec.decisionId, rec.habitName, rec.reason, rec.createdAt);
    if (decisionId) await this.run("UPDATE holds SET status = 'acked', updated_at = ? WHERE decision_id = ? AND workspace_id = ? AND owner_user_id = ? AND status = 'open'", rec.createdAt, decisionId, identity.workspaceId, identity.userId);
    await this.auditEvent(identity, "ack", { habitName });
    return rec;
  }
  async recentAcks(identity, n = 10) {
    const result = await this.query("SELECT * FROM acknowledgments WHERE workspace_id = ? AND owner_user_id = ? ORDER BY created_at DESC LIMIT ?", identity.workspaceId, identity.userId, Math.max(1, Number(n) || 10));
    return (result.results || []).reverse().map((r) => ({ id: r.id, workspaceId: r.workspace_id, ownerUserId: r.owner_user_id, decisionId: r.decision_id, habitName: r.habit_name, reason: r.reason, createdAt: r.created_at }));
  }
  async openHold(identity) {
    const row = await this.first("SELECT * FROM holds WHERE workspace_id = ? AND owner_user_id = ? AND status = 'open' ORDER BY created_at ASC LIMIT 1", identity.workspaceId, identity.userId);
    return row ? { id: row.id, workspaceId: row.workspace_id, ownerUserId: row.owner_user_id, decisionId: row.decision_id, status: row.status, version: row.version } : null;
  }
  async reportWatchdog(identity, leaseVersion) {
    const current = await this.first("SELECT * FROM watchdog_state WHERE installation_id = ?", identity.installationId);
    if (leaseVersion != null && Number(leaseVersion) < (current?.lease_version || 0)) return current;
    const next = (current?.lease_version || 0) + 1; const ts = nowIso();
    await this.run("INSERT INTO watchdog_state (installation_id, workspace_id, owner_user_id, lease_version, heartbeat_at, status, updated_at) VALUES (?, ?, ?, ?, ?, 'ok', ?) ON CONFLICT(installation_id) DO UPDATE SET lease_version=excluded.lease_version, heartbeat_at=excluded.heartbeat_at, status='ok', updated_at=excluded.updated_at", identity.installationId, identity.workspaceId, identity.userId, next, ts, ts);
    return this.first("SELECT * FROM watchdog_state WHERE installation_id = ?", identity.installationId);
  }
  async auditEvent(identity, action, body) { await this.run("INSERT INTO audit_events (id, workspace_id, owner_user_id, actor_user_id, installation_id, action, body, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", newId("audit"), identity.workspaceId, identity.userId, identity.userId, identity.installationId, action, JSON.stringify(body), nowIso()); }
  rateLimitWrite(identity, max = 30) { const key = `${identity.userId}:${Math.floor(Date.now() / 60000)}`; const n = (this.writeCounts.get(key) || 0) + 1; this.writeCounts.set(key, n); return n <= max; }
  async appendEvent(identity, event) {
    if (event.workspaceId !== identity.workspaceId || event.ownerUserId !== identity.userId) throw codeError("event tenant mismatch", "forbidden");
    await this.run("INSERT OR IGNORE INTO enforcement_events (event_id, workspace_id, owner_user_id, installation_id, event_type, timestamp, session_id, episode_id, task_id, run_id, agent_id, sequence, source, component, parent_event_id, schema_version, payload) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", event.eventId, event.workspaceId, event.ownerUserId, event.installationId, event.eventType, event.timestamp, event.sessionId || null, event.episodeId || null, event.taskId || null, event.runId || null, event.agentId || null, event.sequence || 0, event.source, event.component || null, event.parentEventId || null, event.schemaVersion || "1", JSON.stringify(event.payload || {}));
    return event;
  }
  async listEvents(identity, { limit = 50, eventType, mineOnly = false } = {}) {
    const cap = Math.max(1, Math.min(200, Number(limit) || 50)); const params = [identity.workspaceId]; let sql = "SELECT * FROM enforcement_events WHERE workspace_id = ?";
    if (mineOnly) { sql += " AND owner_user_id = ?"; params.push(identity.userId); } if (eventType) { sql += " AND event_type = ?"; params.push(eventType); } sql += " ORDER BY timestamp DESC LIMIT ?"; params.push(cap);
    const result = await this.query(sql, ...params); return (result.results || []).map((r) => ({ eventId: r.event_id, workspaceId: r.workspace_id, ownerUserId: r.owner_user_id, installationId: r.installation_id, eventType: r.event_type, timestamp: r.timestamp, sessionId: r.session_id, episodeId: r.episode_id, taskId: r.task_id, runId: r.run_id, agentId: r.agent_id, sequence: r.sequence, source: r.source, component: r.component, parentEventId: r.parent_event_id, schemaVersion: r.schema_version, payload: parseJson(r.payload, {}) }));
  }
  async exportUser(identity) { return { profiles: await this.listProfiles(identity), decisions: await this.listDecisions(identity, 100), acknowledgments: (await this.recentAcks(identity, 100)), events: await this.listEvents(identity, { limit: 100, mineOnly: true }) }; }
  async deleteUser(identity) { await this.run("UPDATE character_profiles SET status = 'deleted', updated_at = ? WHERE workspace_id = ? AND owner_user_id = ?", nowIso(), identity.workspaceId, identity.userId); await this.run("DELETE FROM tool_decisions WHERE workspace_id = ? AND owner_user_id = ?", identity.workspaceId, identity.userId); await this.run("DELETE FROM acknowledgments WHERE workspace_id = ? AND owner_user_id = ?", identity.workspaceId, identity.userId); await this.run("DELETE FROM enforcement_events WHERE workspace_id = ? AND owner_user_id = ?", identity.workspaceId, identity.userId); await this.auditEvent(identity, "user.delete", {}); }
  async revokeInstallation(identity) { await this.run("UPDATE installations SET status = 'revoked', updated_at = ? WHERE id = ? AND workspace_id = ? AND owner_user_id = ?", nowIso(), identity.installationId, identity.workspaceId, identity.userId); await this.auditEvent(identity, "installation.revoke", {}); }
}

function parseJson(value, fallback) { try { return JSON.parse(value); } catch { return fallback; } }
function codeError(message, code) { const err = new Error(message); err.code = code; return err; }
function storageError(err) { if (err?.code === "storage") return err; const out = new Error(`D1 storage failure: ${err?.message || err}`); out.code = "storage"; return out; }
