/**
 * Agent Character Kit
 *
 * Core: Character hook enforcement via enforcer daemon
 * Secondary: Knowledge indexing + memory with YAML frontmatter
 *
 * Every document gets proper YAML frontmatter for efficient searching.
 * Every tool call gets validated through the enforcer.
 */

// ─── Core: Character Enforcement ─────────────────────────────────────────────

export { EnforcerClient } from "./enforcer/client.js";
export { processToolCall, processPromptSubmit, generateConfig } from "./hooks/character.js";

// ─── Secondary: Knowledge & Memory ──────────────────────────────────────────

export { DocumentIndexer } from "./knowledge/indexer.js";
export { SemanticSearch } from "./knowledge/semantic.js";
export { Memory, DailyNotes, WeeklyDigest, LongTermMemory, KnowledgeGraph } from "./memory/index.js";

// ─── Version ────────────────────────────────────────────────────────────────

export { VERSION } from "./version.js";
