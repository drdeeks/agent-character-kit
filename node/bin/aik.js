#!/usr/bin/env node

import { Command } from "commander";
import { processToolCall, generateConfig, EnforcerClient } from "../src/index.js";
import fs from "fs";
import os from "os";
import path from "path";

// Components are loaded lazily inside their commands so you can use ONLY the
// identity layer (hook + enforcer) without pulling in indexer / memory /
// semantic. Nothing is forced.
const getIndexer = async () => (await import("../src/knowledge/indexer.js")).DocumentIndexer;
const getSemantic = async () => (await import("../src/knowledge/semantic.js")).SemanticSearch;
const getMemory = async () => (await import("../src/memory/index.js")).Memory;
import { spawn } from "child_process";
import { fileURLToPath } from "url";

const program = new Command();

program
  .name("aik")
  .description("Agent Identity Kit — Identity enforcement + knowledge + memory")
  .version("1.0.0");

// ─── Hook Command (Core) ────────────────────────────────────────────────────

program
  .command("hook")
  .description("Run identity hook for tool validation (core enforcement)")
  .option("-f, --framework <fw>", "Framework (claude|cursor|gemini|hermes|opencode|generic|auto)", "auto")
  .option("-c, --config", "Generate hook configuration for a framework")
  .option("--framework-config <fw>", "Framework to generate config for")
  .option("--hook-command <cmd>", "Custom hook command path")
  .action(async (opts) => {
    if (opts.config) {
      const fw = opts.frameworkConfig || opts.framework;
      const config = generateConfig(fw, opts.hookCommand);
      console.log(JSON.stringify(config, null, 2));
      return;
    }

    let input = "";
    if (!process.stdin.isTTY) {
      input = await new Promise((resolve) => {
        let data = "";
        process.stdin.on("data", (chunk) => (data += chunk));
        process.stdin.on("end", () => resolve(data));
      });
    }

    const payload = input ? JSON.parse(input) : {};
    const result = await processToolCall(payload, { framework: opts.framework });
    console.log(JSON.stringify(result.output));
    process.exit(result.exitCode);
  });

// ─── Enforcer Commands ──────────────────────────────────────────────────────

program
  .command("enforcer")
  .description("Enforcer daemon operations")
  .option("-s, --status", "Check enforcer status")
  .option("--validate", "Validate workspace integrity")
  .option("--heartbeat", "Send heartbeat")
  .option("--reload", "Reload constitution + habits + policy")
  .option("--start", "Start the daemon in the foreground")
  .option("--supervise", "Run the daemon with self-healing (restart 5-15s if killed)")
  .option("--install", "Install a platform service (systemd/launchd) for self-healing")
  .option("--user", "With --install: create a dedicated enforcer user (hardening)")
  .action(async (opts) => {
    const client = new EnforcerClient();

    if (opts.start) {
      const { runDaemon } = await import("../enforcer/enforcer_daemon.js");
      runDaemon();
      return;
    }

    if (opts.supervise) {
      await superviseDaemon();
      return;
    }

    if (opts.install) {
      installService(!!opts.user);
      return;
    }

    if (opts.reload) {
      const result = await client.call("reload");
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    if (opts.status) {
      const result = await client.validateWorkspace();
      console.log(JSON.stringify(result, null, 2));
    } else if (opts.validate) {
      const result = await client.validateWorkspace();
      console.log(JSON.stringify(result, null, 2));
    } else if (opts.heartbeat) {
      const result = await client.heartbeat();
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log("Use --status, --validate, --heartbeat, --start, --supervise, or --install");
    }
  });

// ─── Self-healing supervisor ─────────────────────────────────────────────────

async function superviseDaemon() {
  const daemonScript = path.resolve(import.meta.dirname || path.dirname(fileURLToPath(import.meta.url)), "..", "enforcer", "enforcer_daemon.js");
  let child = null;

  const start = () => {
    child = spawn(process.execPath, [daemonScript], {
      env: process.env,
      stdio: "inherit",
    });
    child.on("exit", (code, signal) => {
      console.error(`[supervise] daemon exited (${signal || code}); scheduling restart`);
      scheduleRestart();
    });
    child.on("error", (e) => {
      console.error(`[supervise] spawn error: ${e.message}`);
      scheduleRestart();
    });
  };

  const scheduleRestart = () => {
    // Self-healing: bring it back within 5-15 seconds.
    const delay = 5000 + Math.floor(Math.random() * 10000);
    console.error(`[supervise] restarting in ${Math.round(delay / 1000)}s`);
    setTimeout(start, delay);
  };

  const shutdown = () => { if (child) child.kill(); process.exit(0); };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  console.error("[supervise] self-healing supervisor started");
  start();
}

// ─── Cross-platform installer ────────────────────────────────────────────────

function installService(createUser) {
  const HOME = process.env.HOME || os.homedir();
  const aikBin = path.resolve(process.cwd(), "bin", "aik.js");
  const launcher = `node ${aikBin} enforcer --supervise`;
  const platform = process.platform;

  if (platform === "linux" || platform === "freebsd") {
    const unit = `[Unit]
Description=Agent Identity Enforcer (self-healing)
After=network.target

[Service]
Type=simple
ExecStart=${launcher}
Restart=always
RestartSec=5
# Self-healing: if killed, systemd brings it back within 5s.
Environment=HOME=${HOME}
Environment=AGENT_WORKSPACE=${process.env.AGENT_WORKSPACE || path.join(HOME, ".openclaw", "workspace")}
${createUser ? "User=aienforcer\n" : ""}WorkingDirectory=${process.cwd()}

[Install]
WantedBy=default.target
`;
    const unitPath = path.join(HOME, ".config", "systemd", "user", "agent-enforcer.service");
    fs.mkdirSync(path.dirname(unitPath), { recursive: true });
    fs.writeFileSync(unitPath, unit);
    if (createUser) {
      console.log("# Create the dedicated user (run as root):");
      console.log(`sudo useradd -r -s /usr/sbin/nologin aienforcer`);
      console.log(`sudo chown -R aienforcer ${path.join(HOME, "run", "agent-enforcer")}`);
    }
    console.log(`Wrote ${unitPath}`);
    console.log("Enable + start:");
    console.log("  systemctl --user daemon-reload");
    console.log("  systemctl --user enable --now agent-enforcer.service");
  } else if (platform === "darwin") {
    const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.agentidentitykit.enforcer</string>
  <key>ProgramArguments</key>
  <array><string>node</string><string>${aikBin}</string><string>enforcer</string><string>--supervise</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>5</integer>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key><string>${HOME}</string>
    <key>AGENT_WORKSPACE</key><string>${process.env.AGENT_WORKSPACE || path.join(HOME, ".openclaw", "workspace")}</string>
  </dict>
</dict>
</plist>
`;
    const plistPath = path.join(HOME, "Library", "LaunchAgents", "com.agentidentitykit.enforcer.plist");
    fs.mkdirSync(path.dirname(plistPath), { recursive: true });
    fs.writeFileSync(plistPath, plist);
    console.log(`Wrote ${plistPath}`);
    console.log("Load + start:");
    console.log(`  launchctl load ${plistPath}`);
    console.log(`  launchctl start com.agentidentitykit.enforcer`);
  } else {
    console.log("No native service manager for this platform.");
    console.log("Run the self-healing supervisor directly:");
    console.log(`  ${launcher}`);
  }
}

// ─── Index Commands (Knowledge) ─────────────────────────────────────────────

const indexCmd = program
  .command("index")
  .description("Document indexing with YAML frontmatter");

indexCmd
  .command("run")
  .description("Index the user-supplied corpus (defaults to ./corpus)")
  .argument("[path]", "Directory to index", "corpus")
  .option("-e, --extensions <exts>", "File extensions (comma-separated). Omit to discover all supported types", "")
  .option("--category <cat>", "Force category for all files")
  .action(async (dirPath, opts) => {
    const corpus = path.resolve(process.cwd(), dirPath);
    if (dirPath === "corpus" && !fs.existsSync(corpus)) {
      fs.mkdirSync(corpus, { recursive: true });
      console.error(`[aik] created empty corpus at ${corpus} — drop user docs/links/examples here.`);
    }
    const indexer = new (await getIndexer())(process.cwd());
    await indexer.init();
    const extensions = opts.extensions
      ? opts.extensions.split(",").map((e) => e.trim()).filter(Boolean)
      : undefined;
    const result = await indexer.indexDirectory(corpus, { extensions, category: opts.category });
    console.log(JSON.stringify(result, null, 2));
  });

indexCmd
  .command("file")
  .description("Index a single file")
  .argument("<path>", "File to index")
  .option("--category <cat>", "Document category")
  .option("--tags <tags>", "Comma-separated tags")
  .action(async (filePath, opts) => {
    const indexer = new (await getIndexer())(process.cwd());
    await indexer.init();
    const tags = opts.tags ? opts.tags.split(",").map((t) => t.trim()) : undefined;
    const result = await indexer.indexFile(filePath, { category: opts.category, tags });
    console.log(JSON.stringify(result, null, 2));
  });

indexCmd
  .command("search")
  .description("Search indexed documents")
  .argument("<query>", "Search query")
  .option("-l, --limit <n>", "Max results", "10")
  .option("-c, --category <cat>", "Filter by category")
  .action(async (query, opts) => {
    const indexer = new (await getIndexer())(process.cwd());
    await indexer.init();
    const results = await indexer.search(query, { limit: parseInt(opts.limit), category: opts.category });
    console.log(JSON.stringify(results, null, 2));
  });

indexCmd
  .command("status")
  .description("Show indexing status")
  .action(async () => {
    const indexer = new (await getIndexer())(process.cwd());
    await indexer.init();
    console.log(JSON.stringify(indexer.status(), null, 2));
  });

indexCmd
  .command("list")
  .description("List indexed documents")
  .option("-c, --category <cat>", "Filter by category")
  .action(async (opts) => {
    const indexer = new (await getIndexer())(process.cwd());
    await indexer.init();
    console.log(JSON.stringify(indexer.listDocuments(opts.category), null, 2));
  });

// ─── Semantic Commands ──────────────────────────────────────────────────────

const semanticCmd = program
  .command("semantic")
  .description("Semantic (vector) search");

semanticCmd
  .command("index")
  .description("Build semantic vectors for indexed documents")
  .action(async () => {
    const indexer = new (await getIndexer())(process.cwd());
    await indexer.init();
    const semantic = new (await getSemantic())(process.cwd());
    await semantic.init();

    const docs = indexer.listDocuments();
    let count = 0;
    for (const doc of docs) {
      const docData = indexer.index.documents[doc.id];
      if (!docData?.chunks) continue;
      for (const chunk of docData.chunks) {
        await semantic.indexDocument(chunk.id, chunk.content, {
          parent: doc.id,
          category: doc.category,
          tags: doc.tags,
        });
        count++;
      }
    }
    await semantic.save();
    console.log(JSON.stringify({ indexed: count, status: "ok" }, null, 2));
  });

semanticCmd
  .command("search")
  .description("Semantic search across vectors")
  .argument("<query>", "Search query")
  .option("-l, --limit <n>", "Max results", "10")
  .action(async (query, opts) => {
    const semantic = new (await getSemantic())(process.cwd());
    await semantic.init();
    const results = await semantic.search(query, parseInt(opts.limit));
    console.log(JSON.stringify(results, null, 2));
  });

semanticCmd
  .command("hybrid")
  .description("Hybrid search (keyword + semantic)")
  .argument("<query>", "Search query")
  .option("-l, --limit <n>", "Max results", "10")
  .action(async (query, opts) => {
    const indexer = new (await getIndexer())(process.cwd());
    await indexer.init();
    const semantic = new (await getSemantic())(process.cwd());
    await semantic.init();

    const keywordResults = await indexer.search(query, { limit: parseInt(opts.limit) });
    const results = await semantic.hybridSearch(query, keywordResults, parseInt(opts.limit));
    console.log(JSON.stringify(results, null, 2));
  });

semanticCmd
  .command("status")
  .description("Show semantic search status")
  .action(async () => {
    const semantic = new (await getSemantic())(process.cwd());
    await semantic.init();
    console.log(JSON.stringify(semantic.status(), null, 2));
  });

// ─── Memory Commands ────────────────────────────────────────────────────────

const memoryCmd = program
  .command("memory")
  .description("Memory system (daily/weekly/long-term)");

memoryCmd
  .command("log")
  .description("Log entry to today's daily note")
  .argument("<entry>", "Entry content")
  .option("-t, --tags <tags>", "Comma-separated tags")
  .option("-c, --category <cat>", "Entry category", "general")
  .action(async (entry, opts) => {
    const memory = new (await getMemory())(process.cwd());
    await memory.init();
    const tags = opts.tags ? opts.tags.split(",").map((t) => t.trim()) : [];
    const result = await memory.daily.log(entry, { tags, category: opts.category });
    console.log(JSON.stringify(result, null, 2));
  });

memoryCmd
  .command("today")
  .description("Show today's daily note")
  .action(async () => {
    const memory = new (await getMemory())(process.cwd());
    await memory.init();
    const note = await memory.daily.getToday();
    console.log(JSON.stringify(note, null, 2));
  });

memoryCmd
  .command("lesson")
  .description("Add lesson to long-term memory")
  .argument("<title>", "Lesson title")
  .argument("<content>", "Lesson content")
  .option("-t, --tags <tags>", "Comma-separated tags")
  .action(async (title, content, opts) => {
    const memory = new (await getMemory())(process.cwd());
    await memory.init();
    const tags = opts.tags ? opts.tags.split(",").map((t) => t.trim()) : [];
    const result = await memory.longterm.addLesson(title, content, { tags });
    console.log(JSON.stringify(result, null, 2));
  });

memoryCmd
  .command("pattern")
  .description("Add pattern to long-term memory")
  .argument("<name>", "Pattern name")
  .argument("<description>", "Pattern description")
  .action(async (name, description) => {
    const memory = new (await getMemory())(process.cwd());
    await memory.init();
    const result = await memory.longterm.addPattern(name, description);
    console.log(JSON.stringify(result, null, 2));
  });

memoryCmd
  .command("decision")
  .description("Record an important decision")
  .argument("<title>", "Decision title")
  .argument("<context>", "Context")
  .argument("<decision>", "What was decided")
  .argument("<rationale>", "Why")
  .action(async (title, context, decision, rationale) => {
    const memory = new (await getMemory())(process.cwd());
    await memory.init();
    const result = await memory.longterm.addDecision(title, context, decision, rationale);
    console.log(JSON.stringify(result, null, 2));
  });

memoryCmd
  .command("search")
  .description("Search all memory layers")
  .argument("<query>", "Search query")
  .action(async (query) => {
    const memory = new (await getMemory())(process.cwd());
    await memory.init();
    const results = await memory.search(query);
    console.log(JSON.stringify(results, null, 2));
  });

memoryCmd
  .command("status")
  .description("Show memory system status")
  .action(async () => {
    const memory = new (await getMemory())(process.cwd());
    await memory.init();
    const status = await memory.status();
    console.log(JSON.stringify(status, null, 2));
  });

// ─── Knowledge Graph Commands ───────────────────────────────────────────────

const kgCmd = program
  .command("knowledge")
  .description("Knowledge graph (entities)");

kgCmd
  .command("add")
  .description("Add entity to knowledge graph")
  .argument("<name>", "Entity name")
  .option("--type <type>", "Entity type", "general")
  .option("--facts <json>", "JSON facts object", "{}")
  .option("-t, --tags <tags>", "Comma-separated tags")
  .action(async (name, opts) => {
    const memory = new (await getMemory())(process.cwd());
    await memory.init();
    const facts = JSON.parse(opts.facts);
    const tags = opts.tags ? opts.tags.split(",").map((t) => t.trim()) : [];
    const result = await memory.knowledge.addEntity(name, opts.type, facts, tags);
    console.log(JSON.stringify(result, null, 2));
  });

kgCmd
  .command("get")
  .description("Get entity from knowledge graph")
  .argument("<name>", "Entity name")
  .action(async (name) => {
    const memory = new (await getMemory())(process.cwd());
    await memory.init();
    const entity = await memory.knowledge.getEntity(name);
    console.log(JSON.stringify(entity, null, 2));
  });

kgCmd
  .command("search")
  .description("Search knowledge graph")
  .argument("<query>", "Search query")
  .action(async (query) => {
    const memory = new (await getMemory())(process.cwd());
    await memory.init();
    const results = await memory.knowledge.searchEntities(query);
    console.log(JSON.stringify(results, null, 2));
  });

kgCmd
  .command("list")
  .description("List all entities")
  .option("--type <type>", "Filter by type")
  .action(async (opts) => {
    const memory = new (await getMemory())(process.cwd());
    await memory.init();
    const entities = await memory.knowledge.listEntities(opts.type);
    console.log(JSON.stringify(entities, null, 2));
  });

// ─── Config Command ─────────────────────────────────────────────────────────

program
  .command("config")
  .description("Generate hook configurations for all frameworks")
  .option("--hook-command <cmd>", "Custom hook command", "npx aik hook")
  .action((opts) => {
    const frameworks = ["claude", "cursor", "gemini"];
    const configs = {};
    for (const fw of frameworks) {
      configs[fw] = generateConfig(fw, opts.hookCommand);
    }
    console.log(JSON.stringify(configs, null, 2));
  });

program.parse();
