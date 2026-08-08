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
VAR_DIR="$(dirname "$AGENT_WORKSPACE")"
# Fixed, independent of AGENT_WORKSPACE's nesting depth -- deliberately NOT
# derived from $VAR_DIR (dirname of AGENT_WORKSPACE). With agents nested
# under workspace/agents/<name>/, $VAR_DIR would resolve to
# .../workspace/agents, one level off from where agent_enforcer_daemon.js's
# resolveWorkspaces() and ack.js's checkAllSockets() both actually default
# to looking (/var/lib/agent-character-kit/workspaces.json) whenever
# ACK_WORKSPACES_REGISTRY isn't explicitly set -- which is the normal case
# for a human just running `ack status` by hand, not through systemd's env.
ACK_VAR_ROOT="${ACK_VAR_ROOT:-/var/lib/agent-character-kit}"
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
# $AGENT_WORKSPACE/.agent (holds the socket) is the one directory that needs
# cross-uid access: owned by the service user, GROUP-owned by the client
# group, with setgid (g+s, the "2" in 2750) so the socket file the daemon
# creates inside it inherits the client group automatically -- see
# agent_enforcer_daemon.js's own socket chmod (0660) for the other half of
# this. Everything else stays fully private to the service user; the agent
# only ever needs the socket, never direct file access (it's a thin RPC
# client, not a filesystem consumer of the workspace).
#
# `ls`/connect/open() on anything beneath a directory needs EXECUTE
# (traversal) on EVERY directory in the path, not just permission on the
# final file -- and $AGENT_WORKSPACE is nested arbitrarily deep under
# $ACK_VAR_ROOT (install.js's rootAgentWorkspace() always produces
# $ACK_VAR_ROOT/workspace/agents/<name>, three levels down). Wrong three
# times in a row tonight, each attempt fixing a real but incomplete subset:
# (1) derived the cross-uid dir from RUN_DIR="$(dirname "$ENFORCER_SOCKET")",
# which the daemon never even reads once a registry exists (it routes to
# startMultiWorkspaceDaemon(), which computes sockets from the workspace
# itself); (2) fixed $VAR_DIR (dirname of $AGENT_WORKSPACE, i.e. just ONE
# level up) and $AGENT_WORKSPACE directly, but left $ACK_VAR_ROOT itself
# untouched -- a SEPARATE, higher ancestor two levels further up when
# $AGENT_WORKSPACE is nested this deep, confirmed live via
# `namei -l .../claude.sock`: blocked at $ACK_VAR_ROOT
# (/var/lib/agent-character-kit) before traversal even reached $VAR_DIR.
# Fixed for real: walk EVERY directory level from $ACK_VAR_ROOT down to
# $AGENT_WORKSPACE (inclusive), granting the client group bare traversal
# (0710: owner rwx, group --x, other none -- no read, can't list contents
# or touch anything else) at each one, regardless of how many levels of
# nesting there are. Falls back to just fixing $AGENT_WORKSPACE's immediate
# parent if it somehow isn't nested under $ACK_VAR_ROOT at all (an
# unsupported override, not the real deployment shape), rather than ever
# touching an unrelated system directory.
install -d -o "$SERVICE_USER" -g "$CLIENT_GROUP" -m 0710 "$ACK_VAR_ROOT"
case "$AGENT_WORKSPACE" in
  "$ACK_VAR_ROOT"/*)
    rel="${AGENT_WORKSPACE#"$ACK_VAR_ROOT"/}"
    cur="$ACK_VAR_ROOT"
    IFS='/' read -ra _parts <<< "$rel"
    for _part in "${_parts[@]}"; do
      cur="$cur/$_part"
      install -d -o "$SERVICE_USER" -g "$CLIENT_GROUP" -m 0710 "$cur"
    done
    ;;
  *)
    install -d -o "$SERVICE_USER" -g "$CLIENT_GROUP" -m 0710 "$VAR_DIR"
    install -d -o "$SERVICE_USER" -g "$CLIENT_GROUP" -m 0710 "$AGENT_WORKSPACE"
    ;;
esac
install -d -o "$SERVICE_USER" -g "$SERVICE_GROUP" -m 0750 "$LOG_DIR"
install -d -o "$SERVICE_USER" -g "$SERVICE_GROUP" -m 0750 "$INSTALL_LIB"
install -d -o "$SERVICE_USER" -g "$CLIENT_GROUP" -m 2750 "$AGENT_WORKSPACE/.agent"

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
# NOT -R: a recursive chown here would reset the .agent DIRECTORY itself
# back to $SERVICE_GROUP, undoing its CLIENT_GROUP+setgid setup from above
# (a landmine found live, 2026-08-08 -- didn't trigger in that test only
# because $VAR_DIR/$AGENT_WORKSPACE blocked traversal first; would have
# been the next blocker once those were fixed). Only the two files this
# step just wrote need root-only ownership -- the agent must never be able
# to edit its own constraints (line ~153) -- the directory's own group
# stays exactly as line ~149 set it.
chown "$SERVICE_USER:$SERVICE_GROUP" "$AGENT_WORKSPACE/.agent/constitution.yaml" "$AGENT_WORKSPACE/.agent/enforcer.yaml"
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
REGISTRY="$ACK_VAR_ROOT/workspaces.json"
# $ACK_VAR_ROOT already created above (CLIENT_GROUP/0710, needed for socket
# traversal) -- NOT re-created here. This used to redundantly `install -d`
# it again with $SERVICE_GROUP/0750, clobbering that setup back to
# unreachable every single deploy (found live, 2026-08-08, same session as
# the traversal fix itself -- this was the reason that fix appeared not to
# work on the very next test).
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

# 5. Systemd unit (enforcer ONLY -- templated to the chosen service user,
#    self-respawning). The checked-in unit file hardcodes User=root/
#    Group=root as the safe default; sed-replace at deploy time rather than
#    maintaining a second set of near-duplicate unit files per privilege
#    mode. Exactly one instance regardless of how many agents are
#    registered -- the daemon tracks all of them itself, one agent doesn't
#    get a second instance.
#
#    Deliberately does NOT touch agent-character-monitor.service or
#    agent-character-watchdog.service (real fix, 2026-08-07 -- this script
#    used to write+enable those two units as well, despite never copying
#    ack_monitor.js/ack_watchdog.js anywhere; deploy-ack-services.sh is the
#    only script that actually installs those binaries, so it's the only
#    one that should own their unit files. The two scripts writing the
#    same units independently was real duplication that could silently
#    clobber each other's Environment lines.
unit=agent-enforcer.service
sed -e "s/^User=root$/User=$SERVICE_USER/" \
    -e "s/^Group=root$/Group=$SERVICE_GROUP/" \
    "$SRC_DIR/deploy/$unit" > "/etc/systemd/system/$unit"
# The checked-in unit file's Environment=AGENT_WORKSPACE/ENFORCER_SOCKET
# lines are placeholder defaults -- without this, every deploy silently
# ignored whatever $AGENT_WORKSPACE/$ENFORCER_SOCKET this specific run
# actually computed and used the checked-in literal instead, regardless of
# which agent was actually being deployed.
sed -i \
  -e "s|^Environment=AGENT_WORKSPACE=.*|Environment=AGENT_WORKSPACE=$AGENT_WORKSPACE|" \
  -e "s|^Environment=ENFORCER_SOCKET=.*|Environment=ENFORCER_SOCKET=$ENFORCER_SOCKET|" \
  "/etc/systemd/system/$unit"
# Explicit registry path -- more robust than relying on the daemon's own
# path-guessing fallback.
if ! grep -q "^Environment=ACK_WORKSPACES_REGISTRY=" "/etc/systemd/system/$unit"; then
  sed -i "/^\[Service\]/a Environment=ACK_WORKSPACES_REGISTRY=$REGISTRY" "/etc/systemd/system/$unit"
else
  sed -i "s|^Environment=ACK_WORKSPACES_REGISTRY=.*|Environment=ACK_WORKSPACES_REGISTRY=$REGISTRY|" "/etc/systemd/system/$unit"
fi
# Belt-and-suspenders: the daemon itself also explicitly chowns the socket
# to this group on every bind (agent_enforcer_daemon.js), independent of
# the directory-setgid mechanism above, so a client can still connect even
# if some future change to the directory setup regresses again.
if ! grep -q "^Environment=ACK_CLIENT_GROUP=" "/etc/systemd/system/$unit"; then
  sed -i "/^\[Service\]/a Environment=ACK_CLIENT_GROUP=$CLIENT_GROUP" "/etc/systemd/system/$unit"
else
  sed -i "s|^Environment=ACK_CLIENT_GROUP=.*|Environment=ACK_CLIENT_GROUP=$CLIENT_GROUP|" "/etc/systemd/system/$unit"
fi
chown root:root "/etc/systemd/system/$unit"
chmod 0644 "/etc/systemd/system/$unit"

# 6. Enable + start the enforcer. `enable --now` is a NO-OP on an
#    already-active unit -- it does NOT restart it, so it can never pick up
#    code/config/permission changes from this run (a fresh Environment= line,
#    a fixed socket-directory bug, an updated daemon binary, anything).
#    Found live, 2026-08-08: this used to only restart when
#    REGISTRY_HAD_OTHER_ENTRIES (a NEW agent joining an already-populated
#    registry) -- redeploying the SAME single agent to pick up a bugfix left
#    the old process running untouched for 9+ hours, silently undoing the
#    whole point of redeploying. Restart is now unconditional: running this
#    script at all means "make the live daemon match current code," full
#    stop -- RestartSec=3 already makes a restart's brief gap an expected,
#    tolerated event, so there's no safe case where skipping it is better.
systemctl daemon-reload
systemctl enable --now agent-enforcer.service
systemctl restart agent-enforcer.service
if systemctl is-active --quiet agent-character-monitor.service; then
  echo ">> Monitor is already deployed and active -- restarting it too, for the same reason..."
  systemctl restart agent-character-monitor.service
fi

echo ">> Done. Enforcer status:"
systemctl status agent-enforcer.service --no-pager || true
echo
echo "Verify self-respawn:  sudo systemctl kill -s KILL agent-enforcer.service"
echo "                         -> it should return within ~3s (RestartSec=3)"
if systemctl list-unit-files agent-character-monitor.service >/dev/null 2>&1 && \
   [ "$(systemctl is-enabled agent-character-monitor.service 2>/dev/null)" = "enabled" ]; then
  echo "Monitor + watchdog are already deployed (auto-restart on failure via Restart=always)."
else
  echo "Monitor + watchdog are NOT deployed yet -- acknowledgments won't be credited"
  echo "until you also run:  sudo bash deploy/deploy-ack-services.sh"
fi
if [ "$SERVICE_USER" != "root" ] && [ -n "$AGENT_USER" ]; then
  echo
  echo "NOTE: '$AGENT_USER' was just added to the '$CLIENT_GROUP' group. Group"
  echo "membership only applies to NEW login sessions -- log out/in, or run"
  echo "\`newgrp $CLIENT_GROUP\` in the current shell, before testing the agent's"
  echo "connection to the socket."
fi
