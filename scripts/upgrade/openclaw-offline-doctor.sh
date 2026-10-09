#!/usr/bin/env bash
# Start a STOPPED OpenClaw sandbox through NemoClaw's post-upgrade doctor
# handshake, so `openclaw doctor --fix` migrates older state BEFORE the gateway
# launches. Without it OpenClaw >= 2026.9 exits on old state ("Legacy workspace
# setup state requires migration … run openclaw doctor --fix"), the container's
# main process dies, and OpenShell leaves the sandbox in a sticky Error phase.
#
# Use after copying state from an older OpenClaw into a freshly created sandbox:
#   nemoclaw <name> stop
#   tar -C <state-dir> --owner=<uid> --group=<gid> --numeric-owner -cf - agents workspace … \
#     | docker cp - <container>:/sandbox/.openclaw/
#   openclaw-offline-doctor.sh <name>
set -euo pipefail
. "$(dirname "$(readlink -f "$0")")/env.sh"
NAME="${1:?sandbox name}"
C=$(docker ps -a --format '{{.Names}}' | grep -E "^openshell-([a-z0-9][a-z0-9-]*--)?${NAME}-[0-9a-f]{8}-" | head -1)
[ -n "$C" ] || { echo "no container for sandbox $NAME" >&2; exit 1; }
[ "$(docker inspect -f '{{.State.Running}}' "$C")" = false ] || { echo "$NAME is running — stop it first: nemoclaw $NAME stop" >&2; exit 1; }
# The marker must be a 0600 single-link regular file owned by the owner of
# /sandbox/.openclaw, or nemoclaw-start refuses it and the start fails.
owner=$(docker export "$C" | tar -tvf - --numeric-owner sandbox/.openclaw/ 2>/dev/null | head -1 | awk '{print $2}')
uid=${owner%%/*}; gid=${owner##*/}
[[ "$uid" =~ ^[0-9]+$ ]] || { echo "could not determine the owner of /sandbox/.openclaw" >&2; exit 1; }
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
printf 'nemoclaw-openclaw-post-upgrade-doctor-v2\n' > "$tmp/.nemoclaw-post-upgrade-doctor"; chmod 600 "$tmp/.nemoclaw-post-upgrade-doctor"
tar -C "$tmp" --owner="$uid" --group="$gid" --numeric-owner -cf - .nemoclaw-post-upgrade-doctor | docker cp - "$C:/sandbox/.openclaw/"

( nemoclaw "$NAME" start >/dev/null 2>&1 || true ) &
echo "starting $NAME; waiting for the offline doctor…"
for _ in $(seq 1 200); do
  sleep 3
  docker ps --format '{{.Names}}' | grep -qx "$C" || continue
  if docker exec "$C" grep -qE 'Refusing .*post-upgrade doctor marker' /tmp/nemoclaw-start.log 2>/dev/null; then echo "marker refused — see /tmp/nemoclaw-start.log in the container" >&2; exit 1; fi
  docker exec "$C" grep -q 'post-upgrade doctor completed' /tmp/nemoclaw-start.log 2>/dev/null && break
done
docker exec "$C" grep -q 'post-upgrade doctor completed' /tmp/nemoclaw-start.log || { echo "doctor did not complete; the gateway is still held (the marker times out after 10 min)" >&2; exit 1; }
# Release the gateway: replace the marker atomically, as the sandbox user.
docker exec -u "$uid" "$C" sh -c 'umask 077; d=/sandbox/.openclaw; t=$(mktemp "$d/.nemoclaw-post-upgrade-doctor.XXXXXX") && printf "nemoclaw-openclaw-post-upgrade-doctor-release-v1\n" > "$t" && chmod 600 "$t" && mv -f "$t" "$d/.nemoclaw-post-upgrade-doctor"'
for _ in $(seq 1 60); do sleep 3; docker exec "$C" sh -c 'tail -n 8 /tmp/gateway.log 2>/dev/null | grep -q "\[gateway\] ready"' && break; done
wait || true
openshell sandbox list | sed 's/\x1b\[[0-9;]*m//g' | awk -v n="$NAME" '$1==n{print n": "$NF}'
