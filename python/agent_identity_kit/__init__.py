"""
Agent Identity Kit — Python module

Provides the same document-indexing capabilities as the Node.js package:
- Broad file-type discovery (markdown, code, config, agent docs, etc.)
- Automatic YAML frontmatter injection
- Link / reference extraction (the agent documents links to informational docs)
- llms.txt / agents.md manifest parsing
- Optional link-following to also index referenced local files

Usage:
    from agent_identity_kit import DocumentIndexer
    idx = DocumentIndexer("/path/to/workspace")
    idx.index_directory("./docs")
"""

import json
import re
from pathlib import Path
from datetime import datetime, timezone

# ─── Supported File Extensions ──────────────────────────────────────────────

EXTENSIONS = {
    "markdown": [".md", ".mdx", ".mdown", ".markdown"],
    "text": [".txt", ".text", ".rst", ".adoc", ".asciidoc", ".org", ".tex", ".latex"],
    "wiki": [".wiki", ".mediawiki", ".dokuwiki", ".tiddlywiki"],
    "yaml": [".yaml", ".yml"],
    "json": [".json", ".jsonl", ".json5", ".ndjson", ".geojson"],
    "toml": [".toml", ".ini", ".cfg", ".conf"],
    "xml": [".xml", ".xaml", ".svg", ".html", ".htm", ".xhtml"],
    "csv": [".csv", ".tsv", ".psv"],
    "code": [".py", ".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx", ".sh", ".bash",
             ".zsh", ".fish", ".rb", ".go", ".rs", ".java", ".kt", ".swift", ".c",
             ".cpp", ".h", ".hpp", ".cs", ".sql", ".r", ".lua", ".pl", ".perl",
             ".vim", ".el", ".lisp", ".clj"],
    "agent": [".agent", ".skill", ".hook", ".prompt", ".template"],
}

# Exact-match filenames (case-insensitive)
EXACT_NAMES = {
    "llms.txt", "llms-full.txt", "agents.md", "agent.md",
    "identity.md", "constitution.md", "user.md", "tools.md", "memory.md",
    "heartbeat.md", "system.md", ".agent", ".skill", ".hook", ".prompt", ".template",
}

# The agent's OWN files (identity, habits, memory, knowledge graph) are never
# indexed as user-supplied corpus.
AGENT_INTERNAL_FILES = {
    "soul.md", "identity.md", "constitution.md", "agents.md", "user.md",
    "tools.md", "memory.md", "heartbeat.md", "constitution.yaml",
    "constitution.yml", "enforcer.yaml", "genesis.md", "readme.md",
}
AGENT_INTERNAL_DIRS = {
    ".agent", "habits", "memory", "knowledge", ".secrets",
    "node_modules", ".git", ".openclaw",
}

ALL_EXTENSIONS = sorted(
    {ext for group in EXTENSIONS.values() for ext in group}
)

CATEGORY_RULES = [
    (r"SOUL|IDENTITY|CONSTITUTION", "identity"),
    (r"AGENTS|TOOLS|HEARTBEAT|USER\.md", "agent_config"),
    (r"MEMORY|JOURNAL|LOG", "memory"),
    (r"README|CHANGELOG|LICENSE|CONTRIBUTING", "documentation"),
    (r"TODO|TASKS|BACKLOG", "task_list"),
    (r"SKILL|TUTORIAL|GUIDE|HOWTO|LEARN", "skill"),
    (r"daily|journal|log", "daily_note"),
    (r"transcript|session|conversation", "transcript"),
    (r"blog|post|article", "blog"),
    (r"experiment|spike|research", "experiment"),
    (r"knowledge|entity|person|company", "knowledge_graph"),
    (r"lesson|pattern|decision|learning", "long_term"),
    (r"spec|rfc|adr|decision", "spec"),
    (r"doc|docs|reference", "documentation"),
    (r"config|settings|env", "config"),
    (r"test|spec|__tests__", "test"),
    (r"skill|hook|prompt|template", "agent_skill"),
    (r"^---\n[\s\S]*?type:\s*person", "knowledge_graph"),
    (r"^---\n[\s\S]*?tags?:\s*\[", "tagged"),
]


def is_indexable(name: str, extensions=None) -> bool:
    extensions = extensions or ALL_EXTENSIONS
    lower = name.lower()
    if lower in AGENT_INTERNAL_FILES:
        return False
    if lower in EXACT_NAMES:
        return True
    return Path(name).suffix.lower() in extensions


def infer_category(file_path: str, content: str) -> str:
    head = content[:500]
    for pattern, category in CATEGORY_RULES:
        if re.search(pattern, file_path, re.IGNORECASE) or re.search(pattern, head):
            return category
    return "document"


def chunk_text(text: str, size: int = 1000):
    words = text.split()
    chunks, cur = [], []
    count = 0
    for w in words:
        cur.append(w)
        count += len(w) + 1
        if count >= size:
            chunks.append(" ".join(cur))
            cur, count = [], 0
    if cur:
        chunks.append(" ".join(cur))
    return chunks or [""]


def extract_tags(content: str, file_path: str):
    tags = set()
    base = Path(file_path).stem.lower().replace("_", " ").replace("-", " ")
    tags.add(base)
    for m in re.finditer(r"tags?:\s*\[([^\]]+)\]", content, re.IGNORECASE):
        for t in re.split(r"[,\s]+", m.group(1)):
            t = t.strip().strip('"\'')
            if len(t) > 1:
                tags.add(t.lower())
    for m in re.finditer(r"#(\w+)", content):
        tags.add(m.group(1).lower())
    return sorted(tags)


# ─── Link / Reference Extraction ─────────────────────────────────────────────

LINK_PATTERNS = [
    ("markdown", re.compile(r"\[[^\]]*\]\(\s*([^)\s]+)\s*\)")),
    ("url", re.compile(r"(?:^|[\s(])(https?://[^\s)\]]+)")),
    ("wiki", re.compile(r"\[\[\s*([^\]|#]+)(?:[|#][^\]]*)?\s*\]\]")),
    ("embed", re.compile(r"!\[\[\s*([^\]|#]+)(?:[|#][^\]]*)?\s*\]\]")),
    ("docref", re.compile(r"(?:doc|file|ref|see|import|include)\s*[:=]\s*[\"']?([^\s\"')]+)")),
    ("arxiv", re.compile(r"(?:arxiv\.org/abs/|arXiv:)(\d+\.\d+)")),
]


def extract_links(content: str, base_path: Path = None):
    found = []
    seen = set()
    for kind, rx in LINK_PATTERNS:
        for m in rx.finditer(content):
            target = m.group(1).strip().rstrip(".,;:")
            if not target or target in seen:
                continue
            seen.add(target)
            resolved = None
            ext = target.startswith("http") or target.startswith("@") or kind == "arxiv"
            if base_path and not ext:
                cand = (base_path.parent / target).resolve()
                if cand.exists():
                    resolved = str(cand)
            found.append({
                "type": kind,
                "target": target,
                "resolved_path": resolved,
                "external": bool(ext),
            })
    return found


def parse_llms_txt(content: str, base_dir: Path = None):
    details = []
    for line in content.splitlines():
        m = re.match(r"^\s*[-\*]\s*\[([^\]]+)\]\(([^)]+)\)\s*[:\-]?\s*(.*)$", line)
        if m:
            title, url, desc = m.group(1).strip(), m.group(2).strip(), m.group(3).strip()
            external = url.startswith("http")
            resolved = str((base_dir / url).resolve()) if base_dir and not external else None
            details.append({
                "title": title,
                "url": url,
                "description": desc,
                "external": external,
                "resolved_path": resolved,
            })
    return details


# ─── Document Indexer ────────────────────────────────────────────────────────

class DocumentIndexer:
    def __init__(self, workspace: str):
        self.workspace = Path(workspace).resolve()
        self.knowledge_dir = self.workspace / "knowledge"
        self.yaml_dir = self.knowledge_dir / "documents"
        self.db_path = self.knowledge_dir / "index.json"
        self.yaml_dir.mkdir(parents=True, exist_ok=True)
        self.index = self._load()

    def init(self):
        """Create the knowledge store dirs and (re)load the index.

        Mirrors the Node DocumentIndexer.init() so both packages are at parity
        and callers can construct, then init(), before indexing.
        """
        self.knowledge_dir.mkdir(parents=True, exist_ok=True)
        self.yaml_dir.mkdir(parents=True, exist_ok=True)
        self.index = self._load()
        return self

    def _load(self):
        if self.db_path.exists():
            try:
                return json.loads(self.db_path.read_text())
            except Exception:
                pass
        return {"meta": {}, "documents": {}, "links": {}}

    def _save(self):
        self.index["meta"]["lastIndexed"] = datetime.now(timezone.utc).isoformat()
        self.db_path.write_text(json.dumps(self.index, indent=2))

    def index_file(self, file_path: str, options=None):
        options = options or {}
        abs_path = Path(file_path).resolve()
        content = abs_path.read_text(encoding="utf-8", errors="ignore")

        # strip existing frontmatter
        body = content
        if content.startswith("---"):
            end = content.find("\n---", 3)
            if end != -1:
                body = content[end + 4:].lstrip("\n")

        doc_id = str(abs_path.relative_to(self.workspace)).replace("/", "-").rsplit(".", 1)[0]
        stat = abs_path.stat()
        content_hash = str(stat.st_mtime_ns)

        if self.index["documents"].get(doc_id, {}).get("contentHash") == content_hash:
            return {"status": "skipped", "docId": doc_id}

        category = options.get("category") or infer_category(str(abs_path), body)
        tags = options.get("tags") or extract_tags(body, str(abs_path))
        title = Path(abs_path).stem

        frontmatter = {
            "id": doc_id,
            "title": title,
            "category": category,
            "tags": tags,
            "type": category,
            "source": str(abs_path.relative_to(self.workspace)),
            "indexed_at": datetime.now(timezone.utc).isoformat(),
            "updated_at": datetime.fromtimestamp(stat.st_mtime, timezone.utc).isoformat(),
        }
        yaml_content = "---\n" + "\n".join(f"{k}: {json.dumps(v)}" for k, v in frontmatter.items()) + "\n---\n\n" + body
        (self.yaml_dir / f"{doc_id}.yaml").write_text(yaml_content)

        chunks = chunk_text(body)
        links = extract_links(body, abs_path)
        basename = abs_path.name.lower()

        llms_refs = []
        if basename in ("llms.txt", "llms-full.txt", "agents.md"):
            llms_refs = parse_llms_txt(body, abs_path.parent)
            for ref in llms_refs:
                self.index["links"][ref["url"]] = {
                    "title": ref["title"],
                    "category": "reference",
                    "description": ref["description"],
                    "external": ref["external"],
                    "source_doc": doc_id,
                    "added_at": datetime.now(timezone.utc).isoformat(),
                }

        self.index["documents"][doc_id] = {
            "path": str(abs_path.relative_to(self.workspace)),
            "title": title,
            "category": category,
            "tags": tags,
            "contentHash": content_hash,
            "indexed_at": datetime.now(timezone.utc).isoformat(),
            "chunk_count": len(chunks),
            "links": [l["target"] for l in links],
            "link_count": len(links),
            "chunks": [{"id": f"{doc_id}:chunk-{i}", "content": c} for i, c in enumerate(chunks)],
        }

        for l in links:
            key = l["target"]
            if key not in self.index["links"]:
                self.index["links"][key] = {
                    "type": l["type"],
                    "category": "reference",
                    "external": l["external"],
                    "source_doc": doc_id,
                    "resolved_path": l["resolved_path"],
                    "added_at": datetime.now(timezone.utc).isoformat(),
                }

        self._save()
        return {"status": "indexed", "docId": doc_id, "chunks": len(chunks), "links": len(links)}

    def index_directory(self, dir_path: str, options=None):
        options = options or {}
        follow_links = options.get("followLinks", True)
        extensions = options.get("extensions") or ALL_EXTENSIONS
        results = {"indexed": 0, "skipped": 0, "errors": 0, "links": 0}
        seen = set()

        def walk(d: Path):
            try:
                entries = sorted(d.iterdir())
            except Exception:
                return
            for entry in entries:
                if entry.is_dir():
                    if (not entry.name.startswith(".")
                            and entry.name not in AGENT_INTERNAL_DIRS):
                        walk(entry)
                elif is_indexable(entry.name, extensions):
                    if entry in seen:
                        continue
                    seen.add(entry)
                    try:
                        r = self.index_file(entry, options)
                        if r["status"] == "indexed":
                            results["indexed"] += 1
                        else:
                            results["skipped"] += 1
                        if follow_links:
                            for doc in self.index["documents"].values():
                                for link in doc.get("links", []):
                                    rec = self.index["links"].get(link)
                                    if rec and rec.get("resolved_path"):
                                        rp = Path(rec["resolved_path"])
                                        if rp.exists() and rp not in seen:
                                            seen.add(rp)
                                            try:
                                                rr = self.index_file(rp, options)
                                                if rr["status"] == "indexed":
                                                    results["links"] += 1
                                            except Exception:
                                                pass
                    except Exception:
                        results["errors"] += 1

        walk(Path(dir_path).resolve())
        self._save()
        return results

    def search(self, query: str, limit=10, category=None):
        q = query.lower()
        out = []
        for doc_id, doc in self.index["documents"].items():
            if category and doc.get("category") != category:
                continue
            for chunk in doc.get("chunks", []):
                idx = chunk["content"].lower().find(q)
                if idx != -1:
                    start = max(0, idx - 100)
                    end = min(len(chunk["content"]), idx + len(q) + 100)
                    out.append({
                        "docId": doc_id,
                        "path": doc["path"],
                        "title": doc["title"],
                        "category": doc["category"],
                        "tags": doc["tags"],
                        "snippet": chunk["content"][start:end],
                    })
                    break
        return out[:limit]

    def status(self):
        return {
            "documents": len(self.index["documents"]),
            "chunks": sum(d.get("chunk_count", 0) for d in self.index["documents"].values()),
            "links": len(self.index["links"]),
            "last_indexed": self.index.get("meta", {}).get("lastIndexed"),
            "knowledge_dir": str(self.knowledge_dir),
        }


from .enforcer import Enforcer, EnforcerClient

__all__ = [
    "DocumentIndexer", "is_indexable", "extract_links", "parse_llms_txt",
    "Memory", "DailyNotes", "WeeklyDigest", "LongTermMemory", "KnowledgeGraph",
    "SemanticSearch", "Enforcer", "EnforcerClient",
]
