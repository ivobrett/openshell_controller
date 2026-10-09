#!/usr/bin/env bash
# Read-only pre-flight for a live NemoClaw / OpenShell upgrade. Changes nothing.
#
#   sudo /opt/openshell-controller/scripts/upgrade/preflight.sh
#
# Every check here is something that stopped or damaged the 2026-10-09 Oracle
# BYOVPS upgrade (docs/runbooks/live-openshell-bump-with-agent-upgrade.md).
# Exit status: 0 = no blockers, 1 = at least one BLOCK finding.
set -uo pipefail
. "$(dirname "$(readlink -f "$0")")/env.sh"

REPO="$(cd "$(dirname "$(readlink -f "$0")")/../.." && pwd)"
REGISTRY=/root/.nemoclaw/sandboxes.json
# NemoClaw's backup sanitiser refuses more than 32 MiB of .json/.yaml/.env
# content or 100k entries per sandbox (snapshot-sanitizer-boundary.ts).
STRUCTURED_CAP_BYTES=$((32 * 1024 * 1024))
ENTRY_CAP=100000
blocks=0; warns=0
ok()    { printf '  \033[32mok\033[0m     %s\n' "$*"; }
warn()  { printf '  \033[33mWARN\033[0m   %s\n' "$*"; warns=$((warns + 1)); }
block() { printf '  \033[31mBLOCK\033[0m  %s\n' "$*"; blocks=$((blocks + 1)); }
section() { printf '\n== %s\n' "$*"; }

section "Host"
if systemctl --user show-environment >/dev/null 2>&1; then ok "systemd user manager reachable"; else block "systemctl --user is unreachable (XDG_RUNTIME_DIR=$XDG_RUNTIME_DIR) — run 'loginctl enable-linger root' and source scripts/upgrade/env.sh"; fi
if command -v lsof >/dev/null 2>&1; then ok "lsof installed"; else block "lsof is missing — NemoClaw's gateway-port probe needs it (apt-get install -y lsof)"; fi
avail_gb=$(df -BG --output=avail / | tail -1 | tr -dc '0-9')
if [ "${avail_gb:-0}" -ge 30 ]; then ok "free disk: ${avail_gb}G"; else warn "only ${avail_gb}G free — rollback copies, backups and image builds need ~30G"; fi

section "Versions"
pin_os=$(grep -oE '^OPENSHELL_VERSION="\$\{OPENSHELL_VERSION:-v?[0-9.]+' "$REPO/install_versioned_nemoclaw_openshell.sh" | grep -oE '[0-9]+\.[0-9]+\.[0-9]+$')
pin_nc=$(grep -oE 'NEMOCLAW_INSTALL_TAG:-[^}]+' "$REPO/install_versioned_nemoclaw_openshell.sh" | head -1 | cut -d- -f2-)
cur_os=$(openshell --version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1)
cur_nc=$(git -C /opt/nemoclaw-src log -1 --format=%h 2>/dev/null || echo unknown)
echo "  OpenShell: installed ${cur_os:-none}, pin ${pin_os:-?}    NemoClaw: installed ${cur_nc}, pin ${pin_nc:-?}"
for b in openshell-gateway openshell-sandbox; do
  v=$("$b" --version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1)
  [ "$v" = "$cur_os" ] || block "$b is ${v:-missing} but openshell is $cur_os — the three binaries must match"
done
if [ -n "$pin_os" ] && [ "$cur_os" != "$pin_os" ]; then
  warn "OpenShell pin differs → this is the DESTRUCTIVE window: every sandbox is recreated. Use live-openshell-bump-with-agent-upgrade.md, never the bare installer"
else
  ok "OpenShell already at the pin — pass --skip-openshell to the installer"
fi
if [ -n "$(git -C /opt/nemoclaw-src status --porcelain -- agents ci 2>/dev/null)" ]; then
  warn "/opt/nemoclaw-src has hand-applied changes under agents/ or ci/ — the installer re-clones and discards them"
fi

section "Gateway"
if openshell sandbox list >/dev/null 2>&1; then ok "gateway reachable"; else block "gateway unreachable — 'systemctl --user start openshell-gateway.service' (recover no longer starts it on NemoClaw >= v0.0.130)"; fi
pidf=/root/.local/state/nemoclaw/openshell-docker-gateway/openshell-gateway.pid
if [ -f "$pidf" ] && kill -0 "$(cat "$pidf" 2>/dev/null)" 2>/dev/null && [ -n "$pin_os" ] && [ "$cur_os" != "$pin_os" ]; then
  warn "live gateway PID file present: the installer WILL retire the gateway unattended once its backup passes. Move $pidf aside for a controlled run"
fi
route_provider=$(openshell inference get 2>/dev/null | sed 's/\x1b\[[0-9;]*m//g' | awk '/Provider:/{print $2; exit}')
route_model=$(openshell inference get 2>/dev/null | sed 's/\x1b\[[0-9;]*m//g' | awk '/Model:/{print $2; exit}')
echo "  live inference route: ${route_provider:-?} / ${route_model:-?}"

section "Registry vs gateway"
if [ -f "$REGISTRY" ]; then
  live_names=$(openshell sandbox list 2>/dev/null | sed 's/\x1b\[[0-9;]*m//g' | awk 'NR>1{print $1" "$NF}')
  while IFS=$'\t' read -r kind msg; do
    case "$kind" in ok) ok "$msg" ;; warn) warn "$msg" ;; block) block "$msg" ;; esac
  done < <(ROUTE_PROVIDER="$route_provider" ROUTE_MODEL="$route_model" LIVE="$live_names" python3 - "$REGISTRY" <<'PY'
import json, os, sys
rows = json.load(open(sys.argv[1])).get("sandboxes", {})
live = dict(l.split() for l in os.environ.get("LIVE", "").splitlines() if len(l.split()) == 2)
rp, rm = os.environ.get("ROUTE_PROVIDER", ""), os.environ.get("ROUTE_MODEL", "")
for name, row in rows.items():
    missing = [k for k in ("provider", "model", "endpointUrl", "credentialEnv", "preferredInferenceApi") if not row.get(k)]
    if missing:
        print(f"block\t{name}: registry row lacks {missing} — one such row blocks every create/recover")
    if rp and row.get("provider") and row["provider"] != rp:
        print(f"block\t{name}: registry says provider '{row['provider']}' but the gateway routes to '{rp}' — a recreate re-applies the ROW. Patch the row first")
    elif rm and row.get("model") and row["model"] != rm:
        print(f"warn\t{name}: registry model '{row['model']}' differs from the live route '{rm}'")
    phase = live.get(name)
    if phase is None:
        print(f"block\t{name}: registered but absent from the gateway — backup-all will skip it and the strict pre-upgrade backup fails")
    elif phase != "Ready":
        print(f"block\t{name}: phase {phase} — backup/exec/stop/start are all refused until it is Ready (Error is sticky: recreate)")
    else:
        print(f"ok\t{name}: Ready, route metadata complete ({row.get('agent') or 'openclaw'} {row.get('agentVersion')})")
for name in live:
    if name not in rows:
        print(f"warn\t{name}: on the gateway but not in the NemoClaw registry")
PY
)
  cred_env=$(python3 -c "import json;print(' '.join(sorted({r.get('credentialEnv') or '' for r in json.load(open('$REGISTRY')).get('sandboxes',{}).values()})))" 2>/dev/null)
  if [ -n "$route_provider" ]; then
    provider_dump=$(openshell provider get "$route_provider" 2>/dev/null | sed 's/\x1b\[[0-9;]*m//g')
    for c in $cred_env; do
      if printf '%s' "$provider_dump" | grep -q "$c"; then ok "provider '$route_provider' exposes $c"; else block "provider '$route_provider' has no credential named $c — rebuild preflight refuses. openshell provider update $route_provider --credential $c=…"; fi
    done
  fi
else
  warn "no NemoClaw registry at $REGISTRY"
fi

section "Sandbox state (what the NemoClaw backup has to digest)"
for c in $(docker ps --format '{{.Names}}' | grep -E '^openshell-'); do
  name=$(echo "$c" | sed -E 's/^openshell-([a-z0-9][a-z0-9-]*--)?(.+)-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/\2/')
  echo "  -- $name"
  stats=$(docker exec -u sandbox "$c" sh -c '
    for d in /sandbox/.openclaw /sandbox/.hermes; do [ -d "$d" ] || continue
      s=$(find "$d" -xdev -type f \( -name "*.json" -o -name "*.yaml" -o -name "*.yml" -o -name ".env" -o -name "*.env" \) -not -path "*/node_modules/*" -printf "%s\n" 2>/dev/null | awk "{t+=\$1} END{print t+0}")
      n=$(find "$d" -xdev 2>/dev/null | wc -l)
      echo "$d $s $n $(du -sm "$d" 2>/dev/null | cut -f1)"
    done
    echo "dumps $(ls /sandbox/.hermes/sessions 2>/dev/null | grep -c "^request_dump_")"
    echo "rawenv $(grep -cE "^[A-Z_]*(TOKEN|SECRET|PASSWORD)[A-Z_]*=.{12,}" /sandbox/.hermes/.env 2>/dev/null || true)"
    echo "rawcfg $(grep -cE "[0-9]{8,10}:[A-Za-z0-9_-]{30,}" /sandbox/.hermes/config.yaml 2>/dev/null || true)"
    echo "mcp $(grep -c "\"openshell-control\"" /sandbox/.openclaw/openclaw.json 2>/dev/null || true)"
    echo "loose $(ls -A /sandbox 2>/dev/null | grep -vxE "\.openclaw|\.hermes|\.nemoclaw|\.bashrc|\.profile|\.cache|\.npm|\.local|tmp" | wc -l)"
  ' 2>/dev/null)
  while read -r key a b cmb; do
    case "$key" in
      /sandbox/*)
        # An estimate: it counts the whole agent home, the backup only its
        # manifest state dirs. Well over the cap is certain failure; just over
        # needs `nemoclaw backup-all` to say for sure.
        if [ "${a:-0}" -gt $((STRUCTURED_CAP_BYTES * 4)) ]; then block "$key holds ~$((a / 1048576)) MiB of JSON/YAML (backup cap 32 MiB) — 'Credential sanitization failed'. Run scripts/upgrade/prune-sandbox-state.sh"
        elif [ "${a:-0}" -gt "$STRUCTURED_CAP_BYTES" ]; then warn "$key holds ~$((a / 1048576)) MiB of JSON/YAML, near the 32 MiB backup cap — confirm with 'nemoclaw backup-all'; prune if it fails"
        else ok "$key structured state ~$((a / 1048576)) MiB of 32, ${cmb:-?} MiB total"; fi
        [ "${b:-0}" -gt "$ENTRY_CAP" ] && block "$key has $b entries (cap $ENTRY_CAP)" ;;
      dumps)  [ "${a:-0}" -gt 200 ] && warn "$a Hermes request_dump_*.json failure dumps (each carries an Authorization header) — prune them" ;;
      rawenv) [ "${a:-0}" -gt 0 ] && block "raw secret in .hermes/.env — Hermes >= 0.21 refuses to start; a failed start leaves the sandbox in a sticky Error phase" ;;
      rawcfg) [ "${a:-0}" -gt 0 ] && block "raw bot token in .hermes/config.yaml — remove it before any gateway restart" ;;
      mcp)    [ "${a:-0}" -gt 0 ] && warn "openclaw.json carries the controller's 'openshell-control' MCP entry — NemoClaw rebuild rejects it ('no complete authenticated credential binding'); see fix-rebuild-backup.sh" ;;
      loose)  [ "${a:-0}" -gt 0 ] && warn "$a item(s) in /sandbox outside the managed state dir are NOT restored by a recreate — they come back only from the docker cp copy" ;;
    esac
  done <<<"$stats"
done

section "Leaked controller tunnels"
leaked=0
for p in $(pgrep -f 'ssh -o BatchMode=yes.*-N -L 127.0.0.1' 2>/dev/null); do [ "$(ps -o ppid= -p "$p" | tr -d ' ')" = 1 ] && leaked=$((leaked + 1)); done
if [ "$leaked" -gt 0 ]; then warn "$leaked orphaned dashboard tunnel(s) hold in-sandbox SSH slots ('SSH endpoint did not answer' during backup) — kill the ppid-1 ones"; else ok "none"; fi

printf '\n%s blocker(s), %s warning(s)\n' "$blocks" "$warns"
[ "$blocks" -eq 0 ]
