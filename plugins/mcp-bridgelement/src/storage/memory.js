import { defaultProfile, validateProfile } from "@drdeeks/character-kit-config-schema";
import { newId, nowIso } from "../ids.js";

/**
 * In-memory stand-in for D1. Same tenant filters the Worker SQL must use.
 */
export class MemoryStore {
  constructor() {
    this.workspaces = new Map();
    this.users = new Map();
    this.members = new Set();
    this.installations = new Map();
    this.profiles = new Map();
    this.bindings = new Map();
    this.decisions = [];
    this.holds = new Map();
    this.acks = [];
    this.watchdog = new Map();
    this.audit = [];
    this.events = [];
    this.components = new Map();
    this.attributes = new Map();
    this.eventSchemas = new Map();
    this.interventions = new Map();
    this.writeCounts = new Map();
  }

  async ensureTenant(identity) {
    const ts = nowIso();
    if (!this.workspaces.has(identity.workspaceId)) {
      this.workspaces.set(identity.workspaceId, {
        id: identity.workspaceId,
        provider: identity.provider || "agnostic",
        created_at: ts,
        status: "active",
      });
    }
    if (!this.users.has(identity.userId)) {
      this.users.set(identity.userId, {
        id: identity.userId,
        provider: identity.provider || "agnostic",
        external_id: identity.userId,
        created_at: ts,
        status: "active",
      });
    }
    this.members.add(`${identity.workspaceId}:${identity.userId}`);
    if (!this.installations.has(identity.installationId)) {
      this.installations.set(identity.installationId, {
        id: identity.installationId,
        workspace_id: identity.workspaceId,
        owner_user_id: identity.userId,
        status: "active",
        created_at: ts,
      });
    }
    const install = this.installations.get(identity.installationId);
    if (install.status !== "active") {
      const err = new Error("installation revoked");
      err.code = "revoked";
      throw err;
    }
    if (install.workspace_id !== identity.workspaceId || install.owner_user_id !== identity.userId) {
      const err = new Error("installation tenant mismatch");
      err.code = "forbidden";
      throw err;
    }
    const bindKey = `${identity.installationId}:${identity.agentId}`;
    if (!this.bindings.has(bindKey)) {
      const profile = await this.createProfile(identity, { name: "default" });
      this.bindings.set(bindKey, {
        installation_id: identity.installationId,
        agent_id: identity.agentId,
        profile_id: profile.profileId,
        workspace_id: identity.workspaceId,
        status: "active",
      });
    }
    return this.getActiveProfile(identity);
  }

  async createProfile(identity, input) {
    const profileId = newId("profile");
    const checked = validateProfile({
      ...input,
      profileId,
      name: input.name || "default",
    });
    if (!checked.ok) {
      const err = new Error(checked.errors.join("; "));
      err.code = "invalid";
      throw err;
    }
    const profile = defaultProfile(checked.profile);
    this.profiles.set(profile.profileId, {
      ...profile,
      workspaceId: identity.workspaceId,
      ownerUserId: identity.userId,
      updatedAt: nowIso(),
    });
    await this.auditEvent(identity, "profile.create", { profileId: profile.profileId });
    return this.profiles.get(profile.profileId);
  }

  async listProfiles(identity) {
    return [...this.profiles.values()].filter(
      (p) => p.workspaceId === identity.workspaceId && p.ownerUserId === identity.userId && p.status !== "deleted"
    );
  }

  async getProfile(identity, profileId) {
    const p = this.profiles.get(profileId);
    if (!p || p.workspaceId !== identity.workspaceId || p.ownerUserId !== identity.userId) return null;
    if (p.status === "deleted") return null;
    return p;
  }

  async getActiveProfile(identity) {
    const bind = this.bindings.get(`${identity.installationId}:${identity.agentId}`);
    if (!bind || bind.workspace_id !== identity.workspaceId) return null;
    return this.getProfile(identity, bind.profile_id);
  }

  async updateProfile(identity, profileId, patch) {
    const current = await this.getProfile(identity, profileId);
    if (!current) {
      const err = new Error("profile not found");
      err.code = "not_found";
      throw err;
    }
    const nextVersion = current.version + 1;
    const checked = validateProfile({ ...current, ...patch, profileId, version: nextVersion });
    if (!checked.ok) {
      const err = new Error(checked.errors.join("; "));
      err.code = "invalid";
      throw err;
    }
    const profile = defaultProfile(checked.profile);
    this.profiles.set(profileId, {
      ...profile,
      workspaceId: identity.workspaceId,
      ownerUserId: identity.userId,
      updatedAt: nowIso(),
    });
    await this.auditEvent(identity, "profile.update", { profileId, version: profile.version });
    return this.profiles.get(profileId);
  }

  async selectProfile(identity, profileId) {
    const profile = await this.getProfile(identity, profileId);
    if (!profile) {
      const err = new Error("profile not found");
      err.code = "not_found";
      throw err;
    }
    this.bindings.set(`${identity.installationId}:${identity.agentId}`, {
      installation_id: identity.installationId,
      agent_id: identity.agentId,
      profile_id: profileId,
      workspace_id: identity.workspaceId,
      status: "active",
    });
    await this.auditEvent(identity, "profile.select", { profileId });
    return profile;
  }

  async recordDecision(identity, row) {
    const rec = {
      id: row.decisionId || newId("decision"),
      workspaceId: identity.workspaceId,
      ownerUserId: identity.userId,
      installationId: identity.installationId,
      profileId: row.profileId,
      profileVersion: row.profileVersion,
      decision: row.decision,
      tool: row.tool || null,
      command: (row.command || "").slice(0, 200),
      reasonCodes: row.reasonCodes || [],
      createdAt: nowIso(),
    };
    this.decisions.push(rec);
    if (row.decision === "hold") {
      this.holds.set(rec.id, {
        id: newId("hold"),
        workspaceId: identity.workspaceId,
        ownerUserId: identity.userId,
        decisionId: rec.id,
        status: "open",
        version: 1,
      });
    }
    return rec;
  }

  async listDecisions(identity, limit = 20) {
    return this.decisions
      .filter((d) => d.workspaceId === identity.workspaceId && d.ownerUserId === identity.userId)
      .slice(-Math.max(1, Math.min(100, limit)))
      .reverse();
  }

  async addAck(identity, { habitName, reason, decisionId }) {
    const rec = {
      id: newId("ack"),
      workspaceId: identity.workspaceId,
      ownerUserId: identity.userId,
      decisionId: decisionId || null,
      habitName,
      reason,
      createdAt: nowIso(),
    };
    this.acks.push(rec);
    if (decisionId && this.holds.has(decisionId)) {
      const hold = this.holds.get(decisionId);
      if (hold.workspaceId === identity.workspaceId && hold.ownerUserId === identity.userId) {
        hold.status = "acked";
      }
    }
    await this.auditEvent(identity, "ack", { habitName });
    return rec;
  }

  recentAcks(identity, n = 10) {
    return this.acks
      .filter((a) => a.workspaceId === identity.workspaceId && a.ownerUserId === identity.userId)
      .slice(-n);
  }

  openHold(identity) {
    return [...this.holds.values()].find(
      (h) => h.workspaceId === identity.workspaceId && h.ownerUserId === identity.userId && h.status === "open"
    );
  }

  async reportWatchdog(identity, leaseVersion) {
    const current = this.watchdog.get(identity.installationId);
    const nextVersion = (current?.lease_version || 0) + 1;
    if (leaseVersion != null && Number(leaseVersion) < (current?.lease_version || 0)) {
      return current;
    }
    const rec = {
      installation_id: identity.installationId,
      workspace_id: identity.workspaceId,
      owner_user_id: identity.userId,
      lease_version: nextVersion,
      heartbeat_at: nowIso(),
      status: "ok",
      updated_at: nowIso(),
    };
    this.watchdog.set(identity.installationId, rec);
    return rec;
  }

  async auditEvent(identity, action, body) {
    this.audit.push({
      id: newId("audit"),
      workspaceId: identity.workspaceId,
      ownerUserId: identity.userId,
      actorUserId: identity.userId,
      installationId: identity.installationId,
      action,
      body,
      createdAt: nowIso(),
    });
  }

  rateLimitWrite(identity, max = 30) {
    const key = `${identity.userId}:${Math.floor(Date.now() / 60000)}`;
    const n = (this.writeCounts.get(key) || 0) + 1;
    this.writeCounts.set(key, n);
    return n <= max;
  }

  async appendEvent(identity, event) {
    if (event.workspaceId !== identity.workspaceId || event.ownerUserId !== identity.userId) {
      const err = new Error("event tenant mismatch");
      err.code = "forbidden";
      throw err;
    }
    if (this.events.some((e) => e.eventId === event.eventId)) return event;
    this.events.push(event);
    return event;
  }

  async listEvents(identity, { limit = 50, eventType, mineOnly = false } = {}) {
    const cap = Math.max(1, Math.min(200, Number(limit) || 50));
    return this.events
      .filter((e) => e.workspaceId === identity.workspaceId)
      .filter((e) => (mineOnly ? e.ownerUserId === identity.userId : true))
      .filter((e) => (eventType ? e.eventType === eventType : true))
      .slice(-cap)
      .reverse();
  }

  async registerComponent(identity, input) {
    const rec = { workspaceId: identity.workspaceId, componentId: input.componentId, version: input.version, displayName: input.displayName || input.componentId, capabilities: input.capabilities || [], eventTypes: input.eventTypes || [], attributeNamespaces: input.attributeNamespaces || [], status: input.status || "active", createdAt: nowIso(), updatedAt: nowIso() };
    this.components.set(`${identity.workspaceId}:${rec.componentId}:${rec.version}`, rec);
    return rec;
  }

  async listComponents(identity) { return [...this.components.values()].filter((v) => v.workspaceId === identity.workspaceId && v.status === "active"); }

  async registerAttribute(identity, input) {
    const rec = { workspaceId: identity.workspaceId, namespace: input.namespace, name: input.name, version: input.version, dataType: input.dataType, schema: input.schema || {}, sensitivity: input.sensitivity || "metadata", required: input.required === true, status: input.status || "active", createdAt: nowIso(), updatedAt: nowIso() };
    this.attributes.set(`${identity.workspaceId}:${rec.namespace}:${rec.name}:${rec.version}`, rec);
    return rec;
  }

  async listAttributes(identity, namespace) { return [...this.attributes.values()].filter((v) => v.workspaceId === identity.workspaceId && v.status === "active" && (!namespace || v.namespace === namespace)); }

  async registerEventSchema(identity, input) {
    const rec = { workspaceId: identity.workspaceId, eventType: input.eventType, version: input.version, schema: input.schema || {}, status: input.status || "active", createdAt: nowIso(), updatedAt: nowIso() };
    this.eventSchemas.set(`${identity.workspaceId}:${rec.eventType}:${rec.version}`, rec);
    return rec;
  }

  async listEventSchemas(identity, eventType) { return [...this.eventSchemas.values()].filter((v) => v.workspaceId === identity.workspaceId && v.status === "active" && (!eventType || v.eventType === eventType)); }

  async recordIntervention(identity, input) {
    const rec = { interventionId: input.interventionId || newId("int"), workspaceId: identity.workspaceId, eventId: input.eventId, componentId: input.componentId, componentVersion: input.componentVersion || null, policyId: input.policyId || null, policyVersion: input.policyVersion || null, decision: input.decision, requirements: input.requirements || [], resolvedBy: input.resolvedBy || null, resolutionEventId: input.resolutionEventId || null, createdAt: nowIso() };
    this.interventions.set(rec.interventionId, rec);
    return rec;
  }

  async listInterventions(identity, limit = 100) { return [...this.interventions.values()].filter((v) => v.workspaceId === identity.workspaceId).slice(-Math.min(200, Number(limit) || 100)).reverse(); }

  async exportUser(identity) {
    return {
      profiles: await this.listProfiles(identity),
      decisions: await this.listDecisions(identity, 100),
      acknowledgments: this.acks.filter(
        (a) => a.workspaceId === identity.workspaceId && a.ownerUserId === identity.userId
      ),
      events: await this.listEvents(identity, { limit: 100, mineOnly: true }),
    };
  }

  async deleteUser(identity) {
    for (const [id, p] of this.profiles) {
      if (p.workspaceId === identity.workspaceId && p.ownerUserId === identity.userId) {
        p.status = "deleted";
        this.profiles.set(id, p);
      }
    }
    this.decisions = this.decisions.filter(
      (d) => !(d.workspaceId === identity.workspaceId && d.ownerUserId === identity.userId)
    );
    this.acks = this.acks.filter(
      (a) => !(a.workspaceId === identity.workspaceId && a.ownerUserId === identity.userId)
    );
    this.events = this.events.filter(
      (e) => !(e.workspaceId === identity.workspaceId && e.ownerUserId === identity.userId)
    );
    await this.auditEvent(identity, "user.delete", {});
  }

  async revokeInstallation(identity) {
    const install = this.installations.get(identity.installationId);
    if (install && install.owner_user_id === identity.userId && install.workspace_id === identity.workspaceId) {
      install.status = "revoked";
    }
    await this.auditEvent(identity, "installation.revoke", {});
  }
}
