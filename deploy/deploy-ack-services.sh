#!/usr/bin/env bash
#
# deploy-ack-services.sh — install the ACK acknowledgment monitor + watchdog
# as root-owned systemd services (self-healing hold pipeline).
#
# Run AS ROOT after the enforcer daemon is already deployed:
#   sudo bash deploy/deploy-ack-services.sh
#
# Prereqs:
#   - agent-enforcer.service is live (deploy-agent-enforcer.sh already run).
#   - The daemon has the toolTick/submitAck RPCs (repo node/ is current).
#
# What it does:
#   1. Copies ack_monitor.js + ack_watchdog.js (Node-native; no Python
#      required for this trio) to /usr/local/lib/agent-character-kit (root-owned).
#   2. Installs the two systemd units.
#   3. Enables + starts both (Restart=always -> self-healing).
#
# Shared state (per-agent, multi-agent architecture as of 1.5.0 -- these two
# stale single-workspace paths from before that redesign never got updated
# here, even though the monitor/watchdog have both been agent-registry-aware
# for a while now):
#   - registry: $ACK_VAR_ROOT/workspaces.json (default /var/lib/agent-character-kit/workspaces.json)
#   - per agent: <workspace>/agents/<name>/.agent/ack.jsonl + <name>.sock
set -euo pipefail

SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INSTALL_LIB="/usr/local/lib/agent-character-kit"
MON_BIN="$INSTALL_LIB/ack_monitor.js"
WATCH_BIN="$INSTALL_LIB/ack_watchdog.js"
SERVICE_USER="${ACK_SERVICE_USER:-root}"
SERVICE_GROUP="${ACK_SERVICE_GROUP:-$SERVICE_USER}"

[ "$(id -u)" -eq 0 ] || { echo "ERROR: run as root (sudo bash $0)"; exit 1; }

echo ">> Installing ACK monitor + watchdog (service user: $SERVICE_USER, self-healing)..."

install -d -o "$SERVICE_USER" -g "$SERVICE_GROUP" -m 0750 "$INSTALL_LIB"
install -o "$SERVICE_USER" -g "$SERVICE_GROUP" -m 0640 "$SRC_DIR/deploy/ack_monitor.js" "$MON_BIN"
install -o "$SERVICE_USER" -g "$SERVICE_GROUP" -m 0640 "$SRC_DIR/deploy/ack_watchdog.js" "$WATCH_BIN"
sed -e "s/^User=root$/User=$SERVICE_USER/" -e "s/^Group=root$/Group=$SERVICE_GROUP/" \
  "$SRC_DIR/deploy/agent-character-monitor.service" > /etc/systemd/system/agent-character-monitor.service
sed -e "s/^User=root$/User=$SERVICE_USER/" -e "s/^Group=root$/Group=$SERVICE_GROUP/" \
  "$SRC_DIR/deploy/agent-character-watchdog.service" > /etc/systemd/system/agent-character-watchdog.service
# Same registry path deploy-agent-enforcer.sh writes to (ACK_VAR_ROOT there,
# same default here) -- this script runs SECOND per the documented 2-step
# flow and would otherwise silently overwrite whatever registry env line
# that script already set, since both scripts independently manage these
# same two unit files. Real duplication between the two scripts, not fixed
# here -- this keeps them from actively fighting each other in the
# meantime.
ACK_VAR_ROOT="${ACK_VAR_ROOT:-/var/lib/agent-character-kit}"
for unit in agent-character-monitor.service agent-character-watchdog.service; do
  if ! grep -q "^Environment=ACK_WORKSPACES_REGISTRY=" "/etc/systemd/system/$unit"; then
    sed -i "/^\[Service\]/a Environment=ACK_WORKSPACES_REGISTRY=$ACK_VAR_ROOT/workspaces.json" "/etc/systemd/system/$unit"
  else
    sed -i "s|^Environment=ACK_WORKSPACES_REGISTRY=.*|Environment=ACK_WORKSPACES_REGISTRY=$ACK_VAR_ROOT/workspaces.json|" "/etc/systemd/system/$unit"
  fi
done
chown root:root /etc/systemd/system/agent-character-monitor.service /etc/systemd/system/agent-character-watchdog.service
chmod 0644 /etc/systemd/system/agent-character-monitor.service /etc/systemd/system/agent-character-watchdog.service

systemctl daemon-reload
systemctl enable --now agent-character-monitor.service
systemctl enable --now agent-character-watchdog.service

echo ">> Done. Status:"
systemctl status agent-character-monitor.service --no-pager || true
systemctl status agent-character-watchdog.service --no-pager || true
echo
echo "Verify self-heal:  sudo systemctl kill -s KILL agent-character-monitor.service"
echo "                     -> agent-character-watchdog should restart it within ~5s"
