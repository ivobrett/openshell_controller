#!/usr/bin/env bash
# Prune the two kinds of agent state that grow without bound and make a
# NemoClaw backup impossible (its sanitiser caps structured state at 32 MiB):
#
#   Hermes   /sandbox/.hermes/sessions/request_dump_*.json — one debug dump per
#            failed inference call, each containing the request's auth header.
#   OpenClaw /sandbox/.openclaw/agents/*/sessions/<uuid>.* transcripts whose
#            session id is no longer referenced by that agent's sessions.json.
#
# DRY RUN by default. Deleting requires --apply AND a --backup-dir holding a
# `docker cp <container>:/sandbox` copy of the sandbox (as written by
# rollback-backup.sh); a file is only deleted if it exists in that copy.
#
# --dumps-only limits it to the Hermes failure dumps. Those are regenerable
# diagnostics, so with --dumps-only, --apply does not need a backup — this is
# the form to schedule (e.g. weekly) so they never pile up again.
#
#   prune-sandbox-state.sh [--days 30] [--backup-dir DIR --apply] [sandbox ...]
#   prune-sandbox-state.sh --dumps-only [--days 14] --apply
set -euo pipefail
. "$(dirname "$(readlink -f "$0")")/env.sh"
DAYS=30; APPLY=0; BACKUP=""; DUMPS_ONLY=0; NAMES=()
while [ $# -gt 0 ]; do case "$1" in
  --days) DAYS="$2"; shift 2 ;; --dumps-only) DUMPS_ONLY=1; shift ;; --apply) APPLY=1; shift ;; --backup-dir) BACKUP="$2"; shift 2 ;;
  -h|--help) sed -n '2,20p' "$0"; exit 0 ;; *) NAMES+=("$1"); shift ;; esac; done
[[ "$DAYS" =~ ^[0-9]+$ ]] || { echo "--days must be a number" >&2; exit 1; }
if [ "$APPLY" = 1 ] && [ "$DUMPS_ONLY" = 0 ] && [ ! -d "$BACKUP" ]; then echo "--apply requires --backup-dir <dir with <sandbox>/ copies of /sandbox>" >&2; exit 1; fi

for c in $(docker ps --format '{{.Names}}' | grep -E '^openshell-'); do
  name=$(echo "$c" | sed -E 's/^openshell-([a-z0-9][a-z0-9-]*--)?(.+)-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/\2/')
  if [ "${#NAMES[@]}" -gt 0 ] && [[ ! " ${NAMES[*]} " == *" $name "* ]]; then continue; fi
  list=$(mktemp)
  docker exec -i -u sandbox "$c" python3 - "$DAYS" "$DUMPS_ONLY" > "$list" <<'PY'
import glob, json, os, re, sys, time
cut = time.time() - int(sys.argv[1]) * 86400
uuid = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")
def old(p):
    st = os.lstat(p)
    return os.path.isfile(p) and not os.path.islink(p) and st.st_mtime < cut
stamp = re.compile(r"_(20\d{6})_(\d{6})_\d+\.json$")
def dump_is_old(p):
    # A NemoClaw restore resets mtimes, so trust the timestamp in the name.
    m = stamp.search(p)
    if m:
        try: return time.mktime(time.strptime(m.group(1) + m.group(2), "%Y%m%d%H%M%S")) < cut
        except ValueError: pass
    return old(p)
for p in glob.glob("/sandbox/.hermes/sessions/request_dump_*.json"):
    if os.path.isfile(p) and not os.path.islink(p) and dump_is_old(p): print(p)
for sessions in ([] if sys.argv[2] == "1" else glob.glob("/sandbox/.openclaw/agents/*/sessions")):
    index = os.path.join(sessions, "sessions.json")
    if not os.path.isfile(index): continue          # no index = nothing is provably orphaned
    try: live = set(uuid.findall(json.dumps(json.load(open(index)))))
    except Exception: continue
    for f in os.listdir(sessions):
        m = uuid.search(f)
        p = os.path.join(sessions, f)
        if m and m.group(0) not in live and old(p): print(p)
PY
  count=$(wc -l < "$list" | tr -d ' ')
  echo "$name: $count file(s) older than ${DAYS}d are prunable"
  if [ "$count" -gt 0 ] && [ "$APPLY" = 1 ]; then
    src="$BACKUP/$name"; missing=0; keep=$(mktemp)
    while IFS= read -r p; do
      case "$p" in /sandbox/.hermes/sessions/request_dump_*.json|/sandbox/.openclaw/agents/*/sessions/*) ;; *) continue ;; esac
      if [ "$DUMPS_ONLY" = 1 ] || [ -f "$src${p#/sandbox}" ]; then printf '%s\0' "$p" >> "$keep"; else missing=$((missing + 1)); fi
    done < "$list"
    if [ "$missing" -gt 0 ]; then echo "  $missing file(s) are not in $src and were left alone"; fi
    if [ -s "$keep" ]; then docker exec -i -u sandbox "$c" xargs -0 rm -f -- < "$keep"; echo "  deleted $(tr -cd '\0' < "$keep" | wc -c | tr -d ' ') file(s); list kept at $list"; fi
    rm -f "$keep"
  else
    if [ "$count" -gt 0 ]; then echo "  dry run — list at $list (add --apply to delete)"; else rm -f "$list"; fi
  fi
done
