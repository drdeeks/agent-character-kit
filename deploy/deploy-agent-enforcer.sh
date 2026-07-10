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
INSTALL_LIB="/usr/local/lib/agent-character-kit"
INSTALL_BIN="/usr/local/bin/agent-enforcer-daemon"
RUN_DIR="/run/agent-enforcer"
VAR_DIR="/var/lib/agent-character-kit"
LOG_DIR="/var/log/agent-character-kit"
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

# Seed the non-negotiable credential-leak habit (hard enforcement, always on).
HABITS_DIR="$VAR_DIR/workspace/.agent/habits"
install -d -o root -g root -m 0755 "$HABITS_DIR"
if [ ! -f "$HABITS_DIR/no_credential_leak.yaml" ]; then
  cat > "$HABITS_DIR/no_credential_leak.yaml" <<'YAML'
name: no_credential_leak
enforcement:
  level: hard
behavior:
  kind: guard
  steps:
    - check: block_secret_leak
      patterns:
        - "sk-"
        - "sk_"
        - "AIza"
        - "xoxb-"
        - "xoxp-"
        - "AKIA"
        - "ghp_"
        - "gho_"
        - "glpat-"
        - "-----BEGIN PRIVATE KEY-----"
        - "api_key="
        - "apikey="
        - "password="
        - "secret="
        - "token="
        - "client_secret="
      require_assignment: true
YAML
  chown root:root "$HABITS_DIR/no_credential_leak.yaml"
  chmod 0644 "$HABITS_DIR/no_credential_leak.yaml"
fi

# 2. Install source (root-owned, agent read-only)
cp -r "$SRC_DIR/node" "$INSTALL_LIB/node"
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

# 4. Systemd unit
cp "$SRC_DIR/deploy/agent-enforcer.service" "$UNIT"
chown root:root "$UNIT"
chmod 0644 "$UNIT"

# 5. Enable + start
systemctl daemon-reload
systemctl enable --now agent-enforcer.service

echo ">> Done. Status:"
systemctl status agent-enforcer.service --no-pager || true
echo
echo "Verify self-respawn:  sudo systemctl kill -s KILL agent-enforcer.service"
echo "                         -> it should return within ~3s (RestartSec=3)"
