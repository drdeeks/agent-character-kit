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
_ACK_HOME = os.path.join(_HOME, ".agent-character-kit")

PIDFILE = os.environ.get("ACK_MONITOR_PID", "/var/lib/agent-character-kit/ack-monitor.pid")
WATCHDOG_PID = os.environ.get("ACK_WATCHDOG_PID", "/var/lib/agent-character-kit/ack-watchdog.pid")
MONITOR_BIN = os.environ.get("ACK_MONITOR_BIN", "/usr/local/lib/agent-character-kit/ack_monitor.py")
MONITOR_UNIT = "agent-character-monitor.service"
ENFORCER_UNIT = "agent-enforcer.service"
INTERVAL = int(os.environ.get("ACK_WATCHDOG_INTERVAL", "5"))

logging.basicConfig(level=logging.INFO, format="%(asctime)s [ack-watchdog] %(message)s")
log = logging.getLogger("ack-watchdog")


def process_alive(pattern: str, unit_name: str = None, pidfile: str | None = None) -> bool:
    """Check if a process matching pattern is alive. Try pgrep first, fall back to pidfile."""
    try:
        out = subprocess.run(
            ["pgrep", "-af", pattern],
            capture_output=True, text=True, timeout=5,
        )
        for line in out.stdout.splitlines():
            if pattern in line and "grep" not in line:
                return True
        return False
    except Exception:
        pass
    # Fallback: pidfile + kill(0)
    if pidfile:
        p = Path(pidfile)
        if p.exists():
            try:
                pid = int(p.read_text().strip())
                os.kill(pid, 0)
                return True
            except Exception:
                pass
    return False


def monitor_alive() -> bool:
    return process_alive("ack_monitor.py", MONITOR_UNIT, PIDFILE)


def enforcer_alive() -> bool:
    return process_alive("agent_enforcer_daemon.js", ENFORCER_UNIT, None)


def is_root() -> bool:
    """systemctl restart of a root-owned unit only makes sense (and only
    succeeds) when this watchdog itself is root -- which is only true for a
    real root-mode deploy. In a user-mode install the unit was never
    installed, so calling systemctl here can never succeed; it would just
    fail (or worse, prompt for a password via polkit) on every interval
    forever."""
    return os.geteuid() == 0


def _systemctl_restart(unit: str) -> bool:
    """Attempt a real systemd restart. Returns True only on a genuine
    success (returncode 0) -- check=False means subprocess.run does NOT
    raise on a nonzero exit, so the exit code must be checked explicitly or
    a failed/denied restart looks identical to a successful one and the
    caller wrongly skips its fallback."""
    try:
        r = subprocess.run(["systemctl", "restart", unit], check=False, timeout=10)
        return r.returncode == 0
    except Exception as exc:
        log.error("systemctl restart %s failed: %s", unit, exc)
        return False


def revive_monitor() -> None:
    log.warning("monitor not alive -> restarting")
    if is_root() and _systemctl_restart(MONITOR_UNIT):
        return
    try:
        subprocess.Popen(
            ["/usr/bin/python3", MONITOR_BIN],
            env=dict(os.environ),
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
    except Exception as exc:
        log.error("direct monitor launch failed: %s", exc)


def revive_enforcer() -> None:
    if not is_root():
        # User-mode has no enforcer supervisor by design (see AGENTS.md
        # Fail-closed guarantees) -- warn once per detection instead of
        # retrying a systemctl call against a unit that was never installed.
        log.warning(
            "enforcer not alive, but this is a user-mode install (no root) -- "
            "skipping systemctl restart of %s, it was never installed here. "
            "Re-run 'ack install' to relaunch the daemon directly, or use "
            "root-mode for automatic revival.", ENFORCER_UNIT,
        )
        return
    log.warning("enforcer not alive -> restarting")
    if not _systemctl_restart(ENFORCER_UNIT):
        log.error("systemctl restart of %s failed", ENFORCER_UNIT)
    # No direct fallback for enforcer (it's a Node process managed by systemd)


def main() -> None:
    try:
        Path(WATCHDOG_PID).write_text(str(os.getpid()))
    except Exception as exc:
        log.warning("could not write pidfile %s: %s", WATCHDOG_PID, exc)
    log.info("watchdog started (interval=%ss) — monitoring monitor + enforcer", INTERVAL)
    while True:
        if not monitor_alive():
            revive_monitor()
        if not enforcer_alive():
            revive_enforcer()
        time.sleep(INTERVAL)


if __name__ == "__main__":
    main()
