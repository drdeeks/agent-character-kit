#!/usr/bin/env python3
"""ACK monitor watchdog (root-owned, separate process).

Revives the acknowledgment monitor (ack_monitor.py) if it dies. This is the
self-healing layer: the monitor itself must not be a single point of failure,
so a second root-owned process watches it and restarts it.

Revival order: prefer `systemctl restart agent-character-monitor.service`
(idempotent, re-reads the unit). Fall back to a direct launch if systemctl is
unavailable (e.g. container without systemd).
"""

import os
import time
import logging
import subprocess
from pathlib import Path

_HOME = os.environ.get("HOME", "/root")

# Use system paths for root-owned services
PIDFILE = os.environ.get("ACK_MONITOR_PID", "/var/lib/agent-character-kit/ack-monitor.pid")
WATCHDOG_PID = os.environ.get("ACK_WATCHDOG_PID", "/var/lib/agent-character-kit/ack-watchdog.pid")
MONITOR_BIN = os.environ.get("ACK_MONITOR_BIN", "/usr/local/lib/agent-character-kit/ack_monitor.py")
MONITOR_UNIT = "agent-character-monitor.service"
INTERVAL = int(os.environ.get("ACK_WATCHDOG_INTERVAL", "5"))

logging.basicConfig(level=logging.INFO, format="%(asctime)s [ack-watchdog] %(message)s")
log = logging.getLogger("ack-watchdog")


def monitor_alive() -> bool:
    """Prefer a process-list check (robust, no pidfile race). Fall back to the
    pidfile only if pgrep is unavailable. We match the monitor script name so a
    stale pidfile can never mask a live process (or vice-versa)."""
    try:
        out = subprocess.run(
            ["pgrep", "-af", "ack_monitor.py"],
            capture_output=True, text=True, timeout=5,
        )
        # Any line that is NOT the watchdog's own grep counts as alive.
        for line in out.stdout.splitlines():
            if "ack_monitor.py" in line and "grep" not in line:
                return True
        return False
    except Exception:
        pass
    # Fallback: pidfile + kill(0)
    p = Path(PIDFILE)
    if not p.exists():
        return False
    try:
        pid = int(p.read_text().strip())
    except Exception:
        return False
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False


def revive() -> None:
    log.warning("monitor not alive -> restarting")
    try:
        subprocess.run(["systemctl", "restart", MONITOR_UNIT], check=False)
        return
    except Exception as exc:
        log.error("systemctl restart failed: %s", exc)
    # Fallback: direct launch (inherits this process's env, which carries the
    # ACK_MONITOR_PID / ACK_ACK_LOG / ACK_ENFORCER_SOCKET overrides).
    try:
        subprocess.Popen(
            ["/usr/bin/python3", MONITOR_BIN],
            env=dict(os.environ),
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
    except Exception as exc:
        log.error("direct launch failed: %s", exc)


def main() -> None:
    try:
        Path(WATCHDOG_PID).write_text(str(os.getpid()))
    except Exception as exc:
        log.warning("could not write pidfile %s: %s", WATCHDOG_PID, exc)
    log.info("watchdog started (interval=%ss)", INTERVAL)
    while True:
        if not monitor_alive():
            revive()
        time.sleep(INTERVAL)


if __name__ == "__main__":
    main()
