"""
Agent Character Kit — Hermes plugin (real, registered, fail-closed).

Bridges Hermes's generic ``pre_tool_call`` hook to the Agent Character Kit
enforcer DAEMON over its RPC socket. The daemon is the SINGLE SOURCE OF
TRUTH for enforcement. This plugin is a THIN CLIENT: it does NOT embed
enforcement logic.

Fail-closed: if the daemon socket is unreachable or any error occurs, the
tool call is BLOCKED. A guard that fails open is no guard.
"""

from __future__ import annotations

import asyncio
import concurrent.futures
import logging
import os
from typing import Any, Dict, Optional

logger = logging.getLogger(__name__)

ACK_VERSION = "1.0.0"

# Optional env escape hatch: set ACK_DISABLE=1 to turn the plugin into a
# no-op (never use in production — it defeats the purpose).
_DISABLE = os.environ.get("ACK_DISABLE") == "1"


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
    """pre_tool_call gate -> daemon.

    Returns a dict Hermes treats as a BLOCK when it carries ``action: "block"``.
    Returns None to allow the call through.
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

    # Allowed.
    return None


def register(ctx) -> None:
    """Hermes plugin entry point."""
    ctx.register_hook("pre_tool_call", _on_pre_tool_call)
    logger.info("[agent-character-kit] registered pre_tool_call enforcement hook (daemon client)")
