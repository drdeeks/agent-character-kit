// Single source of truth for writing a habit YAML file. Before this
// existed, node/bin/ack.js's `habit create`, node/bin/install.js's
// createHabitDirect() (--create-habit), and install.js's own createHabit()
// (the ack-install wizard) each carried an independent, near-identical
// copy of this logic -- all three hardcoding enforcement.level: "reminder",
// behavior.kind: "standard", and the exact same generic evidence string
// regardless of the habit's actual content. That's the demonstrated root
// cause of the kind:"standard"/generic-evidence split found across the
// bundled habit set (blueprint.md KD-02/KD-03, MOD-009) -- three
// implementations of "write a habit" is duplicated truth per
// FOREVER-SYSTEM.md §1, collapsed here into one.

export const VALID_LEVELS = ["reminder", "should", "must", "hard"];

export function normalizeHabitName(raw) {
  return String(raw || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

/**
 * Build a habit YAML document. No field is defaulted or hardcoded -- every
 * caller must supply all five; validation is the caller's job (interactive
 * re-prompt vs. a hard CLI error are different UX for the same rule).
 * kind: "assertion" always, matching the demonstrated-correct format
 * shared by the kit's real, specifically-authored habits (not the old
 * "standard" default this logic used to write in all three places it
 * used to live).
 */
export function buildHabitYaml({ name, prompt, logic, evidence, level }) {
  if (!name) throw new Error("name required");
  if (!prompt || !prompt.trim()) throw new Error("prompt required");
  if (!logic || !logic.trim()) throw new Error("logic required");
  if (!evidence || !evidence.trim()) throw new Error("evidence required");
  if (!VALID_LEVELS.includes(level)) {
    throw new Error(`level must be one of: ${VALID_LEVELS.join(", ")} (got "${level}")`);
  }
  return [
    `name: "${name}"`,
    `prompt: ${JSON.stringify(prompt.trim())}`,
    `enforcement:`,
    `  level: "${level}"`,
    `behavior:`,
    `  kind: "assertion"`,
    `  assert: ${JSON.stringify(logic.trim())}`,
    `  evidence: ${JSON.stringify(evidence.trim())}`,
    `  logic: ${JSON.stringify(logic.trim())}`,
    "",
  ].join("\n");
}
