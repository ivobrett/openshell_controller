#!/usr/bin/env bash
# Install the OpenShell/NemoClaw revisions this dashboard is validated against.

set -euo pipefail

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

OPENSHELL_VERSION="${OPENSHELL_VERSION:-v0.0.72}"
OPENSHELL_INSTALL_URL="${OPENSHELL_INSTALL_URL:-https://raw.githubusercontent.com/NVIDIA/OpenShell/main/install.sh}"
# NemoClaw is pinned to TAG v0.0.83 (commit 45b1cb5a; bumped from v0.0.81 on
# 2026-07-15). Pre-flight against the v0.0.81..v0.0.83 diff:
#   - min/max_openshell_version still 0.0.72 (--skip-openshell stays valid);
#     OpenClaw reviewed default still 2026.6.10 (mobile pairing intact, no
#     OpenClaw-driven rebuild); Hermes base still v0.18.0. No agent-manifest
#     expected_version moved, so `upgrade-sandboxes --auto` is a no-op and
#     running sandboxes are NOT rebuilt.
#   - Dockerfile.base STILL exact-pins Debian trixie packages (curl=
#     8.14.1-2+deb13u4, git, python3, jq, iproute2, iptables, ca-certificates…)
#     — the wildcard curl/ripgrep unpin below still applies (ripgrep/e2fsprogs/
#     tmux seds are harmless no-ops if a package is absent at this tag).
#   - `npm audit signatures` is STILL a hard `&&` gate in Dockerfile.base; the
#     best-effort wrap below is still required (v0.0.83's "corporate CA
#     anchoring" targets a TLS-intercepting proxy, NOT the Sigstore CDN 403
#     that blocks some cloud IPs — see the wrap comment below).
#   - The 256 MiB backup maxBuffer bug is STILL present (3 sites) — the sed
#     shim below still applies.
#   - v0.0.83 adds inference-route-safety (explicit/fail-safe shared-route
#     changes) + onboarding recovery; no change to the mobile-pairing path our
#     controller drives (fix f2565bc still applies). See
#     memory/project_openclaw_pairing_v0078_regression.md.
NEMOCLAW_INSTALL_REF="${NEMOCLAW_INSTALL_REF:-${NEMOCLAW_INSTALL_TAG:-v0.0.83}}"
NEMOCLAW_SOURCE_URL="${NEMOCLAW_SOURCE_URL:-https://github.com/NVIDIA/NemoClaw.git}"
OPENCLAW_VERSION="${OPENCLAW_VERSION:-2026.6.10}"
NEMOCLAW_BASE_IMAGE="${NEMOCLAW_BASE_IMAGE:-ghcr.io/nvidia/nemoclaw/sandbox-base:latest}"
NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE="${NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE:-1}"
NEMOCLAW_NON_INTERACTIVE="${NEMOCLAW_NON_INTERACTIVE:-1}"
NEMOCLAW_EXPERIMENTAL="${NEMOCLAW_EXPERIMENTAL:-1}"
NEMOCLAW_PROVIDER="${NEMOCLAW_PROVIDER:-vllm}"

SKIP_OPENSHELL=0
SKIP_NEMOCLAW=0

usage() {
  cat <<EOF
Versioned OpenShell/NemoClaw installer

Usage:
  ./install_versioned_nemoclaw_openshell.sh [options]

Options:
  --nvidia-api-key KEY   Pass NVIDIA_INFERENCE_API_KEY (and legacy NVIDIA_API_KEY) to the NemoClaw installer
  --skip-openshell       Do not install OpenShell
  --skip-nemoclaw        Do not install NemoClaw
  --help                 Show this help

Defaults:
  OPENSHELL_VERSION=$OPENSHELL_VERSION
  NEMOCLAW_INSTALL_REF=$NEMOCLAW_INSTALL_REF
  OPENCLAW_VERSION=$OPENCLAW_VERSION
  NEMOCLAW_BASE_IMAGE=$NEMOCLAW_BASE_IMAGE
  NEMOCLAW_EXPERIMENTAL=$NEMOCLAW_EXPERIMENTAL
  NEMOCLAW_PROVIDER=$NEMOCLAW_PROVIDER

Environment overrides:
  OPENSHELL_VERSION
  OPENSHELL_INSTALL_URL
  NEMOCLAW_INSTALL_REF
  NEMOCLAW_INSTALL_TAG (legacy alias for NEMOCLAW_INSTALL_REF)
    In curl pipes, set this on bash or export it first. Example:
    curl -fsSL https://www.nvidia.com/nemoclaw.sh | NEMOCLAW_INSTALL_TAG=v0.0.56 bash
  NEMOCLAW_SOURCE_URL
  OPENCLAW_VERSION
  NEMOCLAW_BASE_IMAGE
  NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE
  NEMOCLAW_NON_INTERACTIVE
  NEMOCLAW_EXPERIMENTAL
  NEMOCLAW_PROVIDER
  OPENSHELL_GATEWAY_HOST
  OPENSHELL_GATEWAY_PORT
  OPENSHELL_GATEWAY_URL
  NVIDIA_INFERENCE_API_KEY
  NVIDIA_API_KEY (legacy alias)
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --nvidia-api-key)
      [[ $# -ge 2 ]] || { echo -e "${RED}ERROR:${NC} --nvidia-api-key requires a value" >&2; exit 1; }
      export NVIDIA_INFERENCE_API_KEY="$2"
      export NVIDIA_API_KEY="${NVIDIA_API_KEY:-$2}"
      shift 2
      ;;
    --skip-openshell)
      SKIP_OPENSHELL=1
      shift
      ;;
    --skip-nemoclaw)
      SKIP_NEMOCLAW=1
      shift
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      echo -e "${RED}ERROR:${NC} Unknown option: $1" >&2
      usage
      exit 1
      ;;
  esac
done

log() {
  echo -e "${GREEN}==>${NC} $*"
}

warn() {
  echo -e "${YELLOW}WARN:${NC} $*"
}

fail() {
  echo -e "${RED}ERROR:${NC} $*" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "$1 is required but was not found."
}

install_openshell() {
  require_command curl
  require_command sh
  log "Installing OpenShell $OPENSHELL_VERSION"
  curl -LsSf "$OPENSHELL_INSTALL_URL" | OPENSHELL_VERSION="$OPENSHELL_VERSION" sh
}

install_nemoclaw() {
  require_command sh
  require_command git
  require_command docker

  # The source checkout must OUTLIVE this installer: when upstream
  # install.sh runs from a source checkout it installs the CLI with
  # `npm link`, making the global nemoclaw a symlink into that checkout.
  # The previous mktemp-plus-RETURN-trap workdir left a dangling global
  # CLI ("nemoclaw: command not found" / npm ls shows "nemoclaw@" with no
  # version) after every SUCCESSFUL run — the failure only got noticed
  # 2026-07-11 because aborted runs skip the RETURN trap and keep their
  # temp dir alive. Use a persistent checkout instead (fresh each run).
  local source_dir
  source_dir="${NEMOCLAW_SRC_DIR:-/opt/nemoclaw-src}"
  rm -rf "$source_dir"
  mkdir -p "$source_dir"

  log "Cloning NemoClaw $NEMOCLAW_INSTALL_REF"
  git init --quiet "$source_dir"
  git -C "$source_dir" remote add origin "$NEMOCLAW_SOURCE_URL"
  if ! git -C "$source_dir" fetch --quiet --depth 1 origin "$NEMOCLAW_INSTALL_REF"; then
    fail "Requested NemoClaw install ref '$NEMOCLAW_INSTALL_REF' is not available from $NEMOCLAW_SOURCE_URL. Check NEMOCLAW_INSTALL_REF/NEMOCLAW_INSTALL_TAG and try again."
  fi
  git -C "$source_dir" -c advice.detachedHead=false checkout --quiet --detach FETCH_HEAD
  [[ -n "$source_dir" && -f "$source_dir/install.sh" ]] || fail "Could not find NemoClaw install.sh in source checkout."

  # NemoClaw upstream Dockerfile/Dockerfile.base pin exact Debian package
  # versions (procps=2:4.0.4-9, e2fsprogs=1.47.2-3+b11, tmux=3.5a-3). Since
  # NemoClaw v0.0.74+ the base is node:22-trixie-slim (Debian 13), so the
  # pins are distro-correct — but Debian's live index drops superseded
  # point-release versions, so any security update upstream of us makes the
  # pinned `apt-get install` fail with exit 100, breaking every
  # `nemoclaw onboard` on a freshly-deployed VPS. Unpin them so apt picks
  # whatever's currently in trixie. Re-apply this whenever NemoClaw is
  # re-extracted; the in-tree Dockerfiles are version-controlled upstream
  # and our patch lives only in this installer.
  # Per-agent base images (agents/hermes, agents/langchain-deepagents-code)
  # carry the same pinned apt block as the top-level Dockerfiles, so patch
  # every Dockerfile* in the tree. curl joined the unpin list 2026-07-11:
  # Debian shipped 8.14.1-2+deb13u4 and dropped the pinned deb13u3 from the
  # trixie index, killing every deepagents/hermes/openclaw base-image build
  # with apt exit 100 ("Sandbox creation command failed" in the UI).
  while IFS= read -r _dockerfile; do
    sed -i.bak \
      -e 's/procps=2:4\.0\.4-9/procps/g' \
      -e 's/e2fsprogs=1\.47\.2-3+b11/e2fsprogs/g' \
      -e 's/tmux=3\.5a-3/tmux/g' \
      -e 's/curl=[^[:space:]\\]*/curl/g' \
      -e 's/ripgrep=[^[:space:]\\]*/ripgrep/g' \
      "$_dockerfile" && rm -f "${_dockerfile}.bak"
  done < <(find "$source_dir" -name 'Dockerfile*' -not -path '*/node_modules/*' -type f)

  # Same class of upstream-baked, moving-target network gate as the Debian
  # pins above, but the failing dependency is Sigstore, not Debian. The
  # OpenClaw base-image build ends with `npm ... mcporter-runtime audit
  # signatures` (Dockerfile.base), which bootstraps the Sigstore trust root
  # from https://tuf-repo-cdn.sigstore.dev via tuf-js. That CDN sits behind
  # Google's edge and returns HTTP 403 to some cloud IP ranges (confirmed on
  # a fresh Hetzner box 2026-07-15, IP-reputation block — persistent, not a
  # UA quirk). tuf-js can't fetch the TUF timestamp -> `audit signatures`
  # exits 1 -> the whole base-image `docker build` dies with exit 1, surfaced
  # in the UI as the base-image-glibc-probe retry then "Sandbox creation
  # command failed". Because it's IP-dependent, the same code "works" on one
  # deploy and fails on the next. Make ONLY the signature-attestation step
  # best-effort; keep `npm ci` and `npm audit --audit-level=low` (the real
  # vuln gate) hard. Security loss is minimal: the exact mcporter bytes are
  # already pinned two lines above by SRI integrity (sha512) + the committed
  # lockfile sha256; `audit signatures` only adds Sigstore provenance on top.
  # Guarded so re-extraction/re-run never double-wraps. Keep in sync with
  # manidae-cloud startup_agentgateway.sh.j2.
  # `/WARN…/b` makes it idempotent (never double-wraps a re-extracted tree);
  # the `& ` in the replacement re-inserts the matched command verbatim, so it
  # works for both the `&&`-joined form (Dockerfile.base) and the `; \`-joined
  # form (top-level Dockerfile). BSD- and GNU-sed compatible.
  while IFS= read -r _dockerfile; do
    sed -i.bak \
      -e '/WARN: audit signatures skipped/b' \
      -e 's#npm --prefix /usr/local/lib/nemoclaw/mcporter-runtime audit signatures#{ & || echo "WARN: audit signatures skipped (Sigstore TUF unreachable from build host)" >\&2; }#' \
      "$_dockerfile" && rm -f "${_dockerfile}.bak"
  done < <(find "$source_dir" -name 'Dockerfile*' -not -path '*/node_modules/*' -type f)

  # NemoClaw's sandbox state backup (src/lib/state/sandbox.ts) buffers the
  # whole SSH+tar stream in memory via spawnSync with a hard-coded
  # maxBuffer of 256 MiB. Any sandbox whose /sandbox/.<agent> state exceeds
  # that can NEVER be backed up (tar dies at exit 255 mid-stream), and the
  # failure is misreported as "in-sandbox SSH endpoint did not answer".
  # install.sh's strict pre-upgrade backup gate (hard-coded
  # NEMOCLAW_REQUIRE_ALL_SANDBOX_BACKUPS=1, skipped counts as failed) then
  # blocks the whole upgrade. Hit for real 2026-07-11 on the Oracle BYOVPS
  # (607 MiB of OpenClaw state). Raise the cap to 2 GiB before the CLI is
  # built. Remove when upstream streams backups to disk instead of memory.
  _state_ts="$source_dir/src/lib/state/sandbox.ts"
  if [[ -f "$_state_ts" ]]; then
    sed -i.bak \
      -e 's/maxBuffer: 256 \* 1024 \* 1024/maxBuffer: 2048 * 1024 * 1024/g' \
      "$_state_ts" && rm -f "${_state_ts}.bak"
  fi

  if [[ -z "${NVIDIA_INFERENCE_API_KEY:-}" && -n "${NVIDIA_API_KEY:-}" ]]; then
    export NVIDIA_INFERENCE_API_KEY="$NVIDIA_API_KEY"
  elif [[ -z "${NVIDIA_API_KEY:-}" && -n "${NVIDIA_INFERENCE_API_KEY:-}" ]]; then
    export NVIDIA_API_KEY="$NVIDIA_INFERENCE_API_KEY"
  fi

  if [[ -z "${NVIDIA_INFERENCE_API_KEY:-}" ]]; then
    warn "NVIDIA_INFERENCE_API_KEY is not set. NemoClaw may require it for non-local provider setup."
  fi

  log "Installing NemoClaw $NEMOCLAW_INSTALL_REF"
  (
    cd "$source_dir"
    NEMOCLAW_INSTALL_REF="$NEMOCLAW_INSTALL_REF" \
      NEMOCLAW_INSTALL_TAG="$NEMOCLAW_INSTALL_REF" \
      NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE="$NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE" \
      NEMOCLAW_NON_INTERACTIVE="$NEMOCLAW_NON_INTERACTIVE" \
      NEMOCLAW_EXPERIMENTAL="$NEMOCLAW_EXPERIMENTAL" \
      NEMOCLAW_PROVIDER="$NEMOCLAW_PROVIDER" \
      NVIDIA_INFERENCE_API_KEY="${NVIDIA_INFERENCE_API_KEY:-}" \
      NVIDIA_API_KEY="${NVIDIA_API_KEY:-}" \
      ./install.sh
  )

  log "Building NemoClaw stock base image with OpenClaw $OPENCLAW_VERSION"
  docker build \
    -f "$source_dir/Dockerfile.base" \
    -t "$NEMOCLAW_BASE_IMAGE" \
    --build-arg "OPENCLAW_VERSION=$OPENCLAW_VERSION" \
    "$source_dir"
}

echo -e "${GREEN}=== Versioned OpenShell/NemoClaw Installer ===${NC}"
echo "OpenShell: $OPENSHELL_VERSION"
echo "NemoClaw:  $NEMOCLAW_INSTALL_REF"
echo "OpenClaw:  $OPENCLAW_VERSION"
echo "Base image: $NEMOCLAW_BASE_IMAGE"
echo "Provider:   $NEMOCLAW_PROVIDER (experimental=$NEMOCLAW_EXPERIMENTAL)"
echo ""

if [[ "$SKIP_OPENSHELL" -eq 0 ]]; then
  install_openshell
else
  warn "Skipping OpenShell install"
fi

if [[ "$SKIP_NEMOCLAW" -eq 0 ]]; then
  install_nemoclaw
else
  warn "Skipping NemoClaw install"
fi

echo ""
echo -e "${GREEN}=== Versioned Install Complete ===${NC}"
echo "Run ./install.sh afterward to install or refresh the dashboard."
