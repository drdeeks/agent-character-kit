#!/usr/bin/env python3
"""ACK acknowledgment monitor (root-owned, separate process).

Watches the external ack log that the companion writes. For each entry it
relays the `Habit: <name> <why: | because | matters because | applies
because> <real work attribution>` statement to the DAEMON's submit_ack RPC,
which is the only place that actually validates it (connector shape +
work-attribution content) and credits the hold ledger.

Why a separate root-owned process: the hold decision lives in the daemon, but
the daemon only learns about acknowledgments because something feeds it. That
"something" must not be killable by the agent user. Running as root, separate
from the agent, the monitor is exactly that independent verifier. The agent
cannot disable it without privilege escalation.

One enforcer holds every agent (agent_enforcer_daemon.js's registry-backed
multi-workspace mode); this monitor mirrors that -- ONE process, but it
tracks every registered agent individually, tailing EACH agent's own ack log
and crediting EACH agent's own socket. Ported from ack_monitor.js's
multi-agent rewrite (2026-08-07) so the Hermes-only companion path isn't
left behind on the old single-ack-log/single-socket behavior.

Self-healing: a companion watchdog (ack_watchdog.py) revives this process if
it dies.
"""

import json
import os
import socket
import time
import logging
from pathlib import Path

logging.basicConfig(level=logging.INFO, format="%(asctime)s [ack-monitor] %(message)s")
log = logging.getLogger("ack-monitor")

PIDFILE = os.environ.get("ACK_MONITOR_PID", "/var/lib/agent-character-kit/ack-monitor.pid")


def _resolve_registry_path():
    """Same priority as agent_enforcer_daemon.js's resolveWorkspaces() and
    ack_monitor.js's resolveRegistryPath() -- all three MUST agree on which
    file is "the" registry, or this monitor could credit a socket the
    daemon isn't actually listening on."""
    override = os.environ.get("ACK_WORKSPACES_REGISTRY")
    if override:
        return override
    fixed = "/var/lib/agent-character-kit/workspaces.json"
    if os.path.exists(fixed):
        return fixed
    home_based = os.path.join(os.environ.get("HOME", "/root"), ".agent-character-kit", "workspaces.json")
    return home_based if os.path.exists(home_based) else None


def _legacy_sock():
    sock = os.environ.get("ENFORCER_SOCKET")
    if sock:
        return sock
    ws = os.environ.get("AGENT_WORKSPACE")
    if ws:
        return os.path.join(ws, ".agent", "enforcer.sock")
    return os.path.join(os.environ.get("HOME", "/root"), ".agent-character-kit",
                         "workspace", ".agent", "enforcer.sock")


def _resolve_agents():
    """Returns the list of agents to tail: registry-backed when one exists
    (root/service-user mode, or any deploy that populated it), otherwise
    exactly one "default" agent using the original env-var-based behavior --
    a plain single-workspace user-mode setup (which never creates a
    registry) is completely unaffected by any of this."""
    registry_path = _resolve_registry_path()
    if registry_path:
        try:
            with open(registry_path, "r") as fh:
                workspaces = json.load(fh)
            if isinstance(workspaces, list) and workspaces:
                agents = []
                for ws in workspaces:
                    if not isinstance(ws, str) or not ws.strip():
                        continue
                    resolved = os.path.abspath(ws.strip())
                    name = os.path.basename(resolved)
                    agents.append({
                        "name": name,
                        "ws": resolved,
                        "sock": os.path.join(resolved, ".agent", f"{name}.sock"),
                        "ack_log": os.path.join(resolved, ".agent", "ack.jsonl"),
                        "state_path": os.path.join(resolved, ".agent", f".{name}-monitor.pos"),
                    })
                if agents:
                    return agents
        except Exception:
            pass  # malformed registry -- fall through to legacy single-agent mode

    return [{
        "name": "default",
        "ws": os.environ.get("AGENT_WORKSPACE"),
        "sock": _legacy_sock(),
        "ack_log": os.environ.get("ACK_ACK_LOG", "/tmp/agent-character-kit-ack.jsonl"),
        "state_path": os.environ.get("ACK_MONITOR_STATE", "/var/lib/agent-character-kit/ack-monitor.pos"),
    }]


def _rpc(sock_path: str, method: str, params: dict):
    """Call a daemon RPC over the unix socket. Returns dict or None on failure."""
    try:
        s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        s.settimeout(5)
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
    except Exception as exc:  # daemon down / socket gone -> fail loud, don't credit
        log.error("daemon rpc %s failed: %s", method, exc)
        return None


def _read_pos(state_path: str):
    try:
        p = Path(state_path)
        if p.exists():
            ino, off = p.read_text().split()
            return int(ino), int(off)
    except Exception:
        pass
    return None, 0


def _write_pos(state_path: str, ino: int, off: int):
    try:
        Path(state_path).parent.mkdir(parents=True, exist_ok=True)
        Path(state_path).write_text(f"{ino} {off}")
    except Exception:
        pass


def _tail_agent(agent: dict) -> None:
    """Tails ONE agent's own ack log and credits ONE agent's own socket.
    Never touches another agent's state -- each agent's tail position, log,
    and socket are entirely independent, so one agent's acks can never be
    misattributed to another's hold ledger."""
    ack_log = agent["ack_log"]
    state_path = agent["state_path"]
    path = Path(ack_log)
    last_ino, off = _read_pos(state_path)
    if not path.exists():
        return
    try:
        st = path.stat()
    except Exception:
        return
    if last_ino != st.st_ino:
        off = 0  # rotated -> re-read from start
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
                res = _rpc(agent["sock"], "submit_ack", {"session_id": session, "statement": statement})
                if res and res.get("ok"):
                    log.info("[%s] credited ack for %s (acked=%s)", agent["name"], session, res.get("acked"))
                else:
                    log.warning("[%s] ack rejected for %s: %s", agent["name"], session, (res or {}).get("error"))
            off = fh.tell()
    except Exception as exc:
        log.error("[%s] tail error: %s", agent["name"], exc)
        return
    _write_pos(state_path, st.st_ino, off)


def main() -> None:
    try:
        Path(PIDFILE).write_text(str(os.getpid()))
    except Exception as exc:
        log.warning("could not write pidfile %s: %s", PIDFILE, exc)
    startup_agents = _resolve_agents()
    log.info("ack monitor started, tracking %d agent(s): %s", len(startup_agents), ", ".join(a["name"] for a in startup_agents))
    while True:
        # Re-resolved every tick, not just at startup -- a new agent
        # registered after this monitor started gets picked up without
        # needing the monitor itself restarted.
        for agent in _resolve_agents():
            try:
                _tail_agent(agent)
            except Exception as exc:
                log.error("[%s] unexpected: %s", agent["name"], exc)
        time.sleep(1)


if __name__ == "__main__":
    main()
