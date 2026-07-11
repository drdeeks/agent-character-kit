#!/usr/bin/env bash
#
# deploy-agent-enforcer.sh — install the root-owned ACK enforcer as a systemd service.
#
# Run on the TARGET machine (Hemlock host / container) AS ROOT:
#   sudo bash deploy-agent-enforcer.sh
#
# What it does:
#   1. Creates the system-owned directories (root-owned, agent read-only).
#   2. Installs the daemon binary to /usr/local/bin (root-owned, 0755).
#   3. Installs source under /usr/local/lib/agent-character-kit.
#   4. Writes the systemd unit to /etc/systemd/system.
#   5. Enables + starts the service (self-respawning via RestartSec=3).
#
set -euo pipefail

SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NODE_BIN="$(command -v node)"
# All paths are self-resolving via env (no hardcoded host assumptions).
# Defaults shown; override with ACK_INSTALL_LIB / AGENT_WORKSPACE / ENFORCER_SOCKET.
INSTALL_LIB="${ACK_INSTALL_LIB:-/usr/local/lib/agent-character-kit}"
AGENT_WORKSPACE="${AGENT_WORKSPACE:-/var/lib/agent-character-kit/workspace}"
ENFORCER_SOCKET="${ENFORCER_SOCKET:-/run/agent-enforcer/main.sock}"
INSTALL_BIN="${ACK_INSTALL_BIN:-/usr/local/bin/agent-enforcer-daemon}"
RUN_DIR="$(dirname "$ENFORCER_SOCKET")"
VAR_DIR="$(dirname "$AGENT_WORKSPACE")"
LOG_DIR="${ACK_LOG_DIR:-/var/log/agent-character-kit}"
UNIT="/etc/systemd/system/agent-enforcer.service"

[ "$(id -u)" -eq 0 ] || { echo "ERROR: run as root (sudo bash $0)"; exit 1; }
[ -n "$NODE_BIN" ] || { echo "ERROR: node not found"; exit 1; }

echo ">> Installing ACK enforcer (root-owned, self-respawning)..."

# 1. System-owned directories — agent (non-root) gets NO write access.
install -d -o root -g root -m 0755 "$RUN_DIR"
install -d -o root -g root -m 0755 "$VAR_DIR"
install -d -o root -g root -m 0755 "$VAR_DIR/workspace"
install -d -o root -g root -m 0755 "$VAR_DIR/workspace/.agent"
install -d -o root -g root -m 0755 "$LOG_DIR"
install -d -o root -g root -m 0755 "$INSTALL_LIB"

# Seed a baseline constitution so the enforcer is NOT born in violation of itself.
# The agent (or a later install step) overrides these; the enforcer owns the file
# (root-writable only) so the agent cannot delete its own constraints.
if [ ! -f "$VAR_DIR/workspace/.agent/constitution.yaml" ]; then
  cat > "$VAR_DIR/workspace/.agent/constitution.yaml" <<'YAML'
agent:
  id: ack-enforcer
  name: "ACK Enforcer Workspace"
  purpose: "System-owned enforcement workspace"
core_values:
  - "Character is exercised on every action, not checked once"
  - "Fail closed — when unsure, deny"
  - "Do not bypass, patch, or disable the enforcer"
operational_standards:
  - "Every tool call passes through the gatekeeper FIRST"
hard_constraints:
  - "rm -rf /"
  - "git push --force"
  - "sudo"
  - "su"
  - "chmod 777"
  - "chown -R"
aspiration: "Behave with integrity under no observation"
YAML
fi
if [ ! -f "$VAR_DIR/workspace/.agent/enforcer.yaml" ]; then
  cat > "$VAR_DIR/workspace/.agent/enforcer.yaml" <<'YAML'
# Open policy by default: no allow-list (everything permitted unless denied).
# Set an `allow:` list to flip to default-deny. `deny:` is always enforced.
YAML
fi
chown -R root:root "$VAR_DIR/workspace/.agent"
chmod 0644 "$VAR_DIR/workspace/.agent/constitution.yaml" "$VAR_DIR/workspace/.agent/enforcer.yaml"

# Seed habits from the repo's example workspace (single source of habit files).
# Copies every *.yaml that isn't already present, so a redeploy never clobbers
# habits the agent/user has since customized. The credential-leak guard lives
# here too (hard enforcement) — no longer hardcoded inline.
HABITS_DIR="$VAR_DIR/workspace/.agent/habits"
install -d -o root -g root -m 0755 "$HABITS_DIR"
SRC_HABITS="$SRC_DIR/python/example_workspace/.agent/habits"
if [ -d "$SRC_HABITS" ]; then
  for hf in "$SRC_HABITS"/*.yaml; do
    [ -e "$hf" ] || continue
    bn="$(basename "$hf")"
    if [ ! -f "$HABITS_DIR/$bn" ]; then
      cp "$hf" "$HABITS_DIR/$bn"
      chown root:root "$HABITS_DIR/$bn"
      chmod 0644 "$HABITS_DIR/$bn"
    fi
  done
fi

# 2. Install source (root-owned, agent read-only)
# Copy the CONTENTS of SRC/node into INSTALL_LIB/node (trailing-slash
# semantics) so a re-deploy always refreshes the real binary at
# $INSTALL_LIB/node/enforcer/agent_enforcer_daemon.js. Using `cp -r
# "$SRC/node" "$INSTALL_LIB/node"` would NEST under node/node/ on a second
# run (because the dest dir already exists) and silently leave the live
# binary stale — a footgun that bites exactly when you redeploy.
install -d -o root -g root -m 0755 "$INSTALL_LIB/node"
cp -r "$SRC_DIR/node/." "$INSTALL_LIB/node/"
chown -R root:root "$INSTALL_LIB"
chmod -R go-w "$INSTALL_LIB"        # writable only by root
chmod -R a+rX "$INSTALL_LIB"         # agent may READ (to load habits), not write

# 3. Wrapper binary (root-owned executable)
cat > "$INSTALL_BIN" <<EOF
#!/usr/bin/env bash
exec $NODE_BIN "$INSTALL_LIB/node/enforcer/agent_enforcer_daemon.js"
EOF
chown root:root "$INSTALL_BIN"
chmod 0755 "$INSTALL_BIN"

# 4. Systemd units (enforcer + monitor + watchdog — all root-owned, self-respawning)
for unit in agent-enforcer.service agent-character-monitor.service agent-character-watchdog.service; do
  cp "$SRC_DIR/deploy/$unit" "/etc/systemd/system/$unit"
  chown root:root "/etc/systemd/system/$unit"
  chmod 0644 "/etc/systemd/system/$unit"
done

# 5. Enable + start all three
systemctl daemon-reload
systemctl enable --now agent-enforcer.service agent-character-monitor.service agent-character-watchdog.service

echo ">> Done. Status:"
systemctl status agent-enforcer.service agent-character-monitor.service agent-character-watchdog.service --no-pager || true
echo
echo "Verify self-respawn:  sudo systemctl kill -s KILL agent-enforcer.service"
echo "                         -> it should return within ~3s (RestartSec=3)"
echo "Monitor and watchdog will auto-restart on failure (Restart=always, RestartSec=3)"
