"""Parity tests for the Python package (mirrors tests/enforcer.test.js + identity.test.js)."""
import os
import sys
import json
import tempfile
import importlib.util
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))


def load(modname):
    spec = importlib.util.spec_from_file_location(
        f"aik_{modname}", HERE.parent / "agent_identity_kit" / f"{modname}.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def tmp_ws():
    d = Path(tempfile.mkdtemp(prefix="aik-py-"))
    (d / ".agent" / "habits").mkdir(parents=True)
    (d / ".agent" / "constitution.yaml").write_text(
        "agent:\n  id: t\ncore_values:\n  - be excellent\n"
        "hard_constraints:\n  - \"rm -rf /\"\n  - \"git push --force\"\n")
    (d / ".agent" / "enforcer.yaml").write_text("allow:\n  - \"ls\"\n  - \"git status\"\n")
    return d


def test_enforcer_allowlist_and_audit():
    ws = tmp_ws()
    prev = os.environ.get("AGENT_WORKSPACE")
    os.environ["AGENT_WORKSPACE"] = str(ws)
    try:
        from agent_identity_kit.enforcer import Enforcer
        enf = Enforcer()
        r1 = enf.execute_tool("Bash", {"command": "ls"})
        r2 = enf.execute_tool("Bash", {"command": "rm file"})
        r3 = enf.execute_tool("Bash", {"command": "rm -rf /"})
        assert r1["denied"] is False
        assert r2["denied"] is True
        assert r3["denied"] is True
        # every call is audited (allow leaves a trail)
        log = enf.audit_path()
        assert log.exists(), "audit log should exist"
        lines = log.read_text(encoding="utf-8").strip().splitlines()
        assert len(lines) == 3
        assert json.loads(lines[0])["decision"] == "allow"
    finally:
        if prev is None:
            del os.environ["AGENT_WORKSPACE"]
        else:
            os.environ["AGENT_WORKSPACE"] = prev


def test_memory_and_knowledge_modules():
    ws = tmp_ws()
    from agent_identity_kit.memory import Memory
    mem = Memory(str(ws))
    mem.init()
    mem.daily.log("did X", ["a", "b"], "dev")
    mem.longterm.add_lesson("Ctx", "fresh beats exhausted", ["x"])
    mem.knowledge.add_entity("Kyle", "person", {"tz": "PST"}, [])
    st = mem.status()
    assert st["dailyNotes"] == 1
    assert st["longtermLessons"] == 1
    assert st["entities"] == 1
    ent = mem.knowledge.get_entity("Kyle")
    assert ent["facts"]["tz"] == "PST"


def test_indexer_excludes_agent_internal():
    ws = Path(tempfile.mkdtemp(prefix="aik-py-idx-"))
    (ws / "SOUL.md").write_text("# soul\n")
    (ws / ".agent").mkdir()
    (ws / ".agent" / "constitution.yaml").write_text("agent:\n  id: x\n")
    (ws / "userdoc.md").write_text("real corpus doc\n")
    import agent_identity_kit
    idx = agent_identity_kit.DocumentIndexer(str(ws))
    idx.init()
    res = idx.index_directory(str(ws), {})
    assert res["indexed"] == 1
    assert any("userdoc" in k for k in idx.index["documents"])
