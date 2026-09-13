/**
 * `ack repair` — auto-fix workspace / habits / constitution / daemon.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { ask } from "./ask.js";
import { resolveWorkspace, resolveSocket, checkDaemon, checkAllSockets } from "./workspace.js";
import { reviveDaemon, cleanupStaleResources, isWorkspaceActive } from "./daemons.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

export async function runRepair(targets, opts) {
  const ws = resolveWorkspace();
  const habitsDir = path.join(ws, ".agent", "habits");
  const constitution = path.join(ws, ".agent", "constitution.yaml");
  const sock = resolveSocket();

  if (!targets || targets.length === 0) {
    targets = ["workspace", "habits", "constitution", "daemon"];
  }

  console.log("\n=== ACK Repair ===\n");
  let fixed = 0;

  for (const target of targets) {
    switch (target) {

      case "workspace": {
        console.log(`  Target: workspace`);
        if (!fs.existsSync(ws)) {
          fs.mkdirSync(path.join(ws, ".agent", "habits"), { recursive: true });
          fs.mkdirSync(path.join(ws, ".agent"), { recursive: true });
          console.log("    ✓ Created workspace directories");
          fixed++;
        } else {
          console.log("    ~ Workspace already exists");
        }
        if (!fs.existsSync(habitsDir)) {
          fs.mkdirSync(habitsDir, { recursive: true });
          console.log("    ✓ Created habits directory");
          fixed++;
        } else {
          console.log("    ~ Habits directory already exists");
        }
        const agentDir = path.join(ws, ".agent");
        if (!fs.existsSync(agentDir)) {
          fs.mkdirSync(agentDir, { recursive: true });
          console.log("    ✓ Created .agent directory");
          fixed++;
        }
        break;
      }

      case "habits": {
        console.log(`  Target: habits`);
        const srcHabits = path.join(REPO_ROOT, "python", "example_workspace", ".agent", "habits");
        if (!fs.existsSync(srcHabits)) {
          console.log("    ✗ Cannot re-seed — source habits not found at", srcHabits);
          break;
        }
        if (opts.reinstall) {
          const srcFiles = fs.readdirSync(srcHabits).filter(f => f.endsWith(".yaml"));
          const willOverwrite = srcFiles.filter(f => fs.existsSync(path.join(habitsDir, f)));
          if (willOverwrite.length > 0 && !opts.yes) {
            console.log(`    ⚠ --reinstall will OVERWRITE ${willOverwrite.length} existing habit file(s),`);
            console.log(`      discarding any local edits to them:`);
            for (const f of willOverwrite) console.log(`        - ${f}`);
            const answer = (await ask("    Proceed? [y/N] ")).trim().toLowerCase();
            if (answer !== "y" && answer !== "yes") {
              console.log("    ✗ Skipped -- habits left untouched. Re-run with --yes to skip this prompt.");
              break;
            }
          }
          let copied = 0;
          for (const f of srcFiles) {
            fs.copyFileSync(path.join(srcHabits, f), path.join(habitsDir, f));
            copied++;
          }
          console.log(`    ✓ Re-seeded ${copied} habit files`);
          fixed++;
        } else {
          fs.mkdirSync(habitsDir, { recursive: true });
          let seeded = 0;
          for (const f of fs.readdirSync(srcHabits)) {
            if (f.endsWith(".yaml") && !fs.existsSync(path.join(habitsDir, f))) {
              fs.copyFileSync(path.join(srcHabits, f), path.join(habitsDir, f));
              seeded++;
            }
          }
          if (seeded > 0) {
            console.log(`    ✓ Seeded ${seeded} missing habit files`);
            fixed++;
          } else {
            console.log(`    ~ All habits already present`);
          }
        }
        break;
      }

      case "constitution": {
        console.log(`  Target: constitution`);
        if (!fs.existsSync(constitution)) {
          fs.mkdirSync(path.join(ws, ".agent"), { recursive: true });
          fs.writeFileSync(constitution, [
            "# Agent Character Kit — constitution (hard constraints).",
            "# The daemon embeds safe defaults; this file OVERRIDES/extends them.",
            "hard_constraints:",
            "  - no_credential_leak: block any tool call that would expose a secret",
            "  - no_destructive_without_confirm: block rm -rf /, mkfs, dd on disks, etc. unless confirmed",
          ].join("\n") + "\n");
          console.log("    ✓ Created default constitution.yaml");
          fixed++;
        } else {
          console.log("    ~ Constitution already exists");
        }
        break;
      }

      case "daemon": {
        console.log(`  Target: daemon`);

        const cleanup = cleanupStaleResources();
        if (cleanup.killed > 0) {
          console.log(`    ✓ Killed ${cleanup.killed} orphaned daemon(s) (workspace no longer exists)`);
          fixed++;
        }
        if (cleanup.removedSockets > 0) {
          console.log(`    ✓ Removed ${cleanup.removedSockets} dead socket file(s)`);
          fixed++;
        }
        if (cleanup.killed === 0 && cleanup.removedSockets === 0) {
          console.log(`    ~ No stale daemons or sockets to clean`);
        }

        const { results: allSockets } = await checkAllSockets();
        const liveElsewhere = Object.entries(allSockets).find(([, s]) => s.alive);
        if (liveElsewhere) {
          console.log(`    ~ Already served by ${liveElsewhere[0]} (${liveElsewhere[1].path}) -- not starting another`);
          break;
        }
        const wsActive = isWorkspaceActive(ws);
        if (wsActive) {
          const pid = reviveDaemon(ws);
          await new Promise(r => setTimeout(r, 800));
          const revived = await checkDaemon(sock);
          if (revived.alive) {
            console.log(`    ✓ Auto-activated daemon (pid ${pid}) for active workspace ${ws}`);
            fixed++;
          } else {
            console.log(`    ⚠ Revived daemon (pid ${pid}) but socket not yet ready — check 'ack doctor'`);
          }
          break;
        }
        if (sock.startsWith("tcp://")) {
          console.log("    ~ TCP transport — start daemon manually: `ack daemon start`");
        } else {
          console.log("    ~ No active workspace. Deploy with:");
          console.log("        sudo systemctl start agent-enforcer           (root)");
          console.log("        ack configure --yes                           (user)");
        }
        break;
      }

      default:
        console.log(`  ? Unknown target: ${target} (use: workspace, habits, constitution, daemon, all)`);
    }
  }

  console.log(`\n  Repairs applied: ${fixed}`);
  if (fixed === 0) {
    console.log("  Nothing needed fixing. Run `ack doctor` for a full health check.");
  }
  console.log("");
}
