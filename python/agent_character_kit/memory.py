"""
Memory — three-layer continuity (daily / weekly / long-term) + knowledge graph.

Mirrors the Node `src/memory/index.js` module so both packages are at parity.
Each class is fully independent: use only what you need. No component is required
by any other — the hook/identity layer works with none of this present.

Files (all YAML, self-resolving under the workspace):
  memory/daily/YYYY-MM-DD.yaml
  memory/weekly/week-YYYY-MM-DD.yaml
  memory/long-term.yaml
  knowledge/entities/<name>.yaml
"""

from __future__ import annotations
from pathlib import Path
from datetime import datetime, timezone


def _now_iso():
    return datetime.now(timezone.utc).isoformat()


def _utc_date():
    return datetime.now(timezone.utc).strftime("%Y-%m-%d")


# ─── Daily notes ──────────────────────────────────────────────────────────────

class DailyNotes:
    def __init__(self, workspace: str):
        self.workspace = Path(workspace)
        self.daily_dir = self.workspace / "memory" / "daily"

    def init(self):
        self.daily_dir.mkdir(parents=True, exist_ok=True)

    def _today_file(self):
        return self.daily_dir / f"{_utc_date()}.yaml"

    def log(self, entry, tags=None, category="general"):
        from ._yaml import load_yaml, dump_yaml  # local import keeps deps lazy
        self.init()
        fp = self._today_file()
        data = load_yaml(fp) or {"date": _utc_date(), "created_at": _now_iso(), "entries": []}
        data.setdefault("entries", []).append({
            "timestamp": _now_iso(),
            "content": entry,
            "tags": tags or [],
            "category": category,
        })
        data["updated_at"] = _now_iso()
        fp.write_text(dump_yaml(data))
        return {"status": "logged", "file": str(fp)}

    def get_today(self):
        from ._yaml import load_yaml
        try:
            return load_yaml(self._today_file()) or {}
        except FileNotFoundError:
            return {"date": _utc_date(), "entries": []}

    def list_notes(self):
        from ._yaml import load_yaml
        notes = []
        try:
            for f in sorted(self.daily_dir.glob("*.yaml"), reverse=True):
                data = load_yaml(f) or {}
                notes.append({"date": data.get("date", f.stem), "file": str(f),
                              "entries": len(data.get("entries", []))})
        except FileNotFoundError:
            pass
        return notes


# ─── Weekly digest ────────────────────────────────────────────────────────────

class WeeklyDigest:
    def __init__(self, workspace: str):
        self.workspace = Path(workspace)
        self.weekly_dir = self.workspace / "memory" / "weekly"

    def init(self):
        self.weekly_dir.mkdir(parents=True, exist_ok=True)

    def create(self, week_start, summary, patterns=None, decisions=None):
        from ._yaml import dump_yaml
        self.init()
        fp = self.weekly_dir / f"week-{week_start}.yaml"
        data = {"week_start": week_start, "created_at": _now_iso(), "summary": summary,
                "patterns": patterns or [], "decisions": decisions or []}
        fp.write_text(dump_yaml(data))
        return {"status": "created", "file": str(fp)}

    def get(self, week_start):
        from ._yaml import load_yaml
        try:
            return load_yaml(self.weekly_dir / f"week-{week_start}.yaml") or {}
        except FileNotFoundError:
            return {}

    def list_digests(self):
        from ._yaml import load_yaml
        out = []
        try:
            for f in sorted(self.weekly_dir.glob("week-*.yaml"), reverse=True):
                data = load_yaml(f) or {}
                out.append({"weekStart": data.get("week_start", f.stem), "file": str(f),
                            "patterns": len(data.get("patterns", []))})
        except FileNotFoundError:
            pass
        return out


# ─── Long-term memory ─────────────────────────────────────────────────────────

class LongTermMemory:
    def __init__(self, workspace: str):
        self.workspace = Path(workspace)
        self.file_path = self.workspace / "memory" / "long-term.yaml"

    def init(self):
        self.file_path.parent.mkdir(parents=True, exist_ok=True)

    def _load(self):
        from ._yaml import load_yaml
        try:
            return load_yaml(self.file_path) or {"lessons": [], "patterns": [], "decisions": []}
        except FileNotFoundError:
            return {"lessons": [], "patterns": [], "decisions": []}

    def _save(self, data):
        from ._yaml import dump_yaml
        data["updated_at"] = _now_iso()
        self.file_path.write_text(dump_yaml(data))

    def add_lesson(self, title, content, tags=None, category="general"):
        data = self._load()
        data.setdefault("lessons", []).append({
            "title": title, "content": content, "tags": tags or [],
            "category": category, "added_at": _now_iso()})
        self._save(data)
        return {"status": "added", "total": len(data["lessons"])}

    def add_pattern(self, name, description, examples=None):
        data = self._load()
        data.setdefault("patterns", []).append({
            "name": name, "description": description, "examples": examples or [],
            "added_at": _now_iso()})
        self._save(data)
        return {"status": "added", "total": len(data["patterns"])}

    def add_decision(self, title, context, decision, rationale):
        data = self._load()
        data.setdefault("decisions", []).append({
            "title": title, "context": context, "decision": decision,
            "rationale": rationale, "made_at": _now_iso()})
        self._save(data)
        return {"status": "added", "total": len(data["decisions"])}

    def search(self, query):
        q = query.lower()
        data = self._load()
        out = []
        for kind in ("lessons", "patterns", "decisions"):
            for item in data.get(kind, []):
                blob = " ".join(str(v) for v in item.values()).lower()
                if q in blob:
                    out.append({"type": kind, **item})
        return out

    def get_all(self):
        return self._load()


# ─── Knowledge graph ──────────────────────────────────────────────────────────

class KnowledgeGraph:
    def __init__(self, workspace: str):
        self.workspace = Path(workspace)
        self.entities_dir = self.workspace / "knowledge" / "entities"

    def init(self):
        self.entities_dir.mkdir(parents=True, exist_ok=True)

    def _entity_file(self, name):
        safe = name.lower().replace(" ", "-").replace("/", "-")
        return self.entities_dir / f"{safe}.yaml"

    def add_entity(self, name, etype, facts=None, tags=None):
        from ._yaml import load_yaml, dump_yaml
        self.init()
        fp = self._entity_file(name)
        existing = load_yaml(fp) or {}
        data = {"name": name, "type": etype, "tags": tags or [], "facts": facts or {},
                "created_at": existing.get("created_at", _now_iso()), "updated_at": _now_iso()}
        fp.write_text(dump_yaml(data))
        return {"status": "added", "file": str(fp)}

    def get_entity(self, name):
        from ._yaml import load_yaml
        try:
            return load_yaml(self._entity_file(name)) or {}
        except FileNotFoundError:
            return {}

    def search_entities(self, query):
        from ._yaml import load_yaml
        out = []
        try:
            for f in self.entities_dir.glob("*.yaml"):
                data = load_yaml(f) or {}
                if query.lower() in str(data).lower():
                    out.append(data)
        except FileNotFoundError:
            pass
        return out

    def list_entities(self, etype=None):
        from ._yaml import load_yaml
        out = []
        try:
            for f in self.entities_dir.glob("*.yaml"):
                data = load_yaml(f) or {}
                if etype and data.get("type") != etype:
                    continue
                out.append({"name": data.get("name"), "type": data.get("type"), "file": str(f)})
        except FileNotFoundError:
            pass
        return out


# ─── Aggregate ────────────────────────────────────────────────────────────────

class Memory:
    def __init__(self, workspace: str):
        self.workspace = str(workspace)
        self.daily = DailyNotes(self.workspace)
        self.weekly = WeeklyDigest(self.workspace)
        self.longterm = LongTermMemory(self.workspace)
        self.knowledge = KnowledgeGraph(self.workspace)

    def init(self):
        self.daily.init(); self.weekly.init(); self.longterm.init(); self.knowledge.init()

    def status(self):
        return {
            "dailyNotes": len(self.daily.list_notes()),
            "weeklyDigests": len(self.weekly.list_digests()),
            "longtermLessons": len(self.longterm.get_all().get("lessons", [])),
            "longtermPatterns": len(self.longterm.get_all().get("patterns", [])),
            "longtermDecisions": len(self.longterm.get_all().get("decisions", [])),
            "entities": len(self.knowledge.list_entities()),
        }

    def search(self, query):
        return {"longterm": self.longterm.search(query), "entities": self.knowledge.search_entities(query)}
