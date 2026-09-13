#!/usr/bin/env node
/**
 * ack — Agent Character Kit CLI
 *
 * Single binary: enforcer daemon + companion hook + config + diagnostics + repair
 *
 * Commands:
 *   hook <framework>           Generate hook config for any agent framework
 *   config [show|verify|set|write-env]  Manage configuration
 *   status                     Quick socket + daemon health overview
 *   doctor                     Deep structured diagnostics (read-only)
 *   reload                     Re-read constitution/habits/policy on the daemon
 *   audit                      Show recent enforcement JSONL
 *   repair [target]            Fix problems (auto-fix, no dry-run gate)
 *   install                    Deploy the kit (delegates to install.js)
 *   habit create <name>        Create a habit
 *   habit list                 List all habits
 *   constitution show|add|remove  Hard constraints
 *   policy show|deny|allow|set    Allow/deny + hold frequency
 */

import { Command } from "commander";
import { generateConfig, processToolCall, processPromptSubmit, VERSION } from "../src/index.js";
import {
  runHookCommand,
  runStatusCommand,
  runConfigShow,
  runConfigVerify,
  runConfigSet,
  runConfigWriteEnv,
  runHabitCreate,
  runHabitList,
  runHabitDelete,
  runDoctor,
  runRepair,
  runManage,
  runReload,
  runAudit,
  runConstitutionShow,
  runConstitutionAdd,
  runConstitutionRemove,
  runPolicyShow,
  runPolicyDenyAdd,
  runPolicyDenyRemove,
  runPolicyAllowAdd,
  runPolicyAllowRemove,
  runPolicySet,
} from "../../packages/cli/src/index.js";
import { fileURLToPath } from "url";

// Absolute path to this exact file -- never "npx ack hook" as a default.
// If the package isn't globally installed/linked, npx silently fetches an
// unrelated public package instead of running this CLI (verified live).
const SELF = fileURLToPath(import.meta.url);
// ═══════════════════════════════════════════════════════════════════════════════
//  CLI definition
// ═══════════════════════════════════════════════════════════════════════════════

const program = new Command()
  .name("ack")
  .description("Agent Character Kit — character enforcement for any agent")
  .version(VERSION)
  .configureHelp({
    sortSubcommands: true,
    subcommandTerm: (cmd) => {
      const desc = cmd.description().split(" — ")[0];
      const args = cmd.registeredArguments.map(a => a.name()).join(" ");
      return cmd.name() + (args ? ` ${args}` : "") + (desc ? `  ${desc}` : "");
    },
    // subcommandTerm above already bakes the description into the term
    // column -- without this, commander's default formatter ALSO prints
    // cmd.description() in its own separate column, so every command line
    // showed its description twice ("Manage agent configuration [Config]
    // Manage agent configuration [Config]"). Found live: drdeek ran bare
    // `ack` and the doubled, garbled output read as "nothing populates."
    subcommandDescription: () => "",
    helpWidth: 100,
  });

function addHelpCategory(cmd, category) {
  // Append category tag to description for semantic grouping in help
  cmd.description(cmd.description() + ` [${category}]`);
}

// ─── Core commands ─────────────────────────────────────────────────────────

program
  .command("hook")
  .description("Gate a tool call via stdin, or print wiring config with --config [Core]")
  .argument("<framework>", "Framework: claude | cursor | gemini | opencode | hermes | generic")
  .option("--hook-command <cmd>", "Custom hook command", `node '${SELF}' hook`)
  .option("--config", "Print the hook wiring config instead of gating a call")
  .action(async (framework, opts) => {
    await runHookCommand(framework, opts, {
      generateConfig,
      processToolCall,
      processPromptSubmit,
    });
  });

program
  .command("configure")
  .alias("install") // backward-compat: v1.2.1 and earlier called this "install"
  .description("Set up daemon + monitor + watchdog + companion [Core]")
  .option("--yes", "Non-interactive, sensible defaults")
  .option("--all", "Everything: root mode + all components + Python bindings, for every detected harness (or just --harness if that's also given)")
  .option("--user", "User-mode (default)")
  .option("--root", "Root mode (systemd)")
  .option("--service-user <name>", "Root-equivalent boundary via a dedicated non-root service user (implies --root); default name if given no value elsewhere: ack-enforcer")
  .option("--workspace <path>", "Workspace path (default: ~/.agent-character-kit/workspace)")
  .option("--socket <mode>", "Socket: unix | tcp (default: unix)")
  .option("--harness <name>", "Harness for hook/companion config: claude | cursor | gemini | opencode | hermes | generic. Only claude/hermes/opencode are auto-detected and get real auto-naming (node/src/agent-identity.js) -- cursor/gemini get hook generation but must be named explicitly here every time, and always fall back to the harness-agnostic 'generic' agent name.")
  .option("--python", "Also install Python ACK bindings (auto with --all)")
  .option("--no-python", "Skip Python ACK bindings")
  .option("--vectors", "Also install the optional 'vectors' extra (numpy + sentence-transformers, semantic search) -- needs --python, root auto-runs pip")
  .option("--no-monitor", "Skip acknowledgment monitor")
  .option("--no-watchdog", "Skip monitor watchdog")
  .option("--no-companion", "Skip companion hook config")
  .option("--hook-command <cmd>", "Custom hook command for the generated companion config")
  .option("--start", "Launch the daemon/monitor/watchdog now (default)")
  .option("--no-start", "Only write config/env files; start everything yourself later")
  .option("--claude-config", "Write the PreToolUse+UserPromptSubmit hooks into " + "~/" + ".claude/settings.json (default with --harness claude)")
  .option("--no-claude-config", "Print the Claude hook config but don't write it into settings.json")
  .option("--create-habit", "Create a habit non-interactively (needs --habit-name/--habit-prompt/--habit-logic)")
  .option("--habit-name <name>", "Habit name, with --create-habit")
  .option("--habit-prompt <text>", "Habit prompt, with --create-habit")
  .option("--habit-logic <text>", "Habit logic, with --create-habit")
  .action(async (opts) => {
    const { main } = await import("./install.js");
    // Reconstruct raw --flag argv from commander's parsed opts and hand it
    // to install.js's OWN parseArgs (via main() with no argument) rather
    // than passing the commander opts object directly. Commander's
    // camelCase auto-naming doesn't always match the property names
    // install.js's internals expect (e.g. --claude-config -> opts.claudeConfig
    // via commander's convention, but install.js reads opts.writeClaudeConfig) —
    // routing everything through install.js's single parseArgs keeps flag
    // semantics defined in exactly one place instead of two that can drift.
    const kebab = (k) => k.replace(/([A-Z])/g, "-$1").toLowerCase();
    // Options declared ONLY as --no-X (no positive counterpart in
    // parseArgs): only ever emit the negative form, and only when the user
    // actually passed it (v === false). Emitting a bare --monitor etc. would
    // be an unrecognized flag to parseArgs (it only checks for --no-monitor).
    const negationOnly = new Set(["monitor", "watchdog", "companion"]);
    const flags = [];
    for (const [k, v] of Object.entries(opts)) {
      if (k === "python") continue; // handled separately below
      if (v === undefined || v === null) continue;
      if (typeof v === "boolean") {
        if (negationOnly.has(k)) {
          if (v === false) flags.push(`--no-${kebab(k)}`);
          continue;
        }
        flags.push(v ? `--${kebab(k)}` : `--no-${kebab(k)}`);
        continue;
      }
      flags.push(`--${kebab(k)}`, String(v));
    }
    if (opts.python === true) flags.push("--python");
    else if (opts.python === false) flags.push("--no-python");
    // Bug fix: this used to force-append "--yes" unconditionally here,
    // which meant `ack configure` (run with a real TTY, capable of a true
    // interactive wizard) could never actually reach install.js's
    // interactive branch -- every invocation silently ran non-interactive
    // regardless of whether --yes was passed. `flags` already contains
    // "--yes" when opts.yes is true; nothing further to add.
    process.argv = ["node", "install.js", ...flags];
    await main();
  });

program
  .command("manage")
  .description("Interactive menu: view/change every registered agent's config, habits, and daemon [Core]")
  .action(async () => {
    await runManage();
  });

// ─── Configuration ─────────────────────────────────────────────────────────

const configCmd = program
  .command("config")
  .description("Manage agent configuration [Config]");

configCmd
  .command("show")
  .description("Show resolved configuration paths")
  .option("--agent <name>", "Show a specific registered agent's config instead of the default single workspace")
  .action(runConfigShow);

configCmd
  .command("verify")
  .description("Verify all paths exist and daemon is reachable")
  .option("--agent <name>", "Verify a specific registered agent instead of every registered agent (or the default single workspace, if none are registered)")
  .action(runConfigVerify);

configCmd
  .command("set")
  .description("Print export command for a config key")
  .argument("<key>", "Config key (workspace|socket|ack-log)")
  .argument("<value>", "Value to set")
  .action(runConfigSet);

configCmd
  .command("write-env")
  .description("Write resolved .env to file")
  .argument("[file]", "Output file path (default: workspace/.env)")
  .option("--agent <name>", "Write a specific registered agent's .env instead of the default single workspace")
  .action(runConfigWriteEnv);

// ─── Diagnostics & Repair ──────────────────────────────────────────────────

program
  .command("status")
  .description("Quick daemon health overview [Diag]")
  .option("--json", "Output JSON")
  .action(runStatusCommand);

program
  .command("doctor")
  .description("Full structured diagnostic report (read-only) [Diag]")
  .action(runDoctor);

program
  .command("repair")
  .description("Auto-fix problems (workspace, habits, constitution, daemon) [Diag]")
  .argument("[targets...]", "What to fix: workspace, habits, constitution, daemon (omit for all)")
  .option("--reinstall", "Re-seed habits from bundled set -- DESTRUCTIVE: overwrites existing habit files, discarding local edits. Prompts for confirmation naming each file that will be clobbered unless --yes is also given.")
  .option("--yes", "Skip the --reinstall confirmation prompt (for scripted/non-interactive use)")
  .action(runRepair);

program
  .command("reload")
  .description("Re-read constitution/habits/policy on the running daemon [Diag]")
  .option("--agent <name>", "Reload a registered agent instead of the default socket")
  .option("--json", "Output JSON")
  .action(runReload);

program
  .command("audit")
  .description("Show recent enforcement JSONL (enforcer, events, companion, ack) [Diag]")
  .option("--source <name>", "enforcer | events | companion | ack | all", "enforcer")
  .option("--limit <n>", "Max entries (newest last)", "20")
  .option("--denied", "Only denied / held rows")
  .option("--agent <name>", "Read a registered agent's workspace logs")
  .option("--json", "Output JSON")
  .action(runAudit);

// ─── Habit management ──────────────────────────────────────────────────────

const habitCmd = program
  .command("habit")
  .description("Manage enforcement habits [Habits]");

habitCmd
  .command("create")
  .description("Create a new habit YAML file")
  .argument("<name>", "Habit name (kebab-case, becomes filename)")
  .option("-p, --prompt <text>", "Self-question prompt")
  .option("-l, --logic <text>", "Reasoning / logic behind the habit")
  .option("-e, --evidence <text>", "How to verify the habit was actually applied, specific to this habit")
  .option("--level <level>", "Enforcement level: reminder | should | must | hard")
  .action(runHabitCreate);

habitCmd
  .command("list")
  .description("List all habits with prompts")
  .action(runHabitList);

habitCmd
  .command("delete")
  .description("Delete a habit YAML file")
  .argument("<name>", "Habit name (as shown by `ack habit list`, or the filename)")
  .option("-y, --yes", "Skip confirmation prompt")
  .action(runHabitDelete);

const constitutionCmd = program
  .command("constitution")
  .description("Show or edit hard_constraints in constitution.yaml [Config]");
constitutionCmd
  .command("show")
  .description("Print hard_constraints")
  .option("--agent <name>", "Registered agent workspace")
  .option("--json", "Output JSON")
  .action(runConstitutionShow);
constitutionCmd
  .command("add")
  .description("Append a hard constraint pattern")
  .argument("<pattern>", "Glob-ish deny pattern (keep rm -rf / unless you mean to drop it)")
  .option("--agent <name>", "Registered agent workspace")
  .action(runConstitutionAdd);
constitutionCmd
  .command("remove")
  .description("Remove a hard constraint pattern")
  .argument("<pattern>", "Exact pattern string to drop")
  .option("--agent <name>", "Registered agent workspace")
  .action(runConstitutionRemove);

const policyCmd = program
  .command("policy")
  .description("Show or edit enforcer.yaml allow/deny and hold frequency [Config]");
policyCmd
  .command("show")
  .description("Print deny, allow, hold_every_n_calls, required_acks")
  .option("--agent <name>", "Registered agent workspace")
  .option("--json", "Output JSON")
  .action(runPolicyShow);
const denyCmd = policyCmd.command("deny").description("Extra deny patterns");
denyCmd.command("add").argument("<pattern>").option("--agent <name>").action(runPolicyDenyAdd);
denyCmd.command("remove").argument("<pattern>").option("--agent <name>").action(runPolicyDenyRemove);
const allowCmd = policyCmd.command("allow").description("Allow-list (non-empty = deny everything else)");
allowCmd.command("add").argument("<pattern>").option("--agent <name>").action(runPolicyAllowAdd);
allowCmd.command("remove").argument("<pattern>").option("--agent <name>").action(runPolicyAllowRemove);
policyCmd
  .command("set")
  .description("Set hold-every or required-acks")
  .argument("<key>", "hold-every | required-acks")
  .argument("<value>", "Positive integer")
  .option("--agent <name>", "Registered agent workspace")
  .action(runPolicySet);

// ─── Custom help text ──────────────────────────────────────────────────────

program.addHelpText("after", `
Category summary:
  [Core]     hook, configure, manage
  [Config]   config, constitution, policy
  [Diag]     status, doctor, repair, reload, audit
  [Habits]   habit create, habit list, habit delete

Examples:
  ack configure --yes                        quick user-mode setup
  ack configure --all                        root-mode setup + Python bindings
  ack manage                                 interactive menu: view/edit every agent
  ack doctor                                 full diagnostic report
  ack reload                                 re-read habits on the running daemon
  ack audit                                  last 20 enforcer-audit.jsonl rows
  ack repair                                 auto-fix workspace/habits/daemon
  ack constitution add 'DROP TABLE'          add a hard constraint
  ack policy deny add 'chmod 777'            extra deny pattern
  ack policy set hold-every 7                hold frequency
  ack habit create verify-workspace          create a new habit
  ack hook claude                            generate Claude companion config
  ack config show                            resolved config paths
`);

// ═══════════════════════════════════════════════════════════════════════════════
//  Parse & run
// ═══════════════════════════════════════════════════════════════════════════════

program.parse();
