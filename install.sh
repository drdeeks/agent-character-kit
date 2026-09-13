#!/usr/bin/env bash
#
# install.sh — install Agent Character Kit and land straight in the real
# interactive setup wizard, in one command.
#
#   curl -fsSL https://raw.githubusercontent.com/drdeeks/agent-character-kit/main/install.sh | bash
#
# Installs npm package @drdeeks/character-kit (current kit: 1.8.0), then
# execs `ack configure`. npm install -g still never configures on its own.
#
# Why this exists instead of an npm postinstall script: npm's lifecycle
# scripts (preinstall/install/postinstall/prepare) never get a real
# controlling terminal, even when the outer `npm install` itself is running
# in one -- confirmed by direct instrumentation, not assumed (see
# CHANGELOG.md / blueprint.md CL-0012). A live interactive wizard cannot run
# inside one of those hooks, full stop. This script sidesteps the problem
# entirely by not going through npm's lifecycle system for the interactive
# part at all: it's a plain shell script running in your actual terminal,
# so it has a real TTY the whole way through.
#
# `npm install -g` on its own still only ever installs the package and
# configures nothing -- that guarantee is unchanged. This script is a
# separate, explicit thing you're choosing to run, that does what a human
# would do by hand (install, then configure) as one guided flow instead of
# two commands you have to know to type.
#
# Non-interactive use (CI, automation): forward flags straight to
# `ack configure`, e.g.:
#   curl -fsSL .../install.sh | bash -s -- --yes --root
#   curl -fsSL .../install.sh | bash -s -- --yes --service-user my-enforcer
#   curl -fsSL .../install.sh | bash -s -- --yes --user --harness claude
#
set -euo pipefail

PACKAGE="${ACK_PACKAGE:-@drdeeks/character-kit}"
MIN_NODE_MAJOR=18

say() { printf '%s\n' "$*"; }
err() { printf 'ERROR: %s\n' "$*" >&2; }

# ─── 1. Node/npm present, real version check (never silently install a runtime) ──

if ! command -v node >/dev/null 2>&1; then
  err "Node.js is required (>= ${MIN_NODE_MAJOR}.0.0) and wasn't found on PATH."
  err "Install it from https://nodejs.org/ (or via nvm/your OS package manager), then re-run this script."
  exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
  err "npm is required and wasn't found on PATH (usually ships with Node.js -- check your Node install)."
  exit 1
fi

node_major="$(node -e 'console.log(process.versions.node.split(".")[0])')"
if [ "$node_major" -lt "$MIN_NODE_MAJOR" ]; then
  err "Node.js >= ${MIN_NODE_MAJOR}.0.0 is required; found $(node -v)."
  err "Update Node (https://nodejs.org/, nvm, or your OS package manager), then re-run this script."
  exit 1
fi

# ─── 2. Install the package for real (npm registry, or a local override for dev/testing) ──

say ""
say "── Installing ${PACKAGE} ──"
if [ -n "${ACK_INSTALL_FROM:-}" ]; then
  # Dev/testing override: install from a local tarball or directory path
  # instead of the registry (e.g. ACK_INSTALL_FROM=./drdeeks-character-kit-1.8.0.tgz).
  say "(ACK_INSTALL_FROM set -- installing from local path: ${ACK_INSTALL_FROM})"
  npm install -g "$ACK_INSTALL_FROM" --allow-scripts="$PACKAGE" || npm install -g "$ACK_INSTALL_FROM"
else
  npm install -g "$PACKAGE" --allow-scripts="$PACKAGE" || npm install -g "$PACKAGE"
fi

if ! command -v ack >/dev/null 2>&1; then
  err "Install finished but 'ack' isn't on PATH. If npm's global bin dir isn't in your PATH,"
  err "add it (npm config get prefix, then add \$(that)/bin to PATH) and re-run 'ack configure' yourself."
  exit 1
fi

say ""
say "── Installed. Launching setup ──"
say ""

# ─── 3. Hand off to the real interactive wizard -- genuine TTY from here on ──
#
# No prompts get asked twice: this script never asks about privilege mode,
# harnesses, or anything else itself -- ack configure already asks all of
# that, correctly, with real sudo access when it needs it (root/service-user
# modes run deploy-agent-enforcer.sh with stdio inherited from THIS shell).
# Forwarding "$@" lets CI/automation callers skip straight to non-interactive
# mode (--yes --root, --yes --service-user <name>, etc.) without this script
# needing to know anything about those flags itself.
exec ack configure "$@"
