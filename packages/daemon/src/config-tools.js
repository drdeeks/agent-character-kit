/**
 * Config MCP tools: write workspace YAML, then reload.
 * Does not evaluate policy. Watchtower v0 methods stay untouched.
 */

import fs from "fs";
import path from "path";
import yaml from "js-yaml";
import { normalizeHabitName, buildHabitYaml, VALID_LEVELS } from "../../../node/src/habits/build.js";
import { loadYaml } from "./enforcer.js";

export const CONFIG_TOOL_NAMES = [
  "list_habits",
  "write_habit",
  "delete_habit",
  "get_character_config",
  "set_character_config",
];

const habitItem = {
  type: "object",
  properties: {
    file: { type: "string" },
    name: { type: "string" },
    prompt: { type: "string" },
  },
};

export const CONFIG_TOOLS = [
  {
    name: "list_habits",
    title: "List habits",
    description: "Use when the user wants to see on-disk habit YAML files. Does not evaluate policy.",
    inputSchema: { type: "object", properties: {} },
    outputSchema: {
      type: "object",
      properties: {
        ok: { type: "boolean" },
        habits: { type: "array", items: habitItem },
        error: { type: "string" },
      },
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  {
    name: "write_habit",
    title: "Write habit",
    description: "Use when the user wants to create or replace one habit YAML file, then reload.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        prompt: { type: "string" },
        logic: { type: "string" },
        evidence: { type: "string" },
        level: { type: "string", enum: VALID_LEVELS },
      },
      required: ["name", "prompt", "logic", "evidence", "level"],
    },
    outputSchema: {
      type: "object",
      properties: {
        ok: { type: "boolean" },
        file: { type: "string" },
        character_hash: { type: "string" },
        error: { type: "string" },
      },
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
  {
    name: "delete_habit",
    title: "Delete habit",
    description: "Use when the user wants to delete one habit YAML file, then reload.",
    inputSchema: {
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
    },
    outputSchema: {
      type: "object",
      properties: {
        ok: { type: "boolean" },
        deleted: { type: "string" },
        character_hash: { type: "string" },
        error: { type: "string" },
      },
    },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  },
  {
    name: "get_character_config",
    title: "Get character config",
    description: "Use when the user wants to read hard constraints, allow/deny, frequency, and habits. Does not evaluate policy.",
    inputSchema: { type: "object", properties: {} },
    outputSchema: {
      type: "object",
      properties: {
        ok: { type: "boolean" },
        workspace: { type: "string" },
        character_hash: { type: "string" },
        error: { type: "string" },
      },
      additionalProperties: true,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  {
    name: "set_character_config",
    title: "Set character config",
    description: "Use when the user wants to patch constitution.yaml and/or enforcer.yaml, then reload. Omitted fields stay. Does not evaluate policy.",
    inputSchema: {
      type: "object",
      properties: {
        hard_constraints: { type: "array", items: { type: "string" } },
        deny: { type: "array", items: { type: "string" } },
        allow: { type: "array", items: { type: "string" } },
        hold_every_n_calls: { type: "integer" },
        required_acks: { type: "integer" },
      },
    },
    outputSchema: {
      type: "object",
      properties: {
        ok: { type: "boolean" },
        character_hash: { type: "string" },
        error: { type: "string" },
      },
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
];

function dumpYaml(obj) {
  return yaml.dump(obj, { lineWidth: 100, noRefs: true });
}

function listHabitFiles(enforcer) {
  const dir = enforcer.cfg.HABITS_DIR;
  if (!dir || !fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith(".yaml")).map((f) => {
    const content = fs.readFileSync(path.join(dir, f), "utf8");
    const nameMatch = content.match(/^name:\s*"?([^"\n]*)/m);
    const promptMatch = content.match(/^prompt:\s*"?([^"\n]*)/m);
    return {
      file: f,
      name: nameMatch?.[1]?.trim() || f.replace(/\.yaml$/, ""),
      prompt: promptMatch?.[1]?.trim() || "",
    };
  });
}

function reload(enforcer) {
  if (typeof enforcer.reload === "function") enforcer.reload();
  return enforcer.characterHash;
}

export function runConfigTool(enforcer, name, args = {}) {
  if (!enforcer?.cfg) return { error: "no enforcer" };
  if (name === "list_habits") {
    return { ok: true, habits: listHabitFiles(enforcer) };
  }
  if (name === "write_habit") {
    try {
      const fileName = normalizeHabitName(args.name);
      if (!fileName) return { error: "name required" };
      const yamlText = buildHabitYaml({
        name: fileName,
        prompt: args.prompt,
        logic: args.logic,
        evidence: args.evidence,
        level: args.level,
      });
      fs.mkdirSync(enforcer.cfg.HABITS_DIR, { recursive: true });
      const file = path.join(enforcer.cfg.HABITS_DIR, `${fileName}.yaml`);
      fs.writeFileSync(file, yamlText);
      const character_hash = reload(enforcer);
      return { ok: true, file, character_hash };
    } catch (e) {
      return { error: e.message };
    }
  }
  if (name === "delete_habit") {
    const fileName = normalizeHabitName(args.name);
    const file = path.join(enforcer.cfg.HABITS_DIR, `${fileName}.yaml`);
    if (!fs.existsSync(file)) return { error: `no such habit: ${fileName}` };
    fs.unlinkSync(file);
    const character_hash = reload(enforcer);
    return { ok: true, deleted: file, character_hash };
  }
  if (name === "get_character_config") {
    const constitutionFile = loadYaml(enforcer.cfg.CONSTITUTION);
    const policyFile = loadYaml(enforcer.cfg.POLICY_FILE);
    return {
      ok: true,
      workspace: enforcer.cfg.WORKSPACE,
      character_hash: enforcer.characterHash,
      constitution_file: constitutionFile,
      policy_file: policyFile,
      live_hard_constraints: enforcer.constitution?.hard_constraints || [],
      live_hold_every_n_calls: enforcer.holdEveryNCalls,
      live_required_acks: enforcer.requiredAcks,
      habits: listHabitFiles(enforcer),
    };
  }
  if (name === "set_character_config") {
    if (Object.prototype.hasOwnProperty.call(args, "hard_constraints")) {
      if (!Array.isArray(args.hard_constraints)) return { error: "hard_constraints must be an array of strings" };
      const cur = loadYaml(enforcer.cfg.CONSTITUTION);
      cur.hard_constraints = args.hard_constraints.map(String);
      fs.mkdirSync(path.dirname(enforcer.cfg.CONSTITUTION), { recursive: true });
      fs.writeFileSync(enforcer.cfg.CONSTITUTION, dumpYaml(cur));
    }
    const policyPatch = {};
    for (const key of ["deny", "allow"]) {
      if (Object.prototype.hasOwnProperty.call(args, key)) {
        if (!Array.isArray(args[key])) return { error: `${key} must be an array of strings` };
        policyPatch[key] = args[key].map(String);
      }
    }
    for (const key of ["hold_every_n_calls", "required_acks"]) {
      if (Object.prototype.hasOwnProperty.call(args, key)) {
        const n = Number(args[key]);
        if (!Number.isInteger(n) || n < 1) return { error: `${key} must be a positive integer` };
        policyPatch[key] = n;
      }
    }
    if (Object.keys(policyPatch).length) {
      const cur = loadYaml(enforcer.cfg.POLICY_FILE);
      Object.assign(cur, policyPatch);
      fs.mkdirSync(path.dirname(enforcer.cfg.POLICY_FILE), { recursive: true });
      fs.writeFileSync(enforcer.cfg.POLICY_FILE, dumpYaml(cur));
    }
    const character_hash = reload(enforcer);
    return { ok: true, character_hash };
  }
  return { error: `unknown config tool: ${name}` };
}
