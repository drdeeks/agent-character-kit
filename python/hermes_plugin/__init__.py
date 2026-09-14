"""
Agent Character Kit — Hermes companion plugin (real, registered, fail-closed).

Bridges any harness's generic ``pre_tool_call`` + ``pre_llm_call`` hooks to the
Agent Character Kit ENFORCER DAEMON over its RPC socket. The daemon is the
SINGLE SOURCE OF TRUTH for enforcement. This plugin is one of several thin
clients (Hermes is the harness it is packaged for); the kit itself is
harness-agnostic.

Fail-closed: if the daemon socket is unreachable or any error occurs, the
tool call is BLOCKED. A guard that fails open is no guard.

Architecture (3 layers, all root-owned where they must be):
  1. DAEMON   — owns the hold state + acknowledgment ledger; decides allow/hold.
  2. PLUGIN   — thin client: asks daemon ``tool_tick``, blocks on hold; records
                any ``Habit: <name> <why: | because | matters because |
                applies because> <real work attribution>`` the agent states
                into the external ACK LOG (does NOT self-credit).
  3. MONITOR  — root-owned, separate process: reads the ACK LOG, validates each
                statement, and credits the daemon via ``submit_ack``. The agent
                cannot forge acknowledgments (it can only append to the log;
                only the independent monitor can credit). A WATCHDOG revives the
                monitor if it dies (self-healing).
"""

from __future__ import annotations

import asyncio
import concurrent.futures
import json
import logging
import os
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

logger = logging.getLogger(__name__)

# Kept in sync with node/src/version.js / /VERSION at repo root -- bump all
# together. Currently unused within this module (no RPC or log line reads
# it) but kept for parity with the Node side's ACK_VERSION. Was stuck at
# 1.2.1 while the other 4 "bump together" files had already moved to 1.5.0
# -- corrected 2026-08-12.
ACK_VERSION = "1.9.0"

# Optional env escape hatch: set ACK_DISABLE=1 to turn the plugin into a
# no-op (never use in production — it defeats the purpose).
_DISABLE = os.environ.get("ACK_DISABLE") == "1"


def _default_workspace() -> str:
    """Same resolution shape used throughout this module and the Node side's
    resolveWorkspaces()/legacySocket(): explicit AGENT_WORKSPACE, else the
    plain user-mode default under HOME."""
    return os.environ.get("AGENT_WORKSPACE") or os.path.join(
        os.environ.get("HOME", "/root"), ".agent-character-kit", "workspace"
    )


def _default_ack_log() -> str:
    """<workspace>/.agent/ack.jsonl -- matches the Node daemon's own
    per-workspace logs convention. Previously defaulted to
    /tmp/agent-character-kit-ack.jsonl in 3 places in this file, not
    guaranteed persistent (tmpfs on many distros); this is meant to be an
    always-retrievable record, not scratch state."""
    return os.path.join(_default_workspace(), ".agent", "ack.jsonl")


def _default_inject_log() -> str:
    """Same shape as _default_ack_log() above, for the habit-prompt
    injection log."""
    return os.path.join(_default_workspace(), ".agent", "ack-inject-log.jsonl")


def _get_client():
    """Construct the ACK EnforcerClient (thin RPC client to the daemon)."""
    from agent_character_kit.enforcer import EnforcerClient
    return EnforcerClient()


def _call_validate(client, tool_name, args, ctx_id):
    """Run the async validate_tool regardless of ambient event loop.

    pre_tool_call is a SYNC function. If Hermes already has a running loop
    we cannot asyncio.run() (RuntimeError). Use a worker thread with its own
    loop instead. If no loop is running, asyncio.run() is fine.
    """
    coro = client.validate_tool(tool_name, args, ctx_id)
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        loop = None
    if loop is not None and loop.is_running():
        with concurrent.futures.ThreadPoolExecutor(max_workers=1) as ex:
            return ex.submit(lambda: asyncio.run(coro)).result(timeout=10)
    return asyncio.run(coro)


def _on_pre_tool_call(
    tool_name: str = "",
    args: Optional[Dict[str, Any]] = None,
    task_id: str = "",
    session_id: str = "",
    tool_call_id: str = "",
    **_: Any,
) -> Optional[Dict[str, Any]]:
    """pre_tool_call gate -> daemon, then periodic acknowledgment HOLD.

    The hold decision lives in the root-owned DAEMON, not here. The plugin only
    asks ``tool_tick`` and obeys. The agent cannot reset or bypass the hold
    because the state is in a process it cannot kill or modify.
    """
    if _DISABLE:
        return None

    if not isinstance(args, dict):
        args = {}

    ctx_id = session_id or task_id or "unknown"

    try:
        client = _get_client()
        result = _call_validate(client, tool_name, args, ctx_id)
    except Exception as exc:
        # Fail-closed: daemon unreachable or client error -> block.
        logger.error("[agent-character-kit] enforcement error (failing closed): %s", exc)
        return {
            "action": "block",
            "message": (
                "Agent Character Kit enforcer unavailable — action blocked. "
                "Character cannot be verified, so the action is denied. "
                "A guard that fails open is no guard."
            ),
        }

    if not result.get("allowed"):
        reason = result.get("reason") or "Denied by Agent Character Kit enforcer."
        reflection = result.get("reflection") or ""
        msg = f"[character] {reason}"
        if reflection:
            msg += f"\n\n{reflection}"
        return {"action": "block", "message": msg}

    # Allowed by daemon. Now apply the daemon-owned HOLD (state lives in the
    # root-owned daemon, NOT here — the agent cannot bypass it).
    try:
        file_path = args.get("file_path") or args.get("path")
        tick = _daemon_rpc("tool_tick", {"session_id": ctx_id, "tool": tool_name, "file_path": file_path})
        if tick and tick.get("hold"):
            # The daemon deliberately does NOT tell us habit names or the
            # ack format here — the agent must search/read .agent/habits/*.yaml
            # to find the habit matching whatever prompt it was last given
            # (via pre_llm_call injection) and answer with the real name.
            # Handing out names here would defeat that; keep this terse.
            msg = tick.get("reason", "acknowledge 2 habits.")
            logger.debug(
                "[agent-character-kit] HOLD active for %s — %s",
                ctx_id, msg,
            )
            return {"action": "block", "message": msg}
    except Exception as exc:
        logger.error("[agent-character-kit] hold check failed (failing closed): %s", exc)
        return {"action": "block", "message": "HOLD check unavailable — action blocked."}
    return None


def _walk_up_for_agent_dir(start_dir: str) -> Optional[str]:
    """Walk up from start_dir looking for .agent/enforcer.sock."""
    d = start_dir
    while True:
        sock = os.path.join(d, ".agent", "enforcer.sock")
        if os.path.exists(sock):
            return sock
        parent = os.path.dirname(d)
        if parent == d:  # at root
            break
        d = parent
    return None


def _daemon_rpc(method: str, params: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """Talk to the root-owned enforcer daemon over its socket (thin client).

    Mirrors EnforcerClient's transport: honors ENFORCER_SOCKET (tcp:// or unix
    path), defaults to the systemd unix socket. Fail-closed: any error -> None
    and the caller decides (pre_tool_call blocks; pre_llm_call ignores).
    """
    import socket as _sock

    # Workspace resolution:
    #   1. ENFORCER_SOCKET env var
    #   2. CWD-walk for project-local .agent/
    #   3. AGENT_WORKSPACE/.agent/enforcer.sock
    #   4. Harness-specific default (Claude: ~/.claude/.agent/)
    #   5. Global fallback
    raw = os.environ.get("ENFORCER_SOCKET")
    if not raw:
        cwd_sock = _walk_up_for_agent_dir(os.getcwd())
        if cwd_sock:
            raw = cwd_sock
        else:
            ws = os.environ.get("AGENT_WORKSPACE")
            if ws:
                raw = os.path.join(ws, ".agent", "enforcer.sock")
            else:
                home = os.environ.get("HOME", "/root")
                claude_sock = os.path.join(home, ".claude", ".agent", "enforcer.sock")
                if os.path.exists(claude_sock):
                    raw = claude_sock
                else:
                    raw = os.path.join(home, ".agent-character-kit", "workspace", ".agent", "enforcer.sock")
    payload = (json.dumps({"method": method, "params": params}) + "\n").encode()
    try:
        if raw.startswith("tcp://"):
            u = __import__("urllib.parse").urlparse(raw)
            s = _sock.create_connection((u.hostname or "127.0.0.1", int(u.port or 8753)), timeout=5)
        else:
            s = _sock.socket(_sock.AF_UNIX, _sock.SOCK_STREAM)
            s.settimeout(5)
            s.connect(raw)
        s.sendall(payload)
        data = b""
        s.settimeout(5)
        while b"\n" not in data:
            chunk = s.recv(4096)
            if not chunk:
                break
            data += chunk
        s.close()
        return json.loads(data.decode().strip())
    except Exception:
        return None


def _detect_ack(session_id: str, text: str) -> None:
    """Append any `Habit: <name> <why: | because | matters because | applies
    because> <real work attribution>` statements the agent makes to the
    external ACK LOG. The root-owned MONITOR reads this log, validates each
    statement, and credits the daemon's hold ledger via submit_ack.

    The plugin does NOT credit the daemon directly: that would let the agent's
    own process forge acknowledgments. Only the independent monitor (root-owned,
    unkillable by the agent) can credit. The plugin's job is only to record.

    Matches the daemon's live acceptance grammar (agent_enforcer_daemon.js
    submitAck, updated 2026-08-07): "resonates true" was dropped as a closer
    -- it read as an abstract truth-claim rather than attribution to real
    work. This regex was previously narrower than even that (only the single
    "resonates true because" form), which meant real acks using the other
    closers were silently never detected here. Kept deliberately loose on
    content (just matches the connector shape) -- the daemon's own
    WORK_ATTRIBUTION_RE is what actually validates the reason.
    """
    if not text:
        return
    stmts = re.findall(
        r"habit:\s*\S+\s*(?:why:|because|matters\s+because|applies\s+because)\s*[-–:]?\s*.+",
        text,
        re.I,
    )
    if not stmts:
        return
    try:
        cfg = _load_config()
        log = Path(cfg.get("ack_log", _default_ack_log()))
        log.parent.mkdir(parents=True, exist_ok=True)
        with log.open("a", encoding="utf-8") as fh:
            for s in stmts:
                fh.write(json.dumps({"session_id": session_id or "default",
                                     "statement": s.strip()}) + "\n")
    except Exception:
        pass  # logging must never break the call


# --------------------------------------------------------------------------
# pre_llm_call -> inject a rotating subset of habit prompts (with reasoning)
# --------------------------------------------------------------------------
def _load_config() -> Dict[str, Any]:
    """Plugin-level config (config.yaml). Optional override of defaults.

    Paths are SELF-RESOLVING via env vars (ACK_HABITS_DIR / ACK_ACK_LOG /
    ACK_INJECT_LOG / AGENT_WORKSPACE) so the plugin works no matter where the
    repo lives. config.yaml may set them; env always wins.
    """
    # Defaults are SELF-RESOLVING via env vars (no hardcoded repo/user paths):
    #   1. ACK_HABITS_DIR  — explicit override (daemon + plugin must agree)
    #   2. AGENT_WORKSPACE/.agent/habits — matches the daemon's own habit dir
    #   3. repo-relative   — last resort, derived from __file__ (portable)
    # config.yaml may OVERRIDE these, but env always wins (see merge below).
    _ENV_FOR = {"habits_dir": "ACK_HABITS_DIR", "inject_log": "ACK_INJECT_LOG", "ack_log": "ACK_ACK_LOG"}
    env_habits = (
        os.environ.get("ACK_HABITS_DIR")
        or (os.environ.get("AGENT_WORKSPACE")
            and os.path.join(os.environ["AGENT_WORKSPACE"], ".agent", "habits"))
    )
    repo_habits = (
        Path(__file__).resolve().parents[2]
        / "python" / "example_workspace" / ".agent" / "habits"
    )
    defaults: Dict[str, Any] = {
        "habits_dir": env_habits or str(repo_habits),
        "inject_log": os.environ.get("ACK_INJECT_LOG", _default_inject_log()),
        "ack_log": os.environ.get("ACK_ACK_LOG", _default_ack_log()),
        "inject_enabled": True,
    }
    try:
        cfg_path = Path(__file__).resolve().parent / "config.yaml"
        if cfg_path.is_file():
            import yaml
            file_cfg = yaml.safe_load(cfg_path.read_text(encoding="utf-8")) or {}
            # env vars take precedence over config.yaml values
            for k in ("habits_dir", "inject_log", "ack_log"):
                if os.environ.get(_ENV_FOR[k]):
                    file_cfg[k] = os.environ.get(_ENV_FOR[k])
                elif k not in file_cfg:
                    file_cfg[k] = defaults[k]
            file_cfg.setdefault("inject_enabled", defaults["inject_enabled"])
            return file_cfg
    except Exception:
        pass
    return defaults


def _log_injection(cfg: Dict[str, Any], prompts: List[str]) -> None:
    """External proof: write exactly what was injected to a log file.

    This is what the monitor reads — NOT the agent's self-report.
    """
    try:
        log = Path(cfg.get("inject_log", _default_inject_log()))
        log.parent.mkdir(parents=True, exist_ok=True)
        entry = {
            "ts": datetime.now(timezone.utc).isoformat(),
            "count": len(prompts),
            "prompts": prompts,
        }
        with log.open("a", encoding="utf-8") as fh:
            fh.write(json.dumps(entry) + "\n")
    except Exception:
        pass  # logging must never break injection


def _on_pre_llm_call(
    session_id: str = "",
    user_message: str = "",
    conversation_history: list = None,
    is_first_turn: bool = False,
    model: str = "",
    platform: str = "",
    **_: Any,
) -> Optional[Dict[str, Any]]:
    """pre_llm_call -> inject daemon-rotated habit prompts (reminder channel).

    Rotation lives in the daemon ``pick_prompt`` RPC, same as
    ``node/src/hooks/character.js`` ``pickHabitPrompts``. This channel never
    blocks: unreachable daemon or empty prompts -> None.
    """
    _detect_ack(session_id, user_message)

    if _DISABLE:
        return None
    cfg = _load_config()
    if not cfg.get("inject_enabled", True):
        return None

    try:
        resp = _daemon_rpc("pick_prompt", {"session_id": session_id or "default"})
    except Exception:
        return None
    if not resp or resp.get("error"):
        return None
    prompts = resp.get("prompts") or []
    if not prompts:
        return None

    lines = []
    texts = []
    for h in prompts:
        prompt = h if isinstance(h, str) else (h or {}).get("prompt") or ""
        if not prompt:
            continue
        texts.append(prompt)
        lines.append("- " + prompt)
    if not lines:
        return None
    _log_injection(cfg, texts)
    return {"context": "AGENT CHARACTER HABITS:\n" + "\n".join(lines)}


def register(ctx) -> None:
    """Hermes plugin entry point."""
    ctx.register_hook("pre_llm_call", _on_pre_llm_call)
    ctx.register_hook("pre_tool_call", _on_pre_tool_call)
    logger.info("[agent-character-kit] registered pre_tool_call + pre_llm_call hooks (daemon client)")
