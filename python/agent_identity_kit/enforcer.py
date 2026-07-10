"""
Enforcer client — RPC to the identity enforcer daemon over a Unix socket.

Mirrors the Node `src/enforcer/client.js`. The agent uses this to validate every
tool call. The daemon runs as a separate, tamper-proof process; this client only
talks to it. All paths self-resolve.
"""

from __future__ import annotations
import json
import os
import socket
from pathlib import Path

from ._yaml import load_yaml


def _socket_path():
    # MUST match the daemon (agent_enforcer_daemon.js) default and the node
    # client: /run/agent-enforcer/main.sock. Override with ENFORCER_SOCKET
    # (e.g. tcp://127.0.0.1:8753 on Windows).
    # IMPORTANT: return the raw string, NOT pathlib.Path — Path("tcp://h:p")
    # collapses "//" to "/", breaking TCP detection. The EnforcerClient parses
    # the URL itself.
    if os.environ.get("ENFORCER_SOCKET"):
        return os.environ["ENFORCER_SOCKET"]
    return "/run/agent-enforcer/main.sock"


def _resolve_config():
    """Self-resolving paths, mirroring the Node daemon.

    Resolved fresh each call so env overrides (and tests) take effect and the
    package stays platform/path-agnostic.
    """
    home = Path(os.environ.get("HOME", "/root"))
    workspace = Path(os.environ.get("AGENT_WORKSPACE", home / ".openclaw" / "workspace"))
    socket_path = _socket_path()
    agent_dir = workspace / ".agent"
    constitution = agent_dir / "constitution.yaml"
    habits_dir = agent_dir / "habits"
    policy_file = Path(os.environ.get("ENFORCER_POLICY", agent_dir / "enforcer.yaml"))
    return {
        "home": home,
        "workspace": workspace,
        "socket": socket_path,
        "agent_dir": agent_dir,
        "constitution": constitution,
        "habits_dir": habits_dir,
        "policy_file": policy_file,
    }


class Enforcer:
    """Policy-evaluation engine — mirrors the Node `Enforcer` class in the daemon.

    This is the same enforcement logic the daemon runs, exposed for in-process use
    (tests, or Python-first setups). The daemon wraps this behind an RPC socket;
    `EnforcerClient` is the agent-side client that talks to that socket.
    """

    def __init__(self):
        self.cfg = _resolve_config()
        self.constitution = load_yaml(self.cfg["constitution"])
        self.habits = self._load_habits()
        self.policy = load_yaml(self.cfg["policy_file"])
        self.identity_hash = self._hash({
            "c": self.constitution, "h": self.habits, "p": self.policy,
        })
        self.started_at = self._now()
        self.last_heartbeat = self._now()

    def _now(self):
        from datetime import datetime, timezone
        return datetime.now(timezone.utc).isoformat()

    def _load_habits(self):
        habits = []
        try:
            for f in sorted(self.cfg["habits_dir"].iterdir()):
                if f.suffix in (".yaml", ".yml"):
                    habits.append(load_yaml(f))
        except (FileNotFoundError, NotADirectoryError):
            pass
        return habits

    def _hash(self, obj):
        s = json.dumps(obj, default=str, sort_keys=True)
        h = 0
        for ch in s:
            h = (h * 31 + ord(ch)) & 0xFFFFFFFF
        return format(h, "x")

    def reload(self):
        self.constitution = load_yaml(self.cfg["constitution"])
        self.habits = self._load_habits()
        self.policy = load_yaml(self.cfg["policy_file"])
        self.identity_hash = self._hash({
            "c": self.constitution, "h": self.habits, "p": self.policy,
        })

    # ─── Core enforcement ──────────────────────────────────────────────────

    def execute_tool(self, tool, params=None):
        params = params or {}
        command = self._extract_command(tool, params)

        # 1. Explicit deny patterns (constitution hard_constraints + policy.deny)
        deny_patterns = list(self.constitution.get("hard_constraints", [])) + \
            list(self.policy.get("deny", []))
        for p in deny_patterns:
            if self._matches(p, tool, command):
                result = {
                    "denied": True,
                    "reason": f"Violates hard constraint: {p}",
                    "reflection": "This isn't a rule to work around — it's who we are. "
                    "A constraint exists because the cost of the failure is worse than the convenience.",
                }
                self._audit(tool, command, result)
                return result

        # 2. Allow-list policy: if policy.allow is set, ONLY listed tools/commands pass.
        allow = self.policy.get("allow")
        if isinstance(allow, list) and allow:
            ok = any(self._matches(p, tool, command, allow_mode=True) for p in allow)
            if not ok:
                result = {
                    "denied": True,
                    "reason": f"Tool not on allow-list: {command or tool}",
                    "reflection": "Unlisted tools are denied by default. Add it to enforcer.yaml allow-list "
                    "if it is genuinely needed — but raising the bar is the point.",
                }
                self._audit(tool, command, result)
                return result

        # 3. Habit checks (each habit may block) — internalized, not optional.
        for habit in self.habits:
            block = self._eval_habit(habit, tool, command)
            if block:
                result = {
                    "denied": True,
                    "reason": block,
                    "reflection": "A compiled habit blocked this. Habits are internalized, not optional.",
                }
                self._audit(tool, command, result)
                return result

        # 4. Allowed — but still recorded, so every action carries the identity trail.
        #    Re-assert the self-audit reminders (FOREVER-SYSTEM.md §6): character is
        #    exercised on EVERY action, not checked once.
        reminders = self._collect_reminders()
        result = {"denied": False}
        if reminders:
            result["reminders"] = reminders
        self._audit(tool, command, result)
        return result

    def audit_path(self):
        return self.cfg["agent_dir"] / "logs" / "enforcer-audit.jsonl"

    def _audit(self, tool, command, result):
        from pathlib import Path as _P
        try:
            log = self.audit_path()
            log.parent.mkdir(parents=True, exist_ok=True)
            entry = {
                "ts": self._now(),
                "identity_hash": self.identity_hash,
                "tool": tool,
                "command": (command or "")[:500],
                "decision": "deny" if result.get("denied") else "allow",
                "reason": result.get("reason") or None,
            }
            with log.open("a", encoding="utf-8") as f:
                f.write(json.dumps(entry) + "\n")
        except Exception:
            pass  # audit must never break enforcement

    def _extract_command(self, tool, params):
        if isinstance(params, str):
            return params
        if isinstance(params, dict):
            for key in ("command", "cmd", "code"):
                if isinstance(params.get(key), str):
                    return params[key]
        return str(tool or "")

    def _matches(self, pattern, tool, command, allow_mode=False):
        p = str(pattern or "").strip()
        if not p:
            return False
        hay = f"{tool} {command}".lower()

        if not allow_mode:
            return p.lower() in hay

        # Glob-ish for allow-list: "git *", "npm test", "ls"
        import re
        rx = re.compile(
            "^" + re.escape(p.lower()).replace(r"\*", ".*") + "$"
        )
        candidates = [
            str(tool).lower(),
            str(command).lower(),
            (str(command).lower().split()[0] if command else ""),
        ]
        return any(rx.match(c) for c in candidates)

    def _eval_habit(self, habit, tool, command):
        if not habit or not habit.get("enforcement"):
            return None
        level = habit["enforcement"].get("level")
        if level != "hard":
            return None  # reminder habits never block; handled in execute_tool
        checks = (habit.get("behavior", {}) or {}).get("steps", []) or []
        for step in checks:
            check = step.get("check", "")
            if check == "executable_and_present":
                bin_name = step.get("binary") or (step.get("name") or "").replace("validate_", "")
                if bin_name and not self._has_binary(bin_name):
                    return f"Required tool missing: {bin_name}"
            if check == "block_command_pattern" and step.get("pattern"):
                if self._matches(step["pattern"], tool, command):
                    return f"Blocked by habit {habit.get('name')}: {step['pattern']}"
            if check == "block_secret_leak":
                if self._leaks_secret(tool, command, step):
                    return (
                        f"Blocked by habit {habit.get('name')}: probable credential "
                        f"leak detected in tool call. A guard that fails open on "
                        f"secrets is no guard."
                    )
        return None

    def _leaks_secret(self, tool, command, step) -> bool:
        """Fail-closed secret scan. Returns True if the call carries what looks
        like a real credential value (not merely mentioning the word)."""
        hay = f"{tool} {command}"
        patterns = step.get("patterns") or []
        for pat in patterns:
            idx = hay.find(pat)
            if idx == -1:
                continue
            # Known secret prefixes (sk-, AKIA, xoxb-, ghp_, ...) are themselves
            # values — their mere presence is the leak. Fail closed on these.
            if pat in ("sk-", "sk_", "AIza", "xoxb-", "xoxp-", "AKIA",
                       "ghp_", "gho_", "glpat-", "-----BEGIN PRIVATE KEY-----"):
                return True
            # key= / key: forms — block if a value follows the assignment.
            # e.g. "api_key=sk-..." or "token: abc123" or trailing "secret="
            tail = hay[idx + len(pat):]
            if pat in ("api_key=", "apikey=", "password=", "secret=",
                       "token=", "client_secret="):
                # value present if tail is non-empty and not just whitespace/punct
                if tail.strip() and not tail.lstrip().startswith(("'", '"', "#")):
                    return True
        return False

    def _collect_reminders(self):
        """Gather reminder-level habit questions to re-assert on every allowed
        action (FOREVER-SYSTEM.md §6 — character continuously reminded)."""
        out = []
        for habit in self.habits:
            if habit.get("enforcement", {}).get("level") == "reminder":
                rem = (habit.get("behavior", {}) or {}).get("reminder") or []
                out.extend(rem)
        return out

    def _has_binary(self, name):
        import shutil
        return shutil.which(name) is not None

    def validate_workspace(self):
        violations = []
        if not self.cfg["constitution"].exists():
            violations.append("constitution.yaml missing")
        if not self.cfg["policy_file"].exists():
            violations.append("enforcer.yaml missing (using open policy)")
        return violations

    def heartbeat(self):
        self.last_heartbeat = self._now()
        return {
            "status": "ok",
            "identity_hash": self.identity_hash,
            "violations": self.validate_workspace(),
        }


class EnforcerClient:
    """Thin RPC client to the enforcer daemon.

    Supports both transports, matching the daemon:
      - "tcp://host:port"  -> TCP (Windows / cross-host)
      - "/path/to/main.sock" -> Unix domain socket (POSIX)
    Fail-closed: any failure to reach/parse the daemon -> {"error": ...},
    which the callers turn into a BLOCK.
    """

    def __init__(self, socket_path=None):
        raw = str(socket_path or _socket_path())
        self.raw = raw
        self.is_tcp = raw.startswith("tcp://")
        if self.is_tcp:
            from urllib.parse import urlparse
            u = urlparse(raw)
            self.host = u.hostname or "127.0.0.1"
            self.port = int(u.port or 8753)
        else:
            self.unix_path = raw

    async def call(self, method, params=None):
        try:
            if self.is_tcp:
                with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
                    s.settimeout(5)
                    s.connect((self.host, self.port))
                    s.sendall((json.dumps({"method": method, "params": params or {}}) + "\n").encode())
                    buf = b""
                    while b"\n" not in buf:
                        chunk = s.recv(65536)
                        if not chunk:
                            break
                        buf += chunk
            else:
                if not os.path.exists(self.unix_path):
                    return {"error": "enforcer socket not found"}
                with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as s:
                    s.settimeout(5)
                    s.connect(self.unix_path)
                    s.sendall((json.dumps({"method": method, "params": params or {}}) + "\n").encode())
                    buf = b""
                    while b"\n" not in buf:
                        chunk = s.recv(65536)
                        if not chunk:
                            break
                        buf += chunk
            line = buf.split(b"\n", 1)[0].decode()
            resp = json.loads(line)
            if not isinstance(resp, dict):
                return {"error": "malformed enforcer response"}
            return resp
        except Exception:
            # Any failure to reach/parse the daemon is treated as unreachable.
            return {"error": "enforcer socket unreachable"}

    async def validate_tool(self, tool, params, identity_hash="unknown"):
        # Flat contract, mirroring the node EnforcerClient fix: the daemon's
        # executeTool(tool, params) reads params.command. Do NOT nest params
        # inside params — that made _extractCommand resolve the command to the
        # tool name, so every call passed (deny never fired).
        command = ""
        if isinstance(params, dict):
            for k in ("command", "cmd", "code"):
                if isinstance(params.get(k), str):
                    command = params[k]
                    break
        resp = await self.call("execute_tool", {"tool": tool, "command": command,
                                                "identity_hash": identity_hash})
        if not isinstance(resp, dict) or resp.get("error"):
            # Fail-closed: if the enforcer can't be reached/parsed, block.
            return {"allowed": False, "error": True,
                    "reason": "Enforcer unavailable: identity cannot be verified, "
                              "so the action is blocked. A guard that fails open is no guard."}
        if resp.get("denied"):
            return {"allowed": False, "reason": resp.get("reason", "Denied by enforcer"),
                    "reflection": resp.get("reflection", "")}
        return {"allowed": True}

    async def heartbeat(self, status="ok"):
        return await self.call("heartbeat", {"status": status})

    async def validate_workspace(self):
        return await self.call("validate_workspace")

    async def get_habit(self, name):
        """On-demand proof layer: pull a habit's full assert/evidence/logic."""
        return await self.call("get_habit", {"name": name})
