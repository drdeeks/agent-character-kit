#!/usr/bin/env python3
"""ACK acknowledgment monitor (root-owned, separate process).

Watches the external ack log that the companion writes. For each entry it
validates the `Habit: <name> <resonates true | why: | because | …> <reason>`
statement and credits it to the DAEMON's hold ledger via the submit_ack RPC.

Why a separate root-owned process: the hold decision lives in the daemon, but
the daemon only learns about acknowledgments because something feeds it. That
"something" must not be killable by the agent user. Running as root, separate
from the agent, the monitor is exactly that independent verifier. The agent
cannot disable it without privilege escalation.

Self-healing: a companion watchdog (ack_watchdog.py) revives this process if
it dies.
"""

import json
import os
import socket
import time
import logging
from pathlib import Path

def _default_sock():
    # First priority: explicit ENFORCER_SOCKET (set by systemd)
    sock = os.environ.get("ENFORCER_SOCKET")
    if sock:
        return sock
    # Second: AGENT_WORKSPACE-based
    ws = os.environ.get("AGENT_WORKSPACE")
    if ws:
        return os.path.join(ws, ".agent", "enforcer.sock")
    # Fallback: legacy path
    return os.path.join(os.environ.get("HOME", "/root"), ".agent-character-kit",
                         "workspace", ".agent", "enforcer.sock")

SOCK = _default_sock()
ACK_LOG = os.environ.get("ACK_ACK_LOG", "/tmp/agent-character-kit-ack.jsonl")
PIDFILE = os.environ.get("ACK_MONITOR_PID", "/var/lib/agent-character-kit/ack-monitor.pid")
STATE = os.environ.get("ACK_MONITOR_STATE", "/var/lib/agent-character-kit/ack-monitor.pos")

logging.basicConfig(level=logging.INFO, format="%(asctime)s [ack-monitor] %(message)s")
log = logging.getLogger("ack-monitor")


def _rpc(method: str, params: dict):
    """Call a daemon RPC over the unix socket. Returns dict or None on failure."""
    try:
        s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        s.settimeout(5)
        s.connect(SOCK)
        s.sendall((json.dumps({"method": method, "params": params}) + "\n").encode())
        data = b""
        while b"\n" not in data:
            chunk = s.recv(4096)
            if not chunk:
                break
            data += chunk
        s.close()
        return json.loads(data.decode().strip())
    except Exception as exc:  # daemon down / socket gone -> fail loud, don't credit
        log.error("daemon rpc %s failed: %s", method, exc)
        return None


def _read_pos():
    try:
        p = Path(STATE)
        if p.exists():
            ino, off = p.read_text().split()
            return int(ino), int(off)
    except Exception:
        pass
    return None, 0


def _write_pos(ino: int, off: int):
    try:
        Path(STATE).write_text(f"{ino} {off}")
    except Exception:
        pass


def _tail() -> None:
    """Process new lines appended to the ack log since last run."""
    path = Path(ACK_LOG)
    last_ino, off = _read_pos()
    if not path.exists():
        return
    try:
        st = path.stat()
    except Exception:
        return
    # Log rotated (inode changed) -> re-read from start.
    if last_ino != st.st_ino:
        off = 0
    try:
        with path.open("r") as fh:
            fh.seek(off)
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                try:
                    entry = json.loads(line)
                except Exception:
                    continue
                statement = entry.get("statement")
                session = entry.get("session_id", "default")
                if not statement:
                    continue
                res = _rpc("submit_ack", {"session_id": session, "statement": statement})
                if res and res.get("ok"):
                    log.info("credited ack for %s (acked=%s)", session, res.get("acked"))
                else:
                    log.warning("ack rejected for %s: %s", session, (res or {}).get("error"))
            off = fh.tell()
    except Exception as exc:
        log.error("tail error: %s", exc)
        return
    _write_pos(st.st_ino, off)


def main() -> None:
    try:
        Path(PIDFILE).write_text(str(os.getpid()))
    except Exception as exc:
        log.warning("could not write pidfile %s: %s", PIDFILE, exc)
    log.info("ack monitor started (sock=%s log=%s)", SOCK, ACK_LOG)
    while True:
        try:
            _tail()
        except Exception as exc:
            log.error("unexpected: %s", exc)
        time.sleep(1)


if __name__ == "__main__":
    main()
