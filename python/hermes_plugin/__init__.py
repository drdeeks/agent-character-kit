"""
Agent Identity Kit — Hermes plugin (real, registered, fail-closed).

Bridges Hermes's generic ``pre_tool_call`` hook to the Agent Identity Kit
enforcer DAEMON over its RPC socket. The daemon is the SINGLE SOURCE OF
TRUTH for enforcement (FOREVER-SYSTEM.md §1) — it runs as a separate,
supervised process (systemd/launchd/supervise.py) on Linux, macOS, Windows,
container, host, or USB free-state. This plugin is a THIN CLIENT: it does NOT
embed enforcement logic. One policy, one binary, every OS.

Design:
  * This plugin is a LAYER, not a re-implementation. It imports AIK's
    EnforcerClient and talks to the daemon; it does NOT copy enforcement logic.
  * It never touches Hermes core files. Only the generic pre_tool_call hook.
  * Fail-closed: if the daemon socket is unreachable, the tool call is BLOCKED.
    A guard that fails open is no guard. (The daemon itself is supervised and
    self-heals; the only true failure is the daemon being down — which must
    block, not pass.)

Enable: drop this directory into ~/.hermes/plugins/agent-identity-kit/ and
ensure the `agent_identity_kit` Python package is importable (pip install -e
./agent-identity-kit/python). The daemon must be running (see supervise.py /
deploy/).
"""

from __future__ import annotations

import asyncio
import logging
import os
from typing import Any, Dict, Optional

logger = logging.getLogger(__name__)

# Version — kept in sync with /VERSION at repo root.
AIK_VERSION = "1.0.0"

# Optional env escape hatch: set AIK_DISABLE=1 to turn the plugin into a
# no-op (never use in production — it defeats the purpose).
_DISABLE = os.environ.get("AIK_DISABLE") == "1"


def _get_client():
    """Construct the AIK EnforcerClient (thin RPC client to the daemon).

    Deferred to call-time so the plugin loads even if AIK isn't importable yet
    (we surface a clear fail-closed error instead of crashing Hermes startup).
    """
    from agent_identity_kit.enforcer import EnforcerClient
    return EnforcerClient()


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

    # Determine the command the same way the daemon does (tool + params shape).
    command = ""
    if isinstance(args, dict):
        for key in ("command", "cmd", "code"):
            if isinstance(args.get(key), str):
                command = args[key]
                break

    try:
        client = _get_client()
        # EnforcerClient.call/validate_tool are async; run in a fresh loop.
        result = asyncio.run(
            client.validate_tool(tool_name, args, session_id or task_id or "unknown")
        )
    except Exception as exc:
        # Fail-closed: daemon unreachable or client error -> block.
        logger.error("[agent-identity-kit] enforcement error (failing closed): %s", exc)
        return {
            "action": "block",
            "message": (
                "Agent Identity Kit enforcer unavailable — action blocked. "
                "Character cannot be verified, so the action is denied. "
                "A guard that fails open is no guard."
            ),
        }

    if not result.get("allowed"):
        reason = result.get("reason") or "Denied by Agent Identity Kit enforcer."
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
    logger.info("[agent-identity-kit] registered pre_tool_call enforcement hook (daemon client)")
