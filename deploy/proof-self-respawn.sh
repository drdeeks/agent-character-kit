#!/usr/bin/env bash
#
# proof-self-respawn.sh — empirically demonstrate the enforcer daemon
# self-respawns within RestartSec=3 after a hard kill (-9).
#
# Uses `systemctl --user` (no root needed). The same RestartSec=3 semantics
# apply identically under the root-owned /etc/systemd/system unit.
set -uo pipefail

# Self-resolving: repo root comes from $ACK_REPO (default: current dir), not a
# hardcoded path. The proof service reads $ACK_DAEMON_BIN for the daemon binary.
REPO="${ACK_REPO:-$PWD}"
SVC_SRC="$REPO/deploy/agent-enforcer-proof.service"
export ACK_DAEMON_BIN="${ACK_DAEMON_BIN:-$REPO/node/enforcer/agent_enforcer_daemon.js}"

UNIT="agent-enforcer-proof.service"
XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
export XDG_RUNTIME_DIR

echo ">> Installing user unit..."
mkdir -p "$HOME/.config/systemd/user"
cp "$SVC_SRC" "$HOME/.config/systemd/user/"
systemctl --user daemon-reload

echo ">> Starting daemon..."
systemctl --user start "$UNIT"
sleep 2

echo ">> First PID:"
PID1=$(systemctl --user show -p MainPID --value "$UNIT")
echo "   $PID1"
[ "$PID1" -gt 0 ] || { echo "FAIL: daemon did not start"; exit 1; }

echo ">> KILL -9 (simulating crash / tamper)..."
kill -9 "$PID1"
sleep 1
PID_MID=$(systemctl --user show -p MainPID --value "$UNIT")
echo "   immediately after kill, MainPID=$PID_MID (0 = still restarting)"

echo ">> Waiting for self-respawn (RestartSec=3)..."
START=$(date +%s.%N)
for i in $(seq 1 20); do
  PID2=$(systemctl --user show -p MainPID --value "$UNIT")
  if [ "$PID2" -gt 0 ] && [ "$PID2" != "$PID1" ]; then
    END=$(date +%s.%N)
    DELTA=$(echo "$END - $START" | bc 2>/dev/null || awk "BEGIN{print $END-$START}")
    echo ">> RESPAWNED: new PID=$PID2  after ${DELTA}s"
    if awk "BEGIN{exit !($DELTA <= 5)}"; then
      echo "RESULT: PASS — respawned within 5s (target 3-5s)"
      exit 0
    else
      echo "RESULT: FAIL — respawn took >5s"
      exit 1
    fi
  fi
  sleep 0.5
done
echo "RESULT: FAIL — daemon did not respawn"
exit 1
