#!/usr/bin/env bash
# Install the OpenShell/NemoClaw revisions this dashboard is validated against.

set -euo pipefail

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

OPENSHELL_VERSION="${OPENSHELL_VERSION:-v0.0.72}"
OPENSHELL_INSTALL_URL="${OPENSHELL_INSTALL_URL:-https://raw.githubusercontent.com/NVIDIA/OpenShell/main/install.sh}"
# NemoClaw is pinned to TAG v0.0.78 — the first release tag that carries the
# OpenClaw 2026.6.10 upgrade (PR #5595), superseding our temporary SHA pin
# 1162e89b (= v0.0.74 + that one commit). 2026.6.10 remains required for
# current OpenClaw mobile apps (>=2026.6.x) to pair — older sandbox gateways
# reject their bootstrap tokens (bootstrap_token_invalid). npm SRI integrity
# hashes travel with the version strings — never sed the version alone.
# NemoClaw@v0.0.78 declares min/max_openshell_version 0.0.72 (native mTLS
# since 0.0.71); Hermes base unchanged (v0.17.0 / v2026.6.19); Dockerfile /
# Dockerfile.base are byte-identical to 1162e89b.
NEMOCLAW_INSTALL_REF="${NEMOCLAW_INSTALL_REF:-${NEMOCLAW_INSTALL_TAG:-v0.0.78}}"
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
  for _dockerfile in "$source_dir/Dockerfile" "$source_dir/Dockerfile.base"; do
    if [[ -f "$_dockerfile" ]]; then
      sed -i.bak \
        -e 's/procps=2:4\.0\.4-9/procps/g' \
        -e 's/e2fsprogs=1\.47\.2-3+b11/e2fsprogs/g' \
        -e 's/tmux=3\.5a-3/tmux/g' \
        "$_dockerfile" && rm -f "${_dockerfile}.bak"
    fi
  done

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
