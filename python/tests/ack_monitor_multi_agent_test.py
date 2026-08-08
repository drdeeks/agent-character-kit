"""Real end-to-end test for deploy/ack_monitor.py's multi-agent rewrite
(2026-08-07, ported from ack_monitor.js's own multi-agent version).

Spawns a REAL daemon (multi-workspace, registry-backed) and the REAL
ack_monitor.py against a real 2-agent registry, writes distinct ack
statements to each agent's own log, and proves via the daemon's own
reuse-rejection that each ack landed on the correct agent's socket -- the
same guarantee proven for the Node monitor, now proven for the Python one
too so the Hermes-only companion path isn't left on the old
single-ack-log/single-socket behavior.
"""
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import time
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
DAEMON = REPO / "node" / "enforcer" / "agent_enforcer_daemon.js"
MONITOR = REPO / "deploy" / "ack_monitor.py"
EXAMPLE_HABITS = REPO / "python" / "example_workspace" / ".agent" / "habits"


def _rpc(sock_path: str, method: str, params: dict, timeout: float = 5.0):
    s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    s.settimeout(timeout)
    s.connect(sock_path)
    s.sendall((json.dumps({"method": method, "params": params}) + "\n").encode())
    data = b""
    while b"\n" not in data:
        chunk = s.recv(4096)
        if not chunk:
            break
        data += chunk
    s.close()
    return json.loads(data.decode().strip())


def _seed_habits(ws: Path):
    habits_dir = ws / ".agent" / "habits"
    habits_dir.mkdir(parents=True, exist_ok=True)
    if EXAMPLE_HABITS.is_dir():
        for f in EXAMPLE_HABITS.glob("*.yaml"):
            shutil.copyfile(f, habits_dir / f.name)


def _wait_for(path: Path, timeout: float = 10.0):
    start = time.time()
    while not path.exists() and time.time() - start < timeout:
        time.sleep(0.15)
    return path.exists()


def test_ack_monitor_py_tracks_two_agents_independently_no_cross_contamination():
    root = Path(tempfile.mkdtemp(prefix="ack-py-monitor-multi-"))
    ws_a = root / "agents" / "agent-a"
    ws_b = root / "agents" / "agent-b"
    _seed_habits(ws_a)
    _seed_habits(ws_b)
    registry = root / "workspaces.json"
    registry.write_text(json.dumps([str(ws_a), str(ws_b)]))

    env = {**os.environ, "ACK_WORKSPACES_REGISTRY": str(registry), "AGENT_WORKSPACE": str(ws_a)}
    daemon_proc = subprocess.Popen(
        ["node", str(DAEMON)], env=env,
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        start_new_session=True,
    )
    monitor_proc = subprocess.Popen(
        [sys.executable, str(MONITOR)], env=env,
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        start_new_session=True,
    )
    try:
        sock_a = ws_a / ".agent" / "agent-a.sock"
        sock_b = ws_b / ".agent" / "agent-b.sock"
        assert _wait_for(sock_a), "agent-a's own socket should exist"
        assert _wait_for(sock_b), "agent-b's own socket should exist"
        time.sleep(0.8)

        ack_log_a = ws_a / ".agent" / "ack.jsonl"
        ack_log_b = ws_b / ".agent" / "ack.jsonl"
        with ack_log_a.open("a") as fh:
            fh.write(json.dumps({
                "session_id": "sess-a",
                "statement": "Habit: no_credential_leak because this test writes agent-a's ack only to agent-a's own log file",
            }) + "\n")
        with ack_log_b.open("a") as fh:
            fh.write(json.dumps({
                "session_id": "sess-b",
                "statement": "Habit: complete_thoroughly because this test writes agent-b's ack only to agent-b's own log file",
            }) + "\n")

        time.sleep(2.5)  # let the monitor's 1s poll loop pick both up

        reuse_a = _rpc(str(sock_a), "submit_ack", {
            "session_id": "sess-a",
            "statement": "Habit: no_credential_leak because this test writes agent-a's ack only to agent-a's own log file",
        })
        assert reuse_a["ok"] is False, "agent-a's socket must already have credited this exact habit"

        reuse_b = _rpc(str(sock_b), "submit_ack", {
            "session_id": "sess-b",
            "statement": "Habit: complete_thoroughly because this test writes agent-b's ack only to agent-b's own log file",
        })
        assert reuse_b["ok"] is False, "agent-b's socket must already have credited this exact habit"

        cross_check = _rpc(str(sock_b), "submit_ack", {
            "session_id": "sess-b-2",
            "statement": "Habit: no_credential_leak because this test only added this exact statement to agent-a's log, confirming it never reached agent-b's socket",
        })
        assert cross_check["ok"] is True, "agent-a's ack must never have reached agent-b's socket"
    finally:
        for proc in (daemon_proc, monitor_proc):
            try:
                os.killpg(os.getpgid(proc.pid), 9)
            except Exception:
                pass
            try:
                proc.kill()
            except Exception:
                pass
        shutil.rmtree(root, ignore_errors=True)
