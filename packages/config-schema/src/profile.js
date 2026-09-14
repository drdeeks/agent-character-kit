/** Versioned hosted/local character profile. Safe defaults. No secrets. */

export const PROFILE_SCHEMA_VERSION = 1;

export const DEFAULT_PROFILE = Object.freeze({
  mode: "fail-closed",
  enabled: true,
  habits: [],
  toolRules: [],
  acknowledgmentRules: { requiredAcks: 2, holdEvery: 1 },
  watchdog: { enabled: true, staleAfterSeconds: 120 },
  audit: { retentionDays: 90 },
});

/**
 * @param {object} [input]
 */
export function defaultProfile(input = {}) {
  const ack = input.acknowledgmentRules || {};
  const watchdog = input.watchdog || {};
  const audit = input.audit || {};
  return {
    schemaVersion: PROFILE_SCHEMA_VERSION,
    profileId: String(input.profileId || ""),
    name: String(input.name || "default"),
    mode: input.mode === "fail-open" ? "fail-open" : "fail-closed",
    enabled: input.enabled !== false,
    habits: Array.isArray(input.habits) ? input.habits.map(normalizeHabit) : [],
    toolRules: Array.isArray(input.toolRules) ? input.toolRules.map(normalizeRule) : [],
    acknowledgmentRules: {
      requiredAcks: clampInt(ack.requiredAcks, 0, 10, DEFAULT_PROFILE.acknowledgmentRules.requiredAcks),
      holdEvery: clampInt(ack.holdEvery, 1, 100, DEFAULT_PROFILE.acknowledgmentRules.holdEvery),
    },
    watchdog: {
      enabled: watchdog.enabled !== false,
      staleAfterSeconds: clampInt(watchdog.staleAfterSeconds, 10, 86400, 120),
    },
    audit: {
      retentionDays: clampInt(audit.retentionDays, 1, 3650, 90),
    },
    version: clampInt(input.version, 1, 1e12, 1),
  };
}

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

function normalizeHabit(h) {
  if (typeof h === "string") {
    return { name: h.replace(/[^\w.-]+/g, "_").slice(0, 80), requiresAck: true };
  }
  const name = String(h?.name || "").replace(/[^\w.-]+/g, "_").slice(0, 80);
  return { name, requiresAck: h?.requiresAck !== false };
}

function normalizeRule(r) {
  if (typeof r === "string") return { type: "deny", pattern: r.slice(0, 200) };
  const type = ["hard", "deny", "allow"].includes(r?.type) ? r.type : "deny";
  return { type, pattern: String(r?.pattern || "").slice(0, 200) };
}

/**
 * @param {unknown} raw
 * @returns {{ ok: true, profile: object } | { ok: false, errors: string[] }}
 */
export function validateProfile(raw) {
  const errors = [];
  if (!raw || typeof raw !== "object") return { ok: false, errors: ["profile must be an object"] };
  const profile = defaultProfile(raw);
  if (!profile.profileId) errors.push("profileId is required");
  if (!profile.name) errors.push("name is required");
  if (!["fail-closed", "fail-open"].includes(profile.mode)) errors.push("mode must be fail-closed or fail-open");
  for (const h of profile.habits) {
    if (!h.name) errors.push("habit name is required");
  }
  for (const r of profile.toolRules) {
    if (!r.pattern) errors.push("toolRules.pattern is required");
  }
  if (errors.length) return { ok: false, errors };
  return { ok: true, profile };
}

/** Map a profile onto packages/core evaluatePolicy input. */
export function profileToPolicy(profile) {
  const p = defaultProfile(profile);
  const hardConstraints = [];
  const denyList = [];
  const allowList = [];
  for (const rule of p.toolRules) {
    if (rule.type === "hard") hardConstraints.push(rule.pattern);
    else if (rule.type === "allow") allowList.push(rule.pattern);
    else denyList.push(rule.pattern);
  }
  return { hardConstraints, denyList, allowList };
}
