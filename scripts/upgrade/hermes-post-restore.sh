#!/usr/bin/env bash
# Finish a Hermes rebuild / prepared-backup recovery. NemoClaw restores state
# AFTER the new Hermes gateway has booted, which leaves two things broken:
#
#   1. state.db was replaced underneath the running gateway, which then refuses
#      to use it: "This session's history is temporarily unavailable … inspect
#      state.db". The database is fine; the gateway must reopen it.
#   2. Approved messaging users are unknown ("Unauthorized user: … on telegram").
#      Hermes >= 0.21 reads .hermes/platforms/pairing/, the restore puts the
#      store back at the older .hermes/pairing/.
#
# It also refuses to restart Hermes while a raw secret sits in .env or
# config.yaml: Hermes >= 0.21 will not start with one, and a failed start
# leaves the sandbox in OpenShell's sticky Error phase (recreate to clear).
#
#   hermes-post-restore.sh <sandbox-name>
set -euo pipefail
. "$(dirname "$(readlink -f "$0")")/env.sh"
NAME="${1:?sandbox name}"
C=$(docker ps --format '{{.Names}}' | grep -E "^openshell-([a-z0-9][a-z0-9-]*--)?${NAME}-[0-9a-f]{8}-" | head -1)
[ -n "$C" ] || { echo "no running container for sandbox $NAME" >&2; exit 1; }
raw=$(docker exec "$C" sh -c 'a=$(grep -cE "^[A-Z_]*(BOT_TOKEN|SECRET|PASSWORD)[A-Z_]*=.{12,}" /sandbox/.hermes/.env 2>/dev/null); b=$(grep -cE "[0-9]{8,10}:[A-Za-z0-9_-]{30,}" /sandbox/.hermes/config.yaml 2>/dev/null); echo $(( ${a:-0} + ${b:-0} ))')
if [ "${raw:-0}" -gt 0 ]; then
  echo "raw secret found in /sandbox/.hermes/.env or config.yaml — remove it first (credentials belong in the OpenShell provider: nemoclaw $NAME channels add <channel>)." >&2
  exit 1
fi
docker exec -u sandbox "$C" sh -c '
  cd /sandbox/.hermes || exit 0
  [ -d pairing ] || exit 0
  mkdir -p platforms/pairing
  for f in pairing/*-approved.json; do
    [ -f "$f" ] || continue
    t="platforms/pairing/$(basename "$f")"
    [ -f "$t" ] || { cp -p "$f" "$t" && chmod 600 "$t" && echo "restored approved users: $(basename "$f")"; }
  done'
nemoclaw "$NAME" gateway restart
