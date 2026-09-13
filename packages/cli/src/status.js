/**
 * `ack status` — socket liveness overview.
 */

import {
  checkAllSockets,
  looksNeverConfigured,
  FIRST_RUN_NUDGE,
} from "./workspace.js";

export async function runStatusCommand(opts) {
  const { results, registryPath } = await checkAllSockets();
  if (opts.json) {
    console.log(JSON.stringify({ results, registryPath }, null, 2));
    return;
  }
  console.log("=== Socket Status ===");
  if (registryPath) {
    const agentCount = Object.keys(results).filter((n) => n.startsWith("agent: ")).length;
    console.log(`  (${agentCount} registered agent(s), registry: ${registryPath})`);
  }
  for (const [name, info] of Object.entries(results)) {
    if (!info.checked) {
      console.log(`  ${name}: — not configured`);
      continue;
    }
    const state = info.alive ? "🟢 ALIVE" : "🔴 DEAD";
    console.log(`  ${name}: ${state}`);
    console.log(`    path: ${info.path}`);
    if (info.error) console.log(`    error: ${info.error}`);
    if (info.workspace) console.log(`    workspace: ${info.workspace}`);
  }
  // Fallback first-run nudge when postinstall could not print (no TTY,
  // --ignore-scripts). ack configure is the real setup path.
  if (Object.values(results).every((r) => !r.checked || !r.alive) && looksNeverConfigured()) {
    console.log(`\n${FIRST_RUN_NUDGE}`);
  }
}
