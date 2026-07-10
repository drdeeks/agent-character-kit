"""
Test: Agent Character Kit Hermes plugin (pre_tool_call enforcement, thin client).

The plugin is a THIN CLIENT to the enforcer daemon (single source of truth).
These tests prove:
  1. block test   — when a daemon is reachable, allow/deny match its policy.
  2. fail-closed  — when the daemon socket is DOWN, the plugin BLOCKS (never allows).
  3. manifest     — compact {habit,prompt} manifest on every call (token-bounded),
                     on-demand get_habit returns full assert/evidence/logic proof,
                     daemon self-verify reports no defects.

Run from the agent-character-kit dir:
    python3 -m pytest python/hermes_plugin/test_plugin.py -q
or directly:
    python3 python/hermes_plugin/test_plugin.py
"""

import asyncio
import importlib.util
import os
import pathlib
import socket
import subprocess
import sys
import tempfile
import time

_HERE = pathlib.Path(__file__).resolve().parent
_ROOT = _HERE.parent.parent  # repo root (agent-character-kit/)
sys.path.insert(0, str(_ROOT))
sys.path.insert(0, str(_ROOT / "python"))
sys.path.insert(0, str(_HERE))

DAEMON = _ROOT / "node" / "enforcer" / "agent_enforcer_daemon.js"
NODE = os.environ.get("ACK_NODE", "node")


def _load_plugin():
    spec = importlib.util.spec_from_file_location("aik_plugin", str(_HERE / "__init__.py"))
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m


def _call_hook(m, cmd):
    res = m._on_pre_tool_call(tool_name="Bash", args={"command": cmd})
    # Hermes convention: None (or no action:block) means ALLOW.
    return res or {"action": "allow"}


def _free_tcp_port():
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


def _start_daemon(sock_addr: str, workspace: str = None):
    """Spawn the real daemon (the single source of truth) on sock_addr.

    workspace=None -> an EMPTY temp dir (proves usefulness out of the box,
    embedded defaults, FOREVER-SYSTEM §1). Pass node/examples to exercise the
    full habit set + prompts + proof layer.
    """
    tmp = workspace or tempfile.mkdtemp()
    env = dict(os.environ, ENFORCER_SOCKET=sock_addr, AGENT_WORKSPACE=tmp)
    p = subprocess.Popen([NODE, str(DAEMON)], env=env)
    deadline = time.time() + 10
    if sock_addr.startswith("tcp://"):
        host, port = sock_addr[len("tcp://"):].split(":")
        while time.time() < deadline:
            try:
                with socket.create_connection((host, int(port)), timeout=0.5):
                    return p
            except OSError:
                time.sleep(0.1)
    else:
        while time.time() < deadline:
            if os.path.exists(sock_addr):
                return p
            time.sleep(0.1)
    p.terminate()
    raise RuntimeError("daemon did not start")


def _run_block_test():
    # Use the daemon's seeded example workspace (has hard_constraints + leak habit).
    sock = f"tcp://127.0.0.1:{_free_tcp_port()}"
    proc = _start_daemon(sock)
    try:
        os.environ["ENFORCER_SOCKET"] = sock
        m = _load_plugin()
        assert _call_hook(m, "ls -la").get("action") != "block", "ls must be allowed"
        assert _call_hook(m, "rm -rf /").get("action") == "block", "rm -rf / must block"
        assert _call_hook(m, "sudo bash").get("action") == "block", "sudo must block"
        assert _call_hook(m, "curl x?api_key=sk-ABC123").get("action") == "block", "leak must block"
        assert _call_hook(m, "echo read api_key from vault").get("action") != "block", "mention must allow"
        print("  PASS: blocks rm -rf /, sudo, leak; allows ls + mention (via daemon)")
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()


def _run_manifest_test():
    # Boot the daemon on the EXAMPLES workspace (full habit set + prompts + proof).
    examples = str(_ROOT / "node" / "examples")
    sock = f"tcp://127.0.0.1:{_free_tcp_port()}"
    proc = _start_daemon(sock, workspace=examples)
    try:
        os.environ["ENFORCER_SOCKET"] = sock
        import sys as _sys
        _sys.path.insert(0, str(_ROOT / "python"))
        from agent_character_kit.enforcer import EnforcerClient
        c = EnforcerClient(sock)

        async def run():
            ls = await c.call("execute_tool", {"tool": "Bash", "command": "ls"})
            g = await c.call("get_habit", {"name": "verify_functionality_not_syntax"})
            return ls, g
        ls, g = asyncio.run(run())

        # Manifest: compact {habit, prompt}, no prose, every call.
        man = ls.get("manifest", [])
        assert isinstance(man, list) and len(man) == 14, f"expected 14 manifest entries, got {len(man)}"
        assert all(set(m.keys()) == {"habit", "prompt"} for m in man), "manifest entries must be {habit,prompt} only"
        assert all(len(m["prompt"]) < 90 for m in man), "manifest prompts must stay short (token-bounded)"
        assert not ls.get("self_verify_defects"), f"self-verify defects: {ls.get('self_verify_defects')}"

        # get_habit: on-demand full proof (assert + evidence + logic).
        assert g.get("name") == "verify_functionality_not_syntax"
        assert g.get("prompt") and g.get("assert") and g.get("evidence") and g.get("logic"), \
            "get_habit must return full proof (prompt+assert+evidence+logic)"

        # Unknown habit -> error, not a silent empty proof.
        bad = asyncio.run(c.call("get_habit", {"name": "does_not_exist"}))
        assert bad.get("error"), "get_habit on unknown name must error"

        print("  PASS: compact manifest per call + get_habit proof layer (14 habits)")
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()


def _run_fail_closed_test():
    # Point the plugin at a socket that does NOT exist -> daemon down -> block.
    os.environ["ENFORCER_SOCKET"] = "/tmp/aik-nonexistent-XXXX/main.sock"
    m = _load_plugin()
    res = _call_hook(m, "ls -la")
    assert res is not None and res.get("action") == "block", f"expected fail-closed block, got {res}"
    assert "unavailable" in (res.get("message", "").lower()) or "guard" in res.get("message", "").lower()
    print("  PASS: fails CLOSED when daemon socket is down")


if __name__ == "__main__":
    print("agent-character-kit hermes plugin (thin client):")
    _run_block_test()
    _run_fail_closed_test()
    _run_manifest_test()
    print("ALL PASS")
