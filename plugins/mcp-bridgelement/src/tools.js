import { HOSTED_TOOLS } from "@drdeeks/character-kit-mcp-contract";
import { EVENT_TYPE } from "@drdeeks/character-kit-events";
import { ignoreModelIdentity } from "./auth.js";
import { acknowledge, checkAction, unavailable } from "./enforcement.js";
import { buildRlEvent, decisionEventType, emitRlEvent } from "./rl-events.js";

export { HOSTED_TOOLS };

export async function runHostedTool(name, rawArgs, { identity, store }) {
  const args = ignoreModelIdentity(rawArgs || {});
  try {
    const profile = await store.ensureTenant(identity);
    switch (name) {
      case "ack_get_status":
        return {
          ok: true,
          mode: profile.mode,
          profileId: profile.profileId,
          provider: identity.provider,
          installationId: identity.installationId,
        };
      case "ack_get_active_profile":
        return profile;
      case "ack_list_profiles":
        return { profiles: await store.listProfiles(identity) };
      case "ack_get_policy": {
        const p = args.profileId ? await store.getProfile(identity, args.profileId) : profile;
        if (!p) return { error: "profile not found" };
        return p;
      }
      case "ack_get_recent_decisions":
        return { decisions: await store.listDecisions(identity, Number(args.limit) || 20) };
      case "ack_create_profile":
        return write(store, identity, () => store.createProfile(identity, { name: args.name, mode: args.mode }));
      case "ack_update_profile":
        return write(store, identity, () => store.updateProfile(identity, args.profileId, args.patch || {}));
      case "ack_select_profile":
        return write(store, identity, () => store.selectProfile(identity, args.profileId));
      case "ack_configure_habit":
        return write(store, identity, async () => {
          const habits = [...(profile.habits || [])];
          if (args.remove) {
            return store.updateProfile(identity, profile.profileId, {
              habits: habits.filter((h) => h.name !== args.name),
            });
          }
          const rest = habits.filter((h) => h.name !== args.name);
          rest.push({ name: args.name, requiresAck: args.requiresAck !== false });
          return store.updateProfile(identity, profile.profileId, { habits: rest });
        });
      case "ack_set_enforcement_mode":
        return write(store, identity, () => store.updateProfile(identity, profile.profileId, { mode: args.mode }));
      case "ack_check_action": {
        const result = checkAction({
          profile,
          tool: args.tool,
          command: args.command || "",
          recentAcks: await store.recentAcks(identity),
          openHold: await store.openHold(identity),
        });
        await store.recordDecision(identity, {
          ...result,
          decisionId: result.decisionId,
          profileId: profile.profileId,
          profileVersion: profile.version,
          tool: args.tool,
          command: args.command,
        });
        await emitRlEvent(store, identity, decisionEventType(result.decision), {
          sessionId: args.conversation_id,
          payload: {
            decision: result.decision,
            decisionId: result.decisionId,
            profileId: profile.profileId,
            profileVersion: profile.version,
            tool: args.tool,
            reasonCodes: result.reasonCodes,
          },
        });
        return result;
      }
      case "ack_acknowledge_hold": {
        const result = acknowledge({
          profile,
          habitName: args.habitName,
          reason: args.reason,
          recentAcks: await store.recentAcks(identity),
        });
        if (result.decision === "acknowledge") {
          await store.addAck(identity, {
            habitName: args.habitName,
            reason: args.reason,
            decisionId: args.decisionId,
          });
        }
        await store.recordDecision(identity, {
          ...result,
          profileId: profile.profileId,
          profileVersion: profile.version,
        });
        await emitRlEvent(
          store,
          identity,
          result.decision === "acknowledge" ? EVENT_TYPE.ACK_ACCEPTED : EVENT_TYPE.ACK_REJECTED,
          {
            sessionId: args.conversation_id,
            payload: {
              habitName: args.habitName,
              decisionId: args.decisionId,
              reasonCodes: result.reasonCodes,
            },
          }
        );
        return result;
      }
      case "ack_record_decision": {
        const allowed = ["allow", "hold", "deny", "acknowledge", "unavailable"];
        const decision = allowed.includes(args.decision) ? args.decision : "unavailable";
        const result = {
          decision,
          decisionId: args.decisionId,
          profileId: profile.profileId,
          reasonCodes: args.reasonCodes || ["recorded"],
          requiredAcknowledgment: decision === "hold",
          expiresAt: null,
          nextAction: decision === "hold" ? "acknowledge_hold" : "continue",
        };
        await store.recordDecision(identity, {
          ...result,
          profileVersion: profile.version,
          tool: args.tool,
        });
        return result;
      }
      case "ack_ingest_event":
        return write(store, identity, async () => {
          const event = buildRlEvent(identity, args.eventType, {
            sessionId: args.sessionId || args.conversation_id,
            episodeId: args.episodeId,
            taskId: args.taskId,
            runId: args.runId,
            source: args.source || "external",
            component: args.component || "ingest",
            payload: args.payload || {},
          });
          await store.appendEvent(identity, event);
          return { eventId: event.eventId, eventType: event.eventType };
        });
      case "ack_list_events":
        return {
          events: await store.listEvents(identity, {
            limit: args.limit,
            eventType: args.eventType,
            mineOnly: args.mineOnly === true,
          }),
        };
      case "ack_register_component": return write(store, identity, () => store.registerComponent(identity, args));
      case "ack_list_components": return { components: await store.listComponents(identity) };
      case "ack_register_attribute": return write(store, identity, () => store.registerAttribute(identity, args));
      case "ack_list_attributes": return { attributes: await store.listAttributes(identity, args.namespace) };
      case "ack_register_event_schema": return write(store, identity, () => store.registerEventSchema(identity, args));
      case "ack_list_event_schemas": return { schemas: await store.listEventSchemas(identity, args.eventType) };
      case "ack_record_intervention": return write(store, identity, () => store.recordIntervention(identity, args));
      case "ack_list_interventions": return { interventions: await store.listInterventions(identity, args.limit) };
      case "ack_report_watchdog_state":
        return store.reportWatchdog(identity, args.leaseVersion);
      case "ack_export_user_data":
        return store.exportUser(identity);
      case "ack_delete_user_data":
        return write(store, identity, async () => {
          await store.deleteUser(identity);
          return { ok: true, deleted: true };
        });
      case "ack_revoke_installation":
        return write(store, identity, async () => {
          await store.revokeInstallation(identity);
          return { ok: true, revoked: true };
        });
      default:
        return { error: `unknown tool ${name}` };
    }
  } catch (err) {
    if (err && err.code === "revoked") return { error: "installation revoked" };
    if (err && (err.code === "invalid" || err.code === "not_found" || err.code === "forbidden")) {
      return { error: err.message };
    }
    if (isStorage(err)) return unavailable(null, { reasonCodes: ["storage_unavailable"] });
    return unavailable(null, { reasonCodes: ["worker_failure"] });
  }
}

function isStorage(err) {
  return err && (err.code === "storage" || /D1|SQLITE|storage/i.test(String(err.message || "")));
}

async function write(store, identity, fn) {
  if (!store.rateLimitWrite(identity)) {
    return { error: "rate limited" };
  }
  return fn();
}
