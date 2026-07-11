#!/usr/bin/env python3
"""
Agent Character Kit — Python CLI

Companion to the Node.js package. Provides:
- Hook execution for Python-based frameworks (Hermes, OpenCode)
- Character validation via enforcer daemon
- Knowledge/memory operations

Usage:
  python3 -m agent_character_kit hook --framework hermes
  python3 -m agent_character_kit enforcer --status
  python3 -m agent_character_kit index --path ./docs
  python3 -m agent_character_kit memory log "entry" --tags "tag1,tag2"
"""

import asyncio
import json
import os
import sys
import argparse
from pathlib import Path
from datetime import datetime, timezone

# ─── Self-resolving paths ────────────────────────────────────────────────────

import importlib.util

def _load(modname):
    """Lazily import a sub-module so unused components are never loaded."""
    here = Path(__file__).resolve().parent
    spec = importlib.util.spec_from_file_location(f"agent_character_kit.{modname}", here / f"{modname}.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod

def _load_indexer():
    # DocumentIndexer lives in the package __init__ (kept lean — no heavy deps).
    from . import DocumentIndexer
    return DocumentIndexer

HOME = Path(os.environ.get("HOME", "/root"))
# Harness-neutral default: the kit lives under the user's home, not a specific
# agent harness's directory. Override with AGENT_WORKSPACE (the user designates
# where their agent + habits reside).
WORKSPACE = Path(os.environ.get("AGENT_WORKSPACE", HOME / ".agent-character-kit" / "workspace"))
AUDIT_DIR = WORKSPACE / ".agent" / "audit"

# ─── Enforcer Client ─────────────────────────────────────────────────────────

def _enforcer():
    """Lazily build an EnforcerClient (keeps the enforcer component optional)."""
    return _load("enforcer").EnforcerClient()

# ─── Framework Detection ─────────────────────────────────────────────────────

def detect_framework(payload):
    if "hook_event_name" in payload:
        evt = payload["hook_event_name"]
        if evt in ("PreToolUse", "PostToolUse", "SessionStart", "Stop"):
            return "claude"
        if evt in ("BeforeTool", "AfterTool", "BeforeToolSelection"):
            return "gemini"
        if evt in ("preToolUse", "postToolUse", "beforeShellExecution"):
            return "cursor"
    if "tool_name" in payload and "args" in payload:
        return "hermes"
    if "tool" in payload and "args" in payload:
        return "opencode"
    return "generic"

def normalize_input(payload, framework):
    if framework == "claude":
        return {"tool": payload.get("tool_name", "unknown"), "params": payload.get("tool_input", {}),
                "event": payload.get("hook_event_name", "PreToolUse").lower(),
                "session_id": payload.get("session_id"), "cwd": payload.get("cwd")}
    elif framework == "cursor":
        return {"tool": payload.get("tool_name", payload.get("tool", "unknown")),
                "params": payload.get("tool_input", payload.get("args", {})),
                "event": payload.get("hook_event_name", "preToolUse").lower(),
                "session_id": payload.get("session_id"), "cwd": payload.get("cwd")}
    elif framework == "gemini":
        return {"tool": payload.get("tool_name", "unknown"), "params": payload.get("tool_input", {}),
                "event": payload.get("hook_event_name", "BeforeTool").lower(),
                "session_id": payload.get("session_id"), "cwd": payload.get("cwd")}
    elif framework == "hermes":
        return {"tool": payload.get("tool_name", "unknown"), "params": payload.get("args", {}),
                "event": "pre_tool_call", "session_id": payload.get("task_id")}
    elif framework == "opencode":
        return {"tool": payload.get("tool", payload.get("tool_name", "unknown")),
                "params": payload.get("args", payload.get("tool_input", {})),
                "event": payload.get("event", "tool.execute.before"),
                "session_id": payload.get("session_id")}
    else:
        return {"tool": payload.get("tool", payload.get("tool_name", "unknown")),
                "params": payload.get("params", payload.get("args", payload.get("tool_input", {}))),
                "event": payload.get("event", "pre_tool_use"),
                "session_id": payload.get("session_id")}

def format_output(result, framework, original):
    allowed = result.get("allow", True)
    reason = result.get("reason", "")

    if framework == "claude":
        if not allowed:
            return {"hookSpecificOutput": {"hookEventName": original.get("hook_event_name", "PreToolUse"),
                    "permissionDecision": "deny", "permissionDecisionReason": reason}}
        return {"hookSpecificOutput": {"hookEventName": original.get("hook_event_name", "PreToolUse"),
                "permissionDecision": "allow"}}
    elif framework == "cursor":
        return {"permission": "deny" if not allowed else "allow", "reason": reason if not allowed else None}
    elif framework == "gemini":
        return {"decision": "deny" if not allowed else "allow", "reason": reason if not allowed else None}
    elif framework == "hermes":
        return {"action": "block", "message": reason} if not allowed else {}
    elif framework == "opencode":
        return {"block": not allowed, "reason": reason if not allowed else None}
    else:
        return {"allow": allowed, "reason": reason if not allowed else None,
                "reflection": result.get("reflection") if not allowed else None}

def audit_log(event, tool, params, result=None):
    AUDIT_DIR.mkdir(parents=True, exist_ok=True)
    entry = {"ts": datetime.now(timezone.utc).isoformat(), "event": event, "tool": tool,
             "params": params, "result": result}
    with open(AUDIT_DIR / "tool-audit.jsonl", "a") as f:
        f.write(json.dumps(entry) + "\n")

# ─── Commands ────────────────────────────────────────────────────────────────

async def cmd_hook(args):
    payload = json.loads(sys.stdin.read()) if not sys.stdin.isatty() else {}
    framework = args.framework if args.framework != "auto" else detect_framework(payload)
    normalized = normalize_input(payload, framework)

    if normalized["tool"] in ("validate_workspace", "heartbeat", "execute_tool"):
        output = format_output({"allow": True}, framework, payload)
        print(json.dumps(output))
        return

    is_pre = normalized["event"] in ("pre_tool_use", "pretooluse", "beforetool", "pre_tool_call", "tool.execute.before")

    if is_pre:
        client = _load("enforcer").EnforcerClient()
        response = await client.validate_tool(normalized["tool"], normalized["params"],
                                               normalized.get("session_id", "unknown"))
        audit_log("pre_tool_use", normalized["tool"], normalized["params"], response)

        # Fail-closed by default: if the enforcer can't be reached, block.
        # Opt out only in development with ACK_FAIL_OPEN=1.
        fail_closed = not os.environ.get("ACK_FAIL_OPEN")
        if response.get("error") and fail_closed:
            result = {"allow": False,
                      "reason": response.get("reason", "Enforcer unavailable"),
                      "reflection": response.get("reflection",
                                    "The enforcer could not be reached. character cannot be "
                                    "verified, so the action is blocked. A guard that fails "
                                    "open is no guard.")}
        elif response.get("denied"):
            result = {"allow": False, "reason": response.get("reason", "Denied by enforcer"),
                      "reflection": response.get("reflection", "")}
        else:
            result = {"allow": True}
    else:
        audit_log("post_tool_use", normalized["tool"], normalized["params"], payload.get("result"))
        result = {"allow": True}

    output = format_output(result, framework, payload)
    print(json.dumps(output))
    if not result.get("allow", True) and framework in ("claude", "cursor", "gemini"):
        sys.exit(2)

async def cmd_enforcer(args):
    client = _enforcer()
    if args.status:
        result = await client.validate_workspace()
        print(json.dumps(result, indent=2))
    elif args.heartbeat:
        result = await client.heartbeat()
        print(json.dumps(result, indent=2))

# ─── Index Command (Python companion to Node package) ───────────────────────

def cmd_index(args):
    DocumentIndexer = _load_indexer()
    idx = DocumentIndexer(str(WORKSPACE))
    if args.path:
        target = args.path
    else:
        corpus = WORKSPACE / "corpus"
        corpus.mkdir(parents=True, exist_ok=True)
        target = str(corpus)
    res = idx.index_directory(target, {"followLinks": not args.no_follow})
    if args.search:
        print(json.dumps(idx.search(args.search), indent=2))
    else:
        print(json.dumps(res, indent=2))
    if args.status:
        print(json.dumps(idx.status(), indent=2))

# ─── Memory / Knowledge / Semantic commands (full parity with Node) ──────────

def cmd_memory(args):
    mem = _load("memory").Memory(str(WORKSPACE))
    mem.init()
    a = args.action
    if a == "log":
        print(json.dumps(mem.daily.log(args.entry, args.tags.split(",") if args.tags else [], args.category), indent=2))
    elif a == "today":
        print(json.dumps(mem.daily.get_today(), indent=2))
    elif a == "lesson":
        print(json.dumps(mem.longterm.add_lesson(args.title, args.content, args.tags.split(",") if args.tags else []), indent=2))
    elif a == "pattern":
        print(json.dumps(mem.longterm.add_pattern(args.name, args.description), indent=2))
    elif a == "decision":
        print(json.dumps(mem.longterm.add_decision(args.title, args.context, args.decision, args.rationale), indent=2))
    elif a == "search":
        print(json.dumps(mem.search(args.query), indent=2))
    elif a == "status":
        print(json.dumps(mem.status(), indent=2))


def cmd_knowledge(args):
    mem = _load("memory").Memory(str(WORKSPACE))
    mem.init()
    a = args.action
    if a == "add":
        import ast
        facts = ast.literal_eval(args.facts) if args.facts else {}
        print(json.dumps(mem.knowledge.add_entity(args.name, args.type or "general", facts, args.tags.split(",") if args.tags else []), indent=2))
    elif a == "get":
        print(json.dumps(mem.knowledge.get_entity(args.name), indent=2))
    elif a == "search":
        print(json.dumps(mem.knowledge.search_entities(args.query), indent=2))
    elif a == "list":
        print(json.dumps(mem.knowledge.list_entities(args.type), indent=2))


def cmd_semantic(args):
    sem = _load("semantic").SemanticSearch(str(WORKSPACE))
    sem.init()
    a = args.action
    if a == "index":
        idx = _load_indexer()(str(WORKSPACE))
        idx.init()
        count = 0
        for doc in idx.list_documents():
            doc_data = idx.index.documents[doc["id"]]
            for ch in doc_data.get("chunks", []):
                sem.index_document(ch["id"], ch["content"], {"parent": doc["id"],
                                                            "category": doc["category"], "tags": doc["tags"]})
                count += 1
        sem.save()
        print(json.dumps({"indexed": count, "status": "ok"}, indent=2))
    elif a == "search":
        print(json.dumps(sem.search(args.query, args.limit), indent=2))
    elif a == "hybrid":
        idx = _load_indexer()(str(WORKSPACE))
        idx.init()
        kw = idx.search(args.query, {"limit": args.limit})
        print(json.dumps(sem.hybrid_search(args.query, kw, args.limit), indent=2))
    elif a == "status":
        print(json.dumps(sem.status(), indent=2))


# ─── Main ────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Agent Character Kit (Python)")
    sub = parser.add_subparsers(dest="command")

    hook_p = sub.add_parser("hook", help="Run character hook")
    hook_p.add_argument("--framework", default="auto", choices=["claude", "cursor", "gemini", "hermes", "opencode", "generic", "auto"])

    enf_p = sub.add_parser("enforcer", help="Enforcer operations")
    enf_p.add_argument("--status", action="store_true")
    enf_p.add_argument("--heartbeat", action="store_true")

    idx_p = sub.add_parser("index", help="Index documents (file discovery + links + llms.txt)")
    idx_p.add_argument("--path", default=None, help="Directory or file to index")
    idx_p.add_argument("--search", default=None, help="Search indexed documents")
    idx_p.add_argument("--status", action="store_true", help="Show index status")
    idx_p.add_argument("--no-follow", action="store_true", help="Do not follow local links")

    mem_p = sub.add_parser("memory", help="Memory: daily / weekly / long-term")
    mem_sp = mem_p.add_subparsers(dest="action", required=True)
    m_log = mem_sp.add_parser("log"); m_log.add_argument("entry"); m_log.add_argument("-t", "--tags"); m_log.add_argument("-c", "--category", default="general")
    mem_sp.add_parser("today")
    m_lesson = mem_sp.add_parser("lesson"); m_lesson.add_argument("title"); m_lesson.add_argument("content"); m_lesson.add_argument("-t", "--tags")
    m_pat = mem_sp.add_parser("pattern"); m_pat.add_argument("name"); m_pat.add_argument("description")
    m_dec = mem_sp.add_parser("decision"); m_dec.add_argument("title"); m_dec.add_argument("context"); m_dec.add_argument("decision"); m_dec.add_argument("rationale")
    m_search = mem_sp.add_parser("search"); m_search.add_argument("query")
    mem_sp.add_parser("status")

    kg_p = sub.add_parser("knowledge", help="Knowledge graph (entities)")
    kg_sp = kg_p.add_subparsers(dest="action", required=True)
    k_add = kg_sp.add_parser("add"); k_add.add_argument("name"); k_add.add_argument("--type", default="general"); k_add.add_argument("--facts", default=None); k_add.add_argument("-t", "--tags")
    k_get = kg_sp.add_parser("get"); k_get.add_argument("name")
    k_search = kg_sp.add_parser("search"); k_search.add_argument("query")
    k_list = kg_sp.add_parser("list"); k_list.add_argument("--type", default=None)

    sem_p = sub.add_parser("semantic", help="Semantic (vector) search")
    sem_sp = sem_p.add_subparsers(dest="action", required=True)
    sem_sp.add_parser("index")
    s_search = sem_sp.add_parser("search"); s_search.add_argument("query"); s_search.add_argument("-l", "--limit", type=int, default=10)
    s_hybrid = sem_sp.add_parser("hybrid"); s_hybrid.add_argument("query"); s_hybrid.add_argument("-l", "--limit", type=int, default=10)
    sem_sp.add_parser("status")

    args = parser.parse_args()
    if not args.command:
        parser.print_help()
        sys.exit(1)

    if args.command == "hook":
        asyncio.run(cmd_hook(args))
    elif args.command == "enforcer":
        asyncio.run(cmd_enforcer(args))
    elif args.command == "index":
        cmd_index(args)
    elif args.command == "memory":
        cmd_memory(args)
    elif args.command == "knowledge":
        cmd_knowledge(args)
    elif args.command == "semantic":
        asyncio.run(_run_semantic(args))


async def _run_semantic(args):
    cmd_semantic(args)


if __name__ == "__main__":
    main()
