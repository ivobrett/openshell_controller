#!/usr/bin/env bash
# Take everything needed to put a gateway host back the way it was before a
# NemoClaw / OpenShell upgrade. Non-destructive; run while sandboxes are Ready.
#
#   rollback-backup.sh [backup-dir]        (default /root/backups/<date>-pre-upgrade)
#
# Captures: the three OpenShell binaries, gateway + CLI state, the NemoClaw
# registry, the installed NemoClaw source (the installer `rm -rf`s it — it IS
# the old CLI), controller env/unit, and a `docker cp` of every sandbox's
# /sandbox. After the gateway is stopped, run it again with --quiesced to add
# a consistent copy and a `docker commit` image of each stopped container.
set -euo pipefail
. "$(dirname "$(readlink -f "$0")")/env.sh"
QUIESCED=0; [ "${1:-}" = "--quiesced" ] && { QUIESCED=1; shift; }
B="${1:-/root/backups/$(date +%F)-pre-upgrade}"
mkdir -p "$B"/{bin,state,sandbox}; chmod 700 "$B"
if [ "$QUIESCED" = 1 ]; then suffix=quiesced; ps_cmd="docker ps -a"; dest_suffix="-quiesced"; else suffix=live; ps_cmd="docker ps"; dest_suffix=""; fi

if [ "$QUIESCED" = 0 ]; then
  { date -u; echo "controller $(git -C /opt/openshell-controller rev-parse HEAD 2>/dev/null)"; echo "nemoclaw-src $(git -C /opt/nemoclaw-src rev-parse HEAD 2>/dev/null)"
    openshell --version; openshell-gateway --version; openshell-sandbox --version
    docker ps -a --no-trunc; openshell sandbox list; openshell provider list; openshell inference get; nemoclaw list; } > "$B/inventory.txt" 2>&1 || true
  docker inspect $(docker ps -aq --filter name=openshell-) > "$B/docker-inspect.json" 2>/dev/null || true
  for b in openshell openshell-gateway openshell-sandbox; do p=$(command -v "$b" || true); [ -n "$p" ] && cp -a "$p" "$B/bin/"; done
  tar -C /opt -czf "$B/state/nemoclaw-src.tgz" nemoclaw-src 2>/dev/null || true
  cp -a /opt/openshell-controller/.env.local "$B/state/controller.env.local" 2>/dev/null || true
  cp -a /etc/systemd/system/openshell-controller.service "$B/state/" 2>/dev/null || true
  [ -d /etc/openshell ] && tar -C / -czf "$B/state/etc-openshell.tgz" etc/openshell
fi
tar -C /root -czf "$B/state/dot-nemoclaw-$suffix.tgz" --exclude='.nemoclaw/rebuild-backups' .nemoclaw
tar -C /root -czf "$B/state/local-state-nemoclaw-$suffix.tgz" --exclude='*.log' .local/state/nemoclaw
tar -C /root -czf "$B/state/local-state-openshell-$suffix.tgz" .local/state/openshell 2>/dev/null || true
tar -C /root -czf "$B/state/config-openshell-$suffix.tgz" .config/openshell

for c in $($ps_cmd --format '{{.Names}}' | grep -E '^openshell-'); do
  name=$(echo "$c" | sed -E 's/^openshell-([a-z0-9][a-z0-9-]*--)?(.+)-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/\2/')
  dest="$B/sandbox/$name$dest_suffix"
  rm -rf "$dest"; docker cp -a "$c":/sandbox "$dest"
  if [ "$QUIESCED" = 1 ]; then docker commit "$c" "rollback/$name:$(date +%F)" >/dev/null; fi
  echo "$name -> $dest ($(du -sh "$dest" | cut -f1))"
done
for f in "$B"/state/*.tgz; do gzip -t "$f"; done
chmod -R go-rwx "$B"
echo "rollback set: $B ($(du -sh "$B" | cut -f1))"
