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
#   1. Copies ack_monitor.py + ack_watchdog.py to /usr/local/lib/agent-character-kit (root-owned).
#   2. Installs the two systemd units.
#   3. Enables + starts both (Restart=always -> self-healing).
#
# Shared state:
#   - ack log: /tmp/agent-character-kit-ack.jsonl  (agent writes, monitor reads+validates)
#   - socket:  /run/agent-enforcer/main.sock        (root-owned daemon)
set -euo pipefail

SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INSTALL_LIB="/usr/local/lib/agent-character-kit"
MON_BIN="$INSTALL_LIB/ack_monitor.py"
WATCH_BIN="$INSTALL_LIB/ack_watchdog.py"

[ "$(id -u)" -eq 0 ] || { echo "ERROR: run as root (sudo bash $0)"; exit 1; }

echo ">> Installing ACK monitor + watchdog (root-owned, self-healing)..."

install -d -o root -g root -m 0755 "$INSTALL_LIB"
install -o root -g root -m 0644 "$SRC_DIR/deploy/ack_monitor.py" "$MON_BIN"
install -o root -g root -m 0644 "$SRC_DIR/deploy/ack_watchdog.py" "$WATCH_BIN"
install -o root -g root -m 0644 "$SRC_DIR/deploy/agent-character-monitor.service" /etc/systemd/system/agent-character-monitor.service
install -o root -g root -m 0644 "$SRC_DIR/deploy/agent-character-watchdog.service" /etc/systemd/system/agent-character-watchdog.service

systemctl daemon-reload
systemctl enable --now agent-character-monitor.service
systemctl enable --now agent-character-watchdog.service

echo ">> Done. Status:"
systemctl status agent-character-monitor.service --no-pager || true
systemctl status agent-character-watchdog.service --no-pager || true
echo
echo "Verify self-heal:  sudo systemctl kill -s KILL agent-character-monitor.service"
echo "                     -> agent-character-watchdog should restart it within ~5s"
