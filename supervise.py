#!/usr/bin/env python3
"""
Agent Identity Kit — cross-platform supervisor.

Runs the enforcement daemon as a supervised child and restarts it on death
(3s backoff, matching the systemd RestartSec). This is the platform-agnostic
"watchdog" so the SAME daemon binary is self-healing on Linux, macOS, Windows,
container, host, or USB free-state — no systemd required.

Usage:
    python3 supervise.py                 # foreground, restarts on death
    python3 supervise.py --once          # run once, no restart (for systemd/launchd)
    ENFORCER_SOCKET=tcp://127.0.0.1:8753 python3 supervise.py   # Windows/TCP

The supervisor is the ONLY thing allowed to own the daemon's lifecycle. The
agent (non-root) cannot kill the daemon because it is a separate process tree;
on POSIX you can also run this as root for true system-ownership.
"""
from __future__ import annotations
import os
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
DAEMON = os.path.join(HERE, "node", "enforcer", "agent_enforcer_daemon.js")
NODE = os.environ.get("AIK_NODE", "node")
RESTART_SEC = float(os.environ.get("AIK_RESTART_SEC", "3"))


def main() -> int:
    once = "--once" in sys.argv
    if not os.path.exists(DAEMON):
        print(f"[supervise] daemon not found at {DAEMON}", file=sys.stderr)
        return 1

    print(f"[supervise] starting AIK enforcer (socket={os.environ.get('ENFORCER_SOCKET', '/run/agent-enforcer/main.sock')})")
    while True:
        proc = subprocess.Popen([NODE, DAEMON], env=os.environ)
        try:
            proc.wait()
        except KeyboardInterrupt:
            proc.terminate()
            try:
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                proc.kill()
            return 0
        if once:
            return proc.returncode or 0
        print(f"[supervise] daemon exited ({proc.returncode}); restarting in {RESTART_SEC}s", file=sys.stderr)
        time.sleep(RESTART_SEC)


if __name__ == "__main__":
    sys.exit(main())
