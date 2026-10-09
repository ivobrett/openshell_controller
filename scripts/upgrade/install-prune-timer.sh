#!/usr/bin/env bash
# Install a weekly systemd timer that prunes Hermes failure dumps
# (/sandbox/.hermes/sessions/request_dump_*.json older than 14 days) from every
# running sandbox, via prune-sandbox-state.sh --dumps-only.
#
# Why: Hermes writes one dump per failed inference call, each containing the
# request's Authorization header. A cron job retrying into a rate limit or an
# expired key produces thousands (26,700 / 554 MiB on the Oracle BYOVPS by
# 2026-10-09), which pushes the sandbox past NemoClaw's 32 MiB backup cap and
# blocks every later upgrade. Nothing else is touched: chat sessions, state.db
# and OpenClaw transcripts are left alone. Idempotent; run as root.
#
#   install-prune-timer.sh            install / refresh and enable
#   install-prune-timer.sh --remove   disable and remove
set -euo pipefail
SCRIPT="$(dirname "$(readlink -f "$0")")/prune-sandbox-state.sh"
UNIT=openshell-prune-hermes-dumps
if [ "${1:-}" = "--remove" ]; then
  systemctl disable --now "$UNIT.timer" 2>/dev/null || true
  rm -f "/etc/systemd/system/$UNIT.service" "/etc/systemd/system/$UNIT.timer"
  systemctl daemon-reload
  echo "removed $UNIT"
  exit 0
fi
[ -x "$SCRIPT" ] || { echo "missing $SCRIPT" >&2; exit 1; }
cat > "/etc/systemd/system/$UNIT.service" <<UNIT_EOF
[Unit]
Description=Prune Hermes failed-request dumps from OpenShell sandboxes
After=docker.service

[Service]
Type=oneshot
ExecStart=$SCRIPT --dumps-only --days 14 --apply
UNIT_EOF
cat > "/etc/systemd/system/$UNIT.timer" <<UNIT_EOF
[Unit]
Description=Weekly prune of Hermes failed-request dumps

[Timer]
OnCalendar=weekly
RandomizedDelaySec=1h
Persistent=true

[Install]
WantedBy=timers.target
UNIT_EOF
systemctl daemon-reload
systemctl enable --now "$UNIT.timer" >/dev/null
echo "installed $UNIT.timer (weekly; dumps older than 14 days)"
