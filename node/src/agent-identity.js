// Resolves a real, human-identifiable name for an agent workspace --
// used ONLY for cosmetic/utility purposes (socket filenames, log labels).
// Read-only: never writes to an identity file, never used in any
// enforcement decision. ACK's own stated boundary stays intact --
// "the kit never manages or touches identity" (AGENTS.md/README.md) --
// this only ever reads a name string for display/naming purposes.
//
// Resolution order (drdeek's spec, 2026-08-07):
//   1. A real identity file in the workspace: agent.json's "name" field,
//      then SOUL.md (YAML frontmatter "name:", else its first # heading).
//   2. For a "terminal" harness (claude/hermes/opencode) NOT being used
//      in a delegated multi-agent setup: the harness's own name --
//      "if these aren't having it be delegated separately for multiple
//      agents or directories then it just goes off of the root location
//      install... it would just take 'claude'."
//   3. Otherwise, ask (only when the caller provides askFn -- an
//      interactive wizard step; non-interactive/--yes callers must never
//      hang waiting for input, so they never pass one).
//   4. "generic" -- last resort, nothing else applied at all.
import fs from "fs";
import path from "path";
import matter from "gray-matter";

const KNOWN_TERMINAL_HARNESSES = new Set(["claude", "hermes", "opencode"]);

// Socket/directory-safe: lowercase, alphanumeric + hyphen only, no leading
// or trailing hyphen, empty-after-cleaning treated as no name at all.
function sanitizeName(raw) {
  if (typeof raw !== "string") return null;
  const clean = raw.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return clean || null;
}

export function extractAgentName(dir) {
  const agentJsonPath = path.join(dir, "agent.json");
  if (fs.existsSync(agentJsonPath)) {
    try {
      const data = JSON.parse(fs.readFileSync(agentJsonPath, "utf8"));
      const sanitized = sanitizeName(data && data.name);
      if (sanitized) return sanitized;
    } catch { /* malformed agent.json -- fall through to SOUL.md */ }
  }

  const soulPath = path.join(dir, "SOUL.md");
  if (fs.existsSync(soulPath)) {
    try {
      const { data, content } = matter(fs.readFileSync(soulPath, "utf8"));
      const fromFrontmatter = sanitizeName(data && data.name);
      if (fromFrontmatter) return fromFrontmatter;
      const headingMatch = content.match(/^#\s+(.+)$/m);
      if (headingMatch) {
        const fromHeading = sanitizeName(headingMatch[1]);
        if (fromHeading) return fromHeading;
      }
    } catch { /* unreadable/unparseable SOUL.md -- no name available */ }
  }

  return null;
}

export function harnessRootName(harness) {
  return KNOWN_TERMINAL_HARNESSES.has(harness) ? harness : null;
}

export async function resolveAgentName({ ws, harness, isDelegatedMultiAgent = false, askFn }) {
  const fromIdentity = extractAgentName(ws);
  if (fromIdentity) return fromIdentity;

  const rootName = harnessRootName(harness);
  if (rootName && !isDelegatedMultiAgent) {
    // Common case: one shared claude/hermes/opencode install, no per-agent
    // identity file, no separate delegation -- the harness IS the
    // identifier here. Asking "what's your agent's name" would be pointless
    // friction for the overwhelmingly common single-install case.
    return rootName;
  }

  if (askFn) {
    const typed = sanitizeName(await askFn());
    if (typed) return typed;
  }

  return rootName || "generic";
}
