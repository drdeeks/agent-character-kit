/**
 * `ack habit` create / list / delete. Shared with `ack manage`.
 */

import fs from "fs";
import path from "path";
import { normalizeHabitName, buildHabitYaml, VALID_LEVELS } from "../../../node/src/habits/build.js";
import { resolveWorkspace } from "./workspace.js";
import { ask } from "./ask.js";

export async function createHabitInteractive(ws, nameFlag, opts = {}) {
  const habitsDir = path.join(ws, ".agent", "habits");
  fs.mkdirSync(habitsDir, { recursive: true });

  const askRequired = async (flagVal, question) => {
    let v = flagVal;
    while (!v || !v.trim()) {
      if (v !== undefined && !v.trim()) console.error("This can't be empty.");
      v = await ask(question);
    }
    return v.trim();
  };

  const askLevel = async (flagVal) => {
    let v = flagVal;
    while (!v || !VALID_LEVELS.includes(v.trim().toLowerCase())) {
      if (v !== undefined) console.error(`Invalid level "${v}" -- must be one of: ${VALID_LEVELS.join(", ")}`);
      v = await ask(`Enforcement level (${VALID_LEVELS.join("/")}): `);
    }
    return v.trim().toLowerCase();
  };

  let fileName, file;
  while (true) {
    const name = await askRequired(nameFlag, "Habit name (kebab-case): ");
    fileName = normalizeHabitName(name);
    file = path.join(habitsDir, `${fileName}.yaml`);
    if (!fs.existsSync(file)) break;
    console.error("Habit already exists:", file);
    if (nameFlag) process.exit(1);
    nameFlag = undefined;
  }

  const prompt = await askRequired(opts.prompt, "Prompt (self-question): ");
  const logic = await askRequired(opts.logic, "Logic (why this governs your actions): ");
  const evidence = await askRequired(opts.evidence, "Evidence (how to verify this specific habit was actually applied): ");
  const level = await askLevel(opts.level);

  const yaml = buildHabitYaml({ name: fileName, prompt, logic, evidence, level });
  fs.writeFileSync(file, yaml);
  console.log("Created:", file);
  return file;
}

export function listHabitsForWorkspace(ws, { print = true } = {}) {
  const habitsDir = path.join(ws, ".agent", "habits");
  if (!fs.existsSync(habitsDir)) {
    if (print) console.log("No habits directory at", habitsDir);
    return [];
  }
  const files = fs.readdirSync(habitsDir).filter(f => f.endsWith(".yaml"));
  if (files.length === 0) {
    if (print) console.log("No habit files found in", habitsDir);
    return [];
  }
  const rows = files.map((f) => {
    const content = fs.readFileSync(path.join(habitsDir, f), "utf8");
    const nameMatch = content.match(/^name:\s*"?([^"\n]*)/m);
    const promptMatch = content.match(/^prompt:\s*"?([^"\n]*)/m);
    return { name: nameMatch?.[1]?.trim() || f, prompt: promptMatch?.[1]?.trim() || "(no prompt)", file: f };
  });
  if (print) {
    for (const r of rows) console.log(`  ${r.name}: ${r.prompt}`);
  }
  return rows;
}

export async function runHabitCreate(name, opts) {
  if (!name || !name.trim()) {
    console.error("Habit name is required");
    process.exit(1);
  }
  await createHabitInteractive(resolveWorkspace(), name, opts);
}

export function runHabitList() {
  listHabitsForWorkspace(resolveWorkspace());
}

export async function runHabitDelete(name, opts) {
  const ws = resolveWorkspace();
  const habitsDir = path.join(ws, ".agent", "habits");
  const fileName = normalizeHabitName(name);
  const file = path.join(habitsDir, `${fileName}.yaml`);
  if (!fs.existsSync(file)) {
    console.error("No such habit:", file);
    process.exit(1);
  }
  if (!opts.yes) {
    const confirmed = (await ask(`Delete ${file}? [y/N] `)).trim().toLowerCase();
    if (confirmed !== "y" && confirmed !== "yes") {
      console.log("Cancelled.");
      return;
    }
  }
  fs.unlinkSync(file);
  console.log("Deleted:", file);
}
