import { evaluatePolicy } from "@drdeeks/character-kit-core";
import { EFFECTS } from "@drdeeks/character-kit-protocol";
import { profileToPolicy } from "@drdeeks/character-kit-config-schema";
import { newId } from "./ids.js";

const NEVER_HOLD = /^(search|read|grep|glob|web_search|get_|list_|ack_get)/i;

export function unavailable(profile, extra = {}) {
  return {
    decision: "unavailable",
    decisionId: extra.decisionId || newId("decision"),
    profileId: profile?.profileId || null,
    reasonCodes: extra.reasonCodes || ["storage_unavailable"],
    requiredAcknowledgment: false,
    expiresAt: null,
    nextAction: "retry",
  };
}

export function checkAction({ profile, tool, command, recentAcks = [], openHold = null }) {
  if (!profile || profile.enabled === false) {
    if (profile?.mode === "fail-open") {
      return decision("allow", profile, { reasonCodes: ["profile_disabled"] });
    }
    return decision("deny", profile, { reasonCodes: ["profile_disabled"], nextAction: "reconfigure" });
  }

  const policy = profileToPolicy(profile);
  const verdict = evaluatePolicy({ tool, command }, policy);
  if (verdict.effect === EFFECTS.deny) {
    return decision("deny", profile, {
      reasonCodes: [verdict.code || "CK_POLICY_DENIED"],
      nextAction: "reconfigure",
    });
  }

  if (openHold) {
    return decision("hold", profile, {
      reasonCodes: ["habit_required"],
      requiredAcknowledgment: true,
      nextAction: "acknowledge_hold",
      decisionId: openHold.decisionId,
    });
  }

  const required = Number(profile.acknowledgmentRules?.requiredAcks || 0);
  const holdHabits = (profile.habits || []).filter((h) => h.requiresAck);
  if (required > 0 && holdHabits.length > 0 && !NEVER_HOLD.test(String(tool || ""))) {
    const names = recentAcks.map((a) => a.habitName);
    const reasons = recentAcks.map((a) => a.reason);
    if (names.length < required) {
      return decision("hold", profile, {
        reasonCodes: ["habit_required"],
        requiredAcknowledgment: true,
        nextAction: "acknowledge_hold",
      });
    }
    const lastNames = names.slice(-10);
    const lastReasons = reasons.slice(-10);
    if (lastNames.length >= 10 && holdHabits.every((h) => lastNames.includes(h.name))) {
      return decision("hold", profile, {
        reasonCodes: ["habit_reuse_window"],
        requiredAcknowledgment: true,
        nextAction: "acknowledge_hold",
      });
    }
    void lastReasons;
  }

  return decision("allow", profile, { reasonCodes: [] });
}

export function acknowledge({ profile, habitName, reason, recentAcks = [] }) {
  const name = String(habitName || "").trim();
  const why = String(reason || "").trim();
  if (!name || why.length < 8) {
    return decision("deny", profile, {
      reasonCodes: ["ack_too_thin"],
      nextAction: "acknowledge_hold",
    });
  }
  const lastNames = recentAcks.map((a) => a.habitName).slice(-10);
  const lastReasons = recentAcks.map((a) => a.reason).slice(-10);
  if (lastNames.includes(name) || lastReasons.includes(why)) {
    return decision("deny", profile, {
      reasonCodes: ["ack_reuse_window"],
      nextAction: "acknowledge_hold",
    });
  }
  return decision("acknowledge", profile, {
    reasonCodes: ["ack_accepted"],
    nextAction: "continue",
  });
}

function decision(kind, profile, extra = {}) {
  return {
    decision: kind,
    decisionId: extra.decisionId || newId("decision"),
    profileId: profile?.profileId || null,
    reasonCodes: extra.reasonCodes || [],
    requiredAcknowledgment: extra.requiredAcknowledgment === true,
    expiresAt: extra.expiresAt || null,
    nextAction: extra.nextAction || (kind === "allow" || kind === "acknowledge" ? "continue" : "retry"),
  };
}
