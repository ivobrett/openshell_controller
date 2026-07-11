#!/bin/bash
# Idempotent Hermes dashboard (re)launcher for one sandbox.
#
# Usage: launch.sh <sandbox-name>
#
# Reads port + session token from /etc/openshell/hermes-access/<sandbox>.json
# (written by expose.sh). Safe to re-run any time: short-circuits when the
# dashboard already answers on its port. Re-discovers the container and the
# gateway PID on every run, so it survives sandbox/container restarts (the
# gateway netns changes identity on every restart — see plan risk #11).
#
# Invoked by: expose.sh (first launch), watchdog.sh (periodic self-heal).

TAG="[hermes-remote-launch]"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "$SCRIPT_DIR/lib.sh"

SANDBOX="${1:-}"
[ -n "$SANDBOX" ] || die "usage: launch.sh <sandbox-name>"

PORT=$(read_access_field "$SANDBOX" port) || die "no access file for '$SANDBOX' — run expose.sh first"
TOKEN=$(read_access_field "$SANDBOX" token) || die "no token in access file for '$SANDBOX'"
[ -n "$PORT" ] && [ -n "$TOKEN" ] || die "access file for '$SANDBOX' is missing port/token"

CONTAINER=$(find_sandbox_container "$SANDBOX")
[ -n "$CONTAINER" ] || die "no running container matching ^openshell-${SANDBOX}- (sandbox stopped?)"

GW_PID=$(find_gateway_pid "$CONTAINER")
[ -n "$GW_PID" ] || die "no 'hermes gateway run' process in $CONTAINER — is this a Hermes sandbox, and is the gateway up?"

# ── Short-circuit when healthy ───────────────────────────────────
if nsenter_sandbox "$CONTAINER" "$GW_PID" curl -sf -m 4 "http://127.0.0.1:${PORT}/api/status" >/dev/null 2>&1; then
  log "dashboard already serving on port $PORT — nothing to do"
  exit 0
fi

# ── Hermes >=0.16 requires API_SERVER_KEY for the gateway api_server ─
# Provision BEFORE any upgrade/restart: upgrade-hermes.sh restarts the
# gateway, which fails immediately on 0.16 if the key is absent.
# (0.14 starts without it; the key is harmless there.) The config dir is
# integrity-hash-pinned, so after editing .env we re-pin the hash exactly the
# way shields-up does, or the next container restart fails verification.
if ! docker exec "$CONTAINER" grep -q '^API_SERVER_KEY=' /sandbox/.hermes/.env 2>/dev/null; then
  log "provisioning API_SERVER_KEY in sandbox .env"
  API_KEY=$(openssl rand -hex 24)
  docker exec "$CONTAINER" sh -c "
    printf '\nAPI_SERVER_KEY=${API_KEY}\n' >> /sandbox/.hermes/.env
    chown sandbox:sandbox /sandbox/.hermes/.env
    sha256sum /sandbox/.hermes/config.yaml /sandbox/.hermes/.env > /etc/nemoclaw/hermes.config-hash.new
    chmod 444 /etc/nemoclaw/hermes.config-hash.new
    mv -f /etc/nemoclaw/hermes.config-hash.new /etc/nemoclaw/hermes.config-hash
  " || die "failed to provision API_SERVER_KEY / re-pin config hash"
fi

# ── Hermes >=0.16 required (HERMES_DASHBOARD_SESSION_TOKEN pinning) ─
# NemoClaw's base image ships 0.14.x; upgrade in place (proven recipe in
# upgrade-hermes.sh). Re-resolve the gateway PID afterwards — the upgrade
# restarts the gateway, which changes its PID and netns identity.
current=$(docker exec "$CONTAINER" /opt/hermes/.venv/bin/hermes --version 2>/dev/null | head -1 | grep -oE 'v[0-9]+\.[0-9]+' | tr -d v)
if [ -z "$current" ] || ! python3 -c "import sys; sys.exit(0 if tuple(map(int,'$current'.split('.'))) >= (0,16) else 1)"; then
  log "hermes ${current:-unknown} < 0.16 — upgrading in-sandbox"
  "$SCRIPT_DIR/upgrade-hermes.sh" "$SANDBOX" || die "hermes upgrade failed"
  GW_PID=$(find_gateway_pid "$CONTAINER")
  [ -n "$GW_PID" ] || die "gateway missing after hermes upgrade"
fi

# ── (Re)launch ───────────────────────────────────────────────────
docker exec "$CONTAINER" pkill -f 'hermes_cli.main dashboard' 2>/dev/null
docker exec "$CONTAINER" pkill -f "TCP-LISTEN:${PORT}," 2>/dev/null
sleep 2

# Notes carried over from the validated single-tenant launcher + POC:
#  * nsenter into the gateway netns: inference.local only resolves there.
#  * su (not ssh) to the sandbox user: avoids OpenShell's extra SSH seccomp
#    filters which break os.openpty() for the embedded chat PTY.
#  * source /tmp/nemoclaw-proxy-env.sh: HTTPS_PROXY + CA bundle + HERMES_HOME.
#  * HERMES_DASHBOARD_SESSION_TOKEN pins the session token (>=0.16) so it
#    survives restarts; the desktop app keeps its saved credential.
#
# Hermes >=0.18 (June 2026 hardening): --insecure is a NO-OP and any
# non-loopback bind hard-refuses to start without a registered auth
# provider ("There is no unauthenticated public-bind option"). So the
# dashboard now binds 127.0.0.1 on an internal port and a socat forwarder
# publishes it on ${PORT} — the exact pattern nemoclaw-start uses for its
# own dashboard (loopback 19119 behind socat 18789). Consequences:
#  * _ws_client_is_allowed: loopback bind accepts only loopback peers —
#    satisfied, the socat hop makes every peer 127.0.0.1.
#  * Host/Origin guards: loopback binds require loopback-shaped Host and
#    Origin headers, so every proxy hop we own rewrites them to
#    127.0.0.1:${PORT} (Traefik middleware in expose.sh, the HTTP proxy
#    route, the server.mjs WS tunnel). Backward compatible with 0.16/0.17.
INTERNAL_PORT=$((PORT + 1))
docker exec -d --privileged "$CONTAINER" nsenter -t "$GW_PID" -n -- \
  su -s /bin/bash sandbox -c ". /tmp/nemoclaw-proxy-env.sh 2>/dev/null; export HOME=/sandbox HERMES_HOME=/sandbox/.hermes HERMES_DASHBOARD_SESSION_TOKEN='${TOKEN}'; cd /sandbox; exec /opt/hermes/.venv/bin/python -m hermes_cli.main dashboard --host 127.0.0.1 --port ${INTERNAL_PORT} --skip-build --no-open > /tmp/hermes-dashboard.log 2>&1" \
  || die "docker exec failed launching dashboard"

# ── Wait for readiness, then verify the auth gate ────────────────
ready=0
for _ in $(seq 1 30); do
  sleep 2
  if nsenter_sandbox "$CONTAINER" "$GW_PID" curl -sf -m 4 "http://127.0.0.1:${INTERNAL_PORT}/api/status" >/dev/null 2>&1; then
    # Token gate sanity: a bogus token must be rejected on a protected route.
    code=$(nsenter_sandbox "$CONTAINER" "$GW_PID" curl -s -m 4 -o /dev/null -w '%{http_code}' \
      -H 'X-Hermes-Session-Token: bogus' "http://127.0.0.1:${INTERNAL_PORT}/api/config" 2>/dev/null)
    [ "$code" = "401" ] || die "auth gate not engaged (got $code for bogus token) — refusing to expose"
    ready=1
    break
  fi
done
if [ "$ready" != "1" ]; then
  docker exec "$CONTAINER" tail -5 /tmp/hermes-dashboard.log >&2 2>/dev/null
  die "dashboard did not become ready on internal port $INTERNAL_PORT within 60s"
fi

# ── Publish loopback dashboard on ${PORT} via socat ───────────────
docker exec -d --privileged "$CONTAINER" nsenter -t "$GW_PID" -n -- \
  su -s /bin/bash sandbox -c "exec socat TCP-LISTEN:${PORT},bind=0.0.0.0,fork,reuseaddr TCP:127.0.0.1:${INTERNAL_PORT} > /tmp/hermes-dashboard-socat.log 2>&1" \
  || die "docker exec failed launching socat forwarder"
for _ in $(seq 1 10); do
  sleep 1
  if nsenter_sandbox "$CONTAINER" "$GW_PID" curl -sf -m 4 "http://127.0.0.1:${PORT}/api/status" >/dev/null 2>&1; then
    log "dashboard up on port $PORT (loopback :${INTERNAL_PORT} via socat, auth gate verified)"
    exit 0
  fi
done
docker exec "$CONTAINER" tail -3 /tmp/hermes-dashboard-socat.log >&2 2>/dev/null
die "socat forwarder did not answer on port $PORT"
