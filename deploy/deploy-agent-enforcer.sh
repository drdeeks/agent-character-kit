#!/usr/bin/env bash
#
# deploy-agent-enforcer.sh — install the ACK enforcer as a systemd service,
# owned by root OR a dedicated non-root service user.
#
# Run on the TARGET machine (Hemlock host / container) AS ROOT:
#   sudo bash deploy-agent-enforcer.sh
#   sudo ACK_SERVICE_USER=ack-enforcer ACK_AGENT_USER=drdeek bash deploy-agent-enforcer.sh
#
# What it does:
#   1. Creates the service user (if ACK_SERVICE_USER != root and doesn't
#      already exist) and the shared client group.
#   2. Creates the system-owned directories (service-user-owned, agent
#      read-only, socket dir group-accessible to the client group).
#   3. Installs the daemon binary to /usr/local/bin.
#   4. Installs source under /usr/local/lib/agent-character-kit.
#   5. Writes the systemd units (templated to the chosen service user).
#   6. Enables + starts the service (self-respawning via RestartSec=3).
#
# Privilege model:
#   ACK_SERVICE_USER=root (default)         — daemon/monitor/watchdog run as
#                                              root. Strongest boundary; the
#                                              agent cannot touch them at all.
#   ACK_SERVICE_USER=<name>, e.g. ack-enforcer — daemon runs as a dedicated,
#                                              unprivileged system user. Real
#                                              boundary (the agent's own uid
#                                              still can't kill/edit it)
#                                              without granting it root.
#   (No systemd deploy at all — plain `ack configure`, same uid as the
#   agent) is the weakest option: same-uid means the agent CAN kill/edit
#   the daemon with tools it already has. Not this script's concern; this
#   script only ever sets up a real privilege boundary.
#
set -euo pipefail

SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NODE_BIN="$(command -v node)"

# All paths are self-resolving via env (no hardcoded host assumptions).
INSTALL_LIB="${ACK_INSTALL_LIB:-/usr/local/lib/agent-character-kit}"
AGENT_WORKSPACE="${AGENT_WORKSPACE:-/var/lib/agent-character-kit/workspace}"
ENFORCER_SOCKET="${ENFORCER_SOCKET:-/run/agent-enforcer/main.sock}"
INSTALL_BIN="${ACK_INSTALL_BIN:-/usr/local/bin/agent-enforcer-daemon}"
RUN_DIR="$(dirname "$ENFORCER_SOCKET")"
VAR_DIR="$(dirname "$AGENT_WORKSPACE")"
LOG_DIR="${ACK_LOG_DIR:-/var/log/agent-character-kit}"

# Privilege model inputs.
SERVICE_USER="${ACK_SERVICE_USER:-root}"
SERVICE_GROUP="${ACK_SERVICE_GROUP:-$SERVICE_USER}"
CLIENT_GROUP="${ACK_CLIENT_GROUP:-ack-clients}"
# Who the AGENT actually runs as, so it can be added to the client group.
# Falls back to $SUDO_USER (the real invoker when run via `sudo bash ...`),
# since $USER/$(whoami) under sudo is just "root" and useless here.
AGENT_USER="${ACK_AGENT_USER:-${SUDO_USER:-}}"

[ "$(id -u)" -eq 0 ] || { echo "ERROR: run as root (sudo bash $0)"; exit 1; }
[ -n "$NODE_BIN" ] || { echo "ERROR: node not found"; exit 1; }

if [ "$SERVICE_USER" != "root" ] && [ -z "$AGENT_USER" ]; then
  echo "ERROR: ACK_SERVICE_USER=$SERVICE_USER (a dedicated service user) needs to know"
  echo "       which user the AGENT runs as, so it can be added to the '$CLIENT_GROUP'"
  echo "       group and actually reach the socket. Set ACK_AGENT_USER=<name>, or run"
  echo "       this script via 'sudo' as that user so \$SUDO_USER resolves it automatically."
  exit 1
fi

echo ">> Installing ACK enforcer (service user: $SERVICE_USER, self-respawning)..."

# 0. Service user + shared client group.
if [ "$SERVICE_USER" != "root" ]; then
  if ! id "$SERVICE_USER" >/dev/null 2>&1; then
    echo ">> Creating dedicated service user '$SERVICE_USER' (system account, no login, no home)..."
    useradd --system --no-create-home --shell /usr/sbin/nologin "$SERVICE_USER"
  fi
fi
if ! getent group "$CLIENT_GROUP" >/dev/null 2>&1; then
  echo ">> Creating shared client group '$CLIENT_GROUP'..."
  groupadd "$CLIENT_GROUP"
fi
# The daemon's own user needs to be IN the client group too (its process
# creates the socket; group ownership at creation time comes from the
# process's effective gid when the parent directory has setgid set, which
# only works if the service user is actually a member of that group).
usermod -aG "$CLIENT_GROUP" "$SERVICE_USER" 2>/dev/null || true
if [ -n "$AGENT_USER" ]; then
  echo ">> Adding agent user '$AGENT_USER' to '$CLIENT_GROUP' (log out/in, or \`newgrp $CLIENT_GROUP\`, to pick it up in an existing session)..."
  usermod -aG "$CLIENT_GROUP" "$AGENT_USER"
fi

# 1. System-owned directories.
# RUN_DIR (holds the socket) is the one directory that needs cross-uid
# access: owned by the service user, GROUP-owned by the client group, with
# setgid (g+s, the "2" in 2750) so the socket file the daemon creates
# inside it inherits the client group automatically -- see
# agent_enforcer_daemon.js's own socket chmod (0660) for the other half of
# this. Everything else stays fully private to the service user; the agent
# only ever needs the socket, never direct file access (it's a thin RPC
# client, not a filesystem consumer of the workspace).
install -d -o "$SERVICE_USER" -g "$CLIENT_GROUP" -m 2750 "$RUN_DIR"
install -d -o "$SERVICE_USER" -g "$SERVICE_GROUP" -m 0750 "$VAR_DIR"
install -d -o "$SERVICE_USER" -g "$SERVICE_GROUP" -m 0750 "$AGENT_WORKSPACE"
install -d -o "$SERVICE_USER" -g "$SERVICE_GROUP" -m 0750 "$AGENT_WORKSPACE/.agent"
install -d -o "$SERVICE_USER" -g "$SERVICE_GROUP" -m 0750 "$LOG_DIR"
install -d -o "$SERVICE_USER" -g "$SERVICE_GROUP" -m 0750 "$INSTALL_LIB"

# Seed a baseline constitution so the enforcer is NOT born in violation of itself.
# The agent (or a later install step) overrides these; the enforcer owns the file
# (service-user-writable only) so the agent cannot delete its own constraints.
if [ ! -f "$AGENT_WORKSPACE/.agent/constitution.yaml" ]; then
  cat > "$AGENT_WORKSPACE/.agent/constitution.yaml" <<'YAML'
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
if [ ! -f "$AGENT_WORKSPACE/.agent/enforcer.yaml" ]; then
  cat > "$AGENT_WORKSPACE/.agent/enforcer.yaml" <<'YAML'
# Open policy by default: no allow-list (everything permitted unless denied).
# Set an `allow:` list to flip to default-deny. `deny:` is always enforced.
YAML
fi
chown -R "$SERVICE_USER:$SERVICE_GROUP" "$AGENT_WORKSPACE/.agent"
chmod 0640 "$AGENT_WORKSPACE/.agent/constitution.yaml" "$AGENT_WORKSPACE/.agent/enforcer.yaml"

# Seed habits from the repo's example workspace (single source of habit files).
# Copies every *.yaml that isn't already present, so a redeploy never clobbers
# habits the agent/user has since customized. The credential-leak guard lives
# here too (hard enforcement) — no longer hardcoded inline.
HABITS_DIR="$AGENT_WORKSPACE/.agent/habits"
install -d -o "$SERVICE_USER" -g "$SERVICE_GROUP" -m 0750 "$HABITS_DIR"
SRC_HABITS="$SRC_DIR/python/example_workspace/.agent/habits"
if [ -d "$SRC_HABITS" ]; then
  for hf in "$SRC_HABITS"/*.yaml; do
    [ -e "$hf" ] || continue
    bn="$(basename "$hf")"
    if [ ! -f "$HABITS_DIR/$bn" ]; then
      cp "$hf" "$HABITS_DIR/$bn"
      chown "$SERVICE_USER:$SERVICE_GROUP" "$HABITS_DIR/$bn"
      chmod 0640 "$HABITS_DIR/$bn"
    fi
  done
fi

# 2. Install source (service-user-owned, agent read-only)
# Copy the CONTENTS of SRC/node into INSTALL_LIB/node (trailing-slash
# semantics) so a re-deploy always refreshes the real binary at
# $INSTALL_LIB/node/enforcer/agent_enforcer_daemon.js. Using `cp -r
# "$SRC/node" "$INSTALL_LIB/node"` would NEST under node/node/ on a second
# run (because the dest dir already exists) and silently leave the live
# binary stale — a footgun that bites exactly when you redeploy.
install -d -o "$SERVICE_USER" -g "$SERVICE_GROUP" -m 0755 "$INSTALL_LIB/node"
cp -r "$SRC_DIR/node/." "$INSTALL_LIB/node/"

# Install the daemon's real npm dependencies (js-yaml, commander,
# gray-matter) into the deployed location. Without this the daemon is an
# ES module that imports packages nothing provides -- ERR_MODULE_NOT_FOUND
# on every start, crash-looping until systemd's StartLimitBurst gives up.
# Found live (not theorized): root-mode had never actually started
# successfully until this exact gap was hit and traced, 2026-08-07.
NPM_BIN="$(command -v npm)"
[ -n "$NPM_BIN" ] || { echo "ERROR: npm not found -- cannot install daemon dependencies"; exit 1; }
echo ">> Installing daemon dependencies into $INSTALL_LIB/node ..."
(cd "$INSTALL_LIB/node" && "$NPM_BIN" install --omit=dev --no-audit --no-fund)

chown -R "$SERVICE_USER:$SERVICE_GROUP" "$INSTALL_LIB"
chmod -R go-w "$INSTALL_LIB"          # writable only by the service user
chmod -R a+rX "$INSTALL_LIB"          # anyone may READ (needed to load habits), not write

# 3. Wrapper binary (executable by anyone; systemd's User= directive is the
#    actual privilege boundary, not this file's ownership).
cat > "$INSTALL_BIN" <<EOF
#!/usr/bin/env bash
exec $NODE_BIN "$INSTALL_LIB/node/enforcer/agent_enforcer_daemon.js"
EOF
chown "$SERVICE_USER:$SERVICE_GROUP" "$INSTALL_BIN"
chmod 0755 "$INSTALL_BIN"

# 4. Register this agent's workspace in the shared registry the daemon
#    reads at startup (agent_enforcer_daemon.js's resolveWorkspaces()).
#    ONE enforcer holds every agent -- agents don't get their own top-level
#    workspace or their own daemon/systemd unit, they get added to this
#    daemon's list (drdeek, 2026-08-07: "the enforcer can hold all of
#    them... the enforcer service at root gets additional socks added to
#    it"). Idempotent: re-running this script for the same AGENT_WORKSPACE
#    (a redeploy) doesn't duplicate the entry.
REGISTRY="$VAR_DIR/workspaces.json"
REGISTRY_HAD_OTHER_ENTRIES=false
if [ -f "$REGISTRY" ]; then
  if "$NODE_BIN" -e "
    const fs = require('fs');
    const list = JSON.parse(fs.readFileSync(process.argv[1], 'utf8'));
    process.exit(Array.isArray(list) && list.filter(w => w !== process.argv[2]).length > 0 ? 0 : 1);
  " "$REGISTRY" "$AGENT_WORKSPACE"; then
    REGISTRY_HAD_OTHER_ENTRIES=true
  fi
fi
"$NODE_BIN" -e "
  const fs = require('fs');
  const path = process.argv[1];
  const ws = process.argv[2];
  let list = [];
  try { list = JSON.parse(fs.readFileSync(path, 'utf8')); if (!Array.isArray(list)) list = []; } catch {}
  if (!list.includes(ws)) list.push(ws);
  fs.writeFileSync(path, JSON.stringify(list, null, 2) + '\n');
" "$REGISTRY" "$AGENT_WORKSPACE"
chown "$SERVICE_USER:$SERVICE_GROUP" "$REGISTRY"
chmod 0640 "$REGISTRY"
echo ">> Registered $AGENT_WORKSPACE in $REGISTRY"

# 5. Systemd units (enforcer + monitor + watchdog — templated to the chosen
#    service user, self-respawning). The checked-in unit files hardcode
#    User=root/Group=root as the safe default; sed-replace at deploy time
#    rather than maintaining a second set of near-duplicate unit files per
#    privilege mode. Exactly one of each unit regardless of how many agents
#    are registered -- the monitor tracks all of them itself, same as the
#    daemon does; neither gets a second instance per agent.
for unit in agent-enforcer.service agent-character-monitor.service agent-character-watchdog.service; do
  sed -e "s/^User=root$/User=$SERVICE_USER/" \
      -e "s/^Group=root$/Group=$SERVICE_GROUP/" \
      "$SRC_DIR/deploy/$unit" > "/etc/systemd/system/$unit"
  # The checked-in unit files' Environment=AGENT_WORKSPACE/ENFORCER_SOCKET
  # lines are placeholder defaults -- without this, every deploy silently
  # ignored whatever $AGENT_WORKSPACE/$ENFORCER_SOCKET this specific run
  # actually computed and used the checked-in literal instead, regardless
  # of which agent was actually being deployed. Only agent-enforcer.service
  # has these keys; sed is a no-op on units that don't.
  sed -i \
    -e "s|^Environment=AGENT_WORKSPACE=.*|Environment=AGENT_WORKSPACE=$AGENT_WORKSPACE|" \
    -e "s|^Environment=ENFORCER_SOCKET=.*|Environment=ENFORCER_SOCKET=$ENFORCER_SOCKET|" \
    "/etc/systemd/system/$unit"
  # Explicit registry path -- more robust than relying on the daemon's own
  # path-guessing fallback, and the monitor needs to read this exact same
  # file to know which agents to tail acks for.
  if ! grep -q "^Environment=ACK_WORKSPACES_REGISTRY=" "/etc/systemd/system/$unit"; then
    sed -i "/^\[Service\]/a Environment=ACK_WORKSPACES_REGISTRY=$REGISTRY" "/etc/systemd/system/$unit"
  else
    sed -i "s|^Environment=ACK_WORKSPACES_REGISTRY=.*|Environment=ACK_WORKSPACES_REGISTRY=$REGISTRY|" "/etc/systemd/system/$unit"
  fi
  chown root:root "/etc/systemd/system/$unit"
  chmod 0644 "/etc/systemd/system/$unit"
done

# 6. Enable + start all three. `enable --now` is a no-op on an already-active
#    unit, so if this run just added a NEW agent to an already-populated
#    registry, the running daemon/monitor need an explicit restart to
#    actually pick up the new workspace -- otherwise the new agent's socket
#    silently never appears until the next unrelated restart.
systemctl daemon-reload
systemctl enable --now agent-enforcer.service agent-character-monitor.service agent-character-watchdog.service
if [ "$REGISTRY_HAD_OTHER_ENTRIES" = "true" ]; then
  echo ">> New agent added to an existing registry -- restarting enforcer + monitor to pick it up..."
  systemctl restart agent-enforcer.service agent-character-monitor.service
fi

echo ">> Done. Status:"
systemctl status agent-enforcer.service agent-character-monitor.service agent-character-watchdog.service --no-pager || true
echo
echo "Verify self-respawn:  sudo systemctl kill -s KILL agent-enforcer.service"
echo "                         -> it should return within ~3s (RestartSec=3)"
echo "Monitor and watchdog will auto-restart on failure (Restart=always, RestartSec=3)"
if [ "$SERVICE_USER" != "root" ] && [ -n "$AGENT_USER" ]; then
  echo
  echo "NOTE: '$AGENT_USER' was just added to the '$CLIENT_GROUP' group. Group"
  echo "membership only applies to NEW login sessions -- log out/in, or run"
  echo "\`newgrp $CLIENT_GROUP\` in the current shell, before testing the agent's"
  echo "connection to the socket."
fi
