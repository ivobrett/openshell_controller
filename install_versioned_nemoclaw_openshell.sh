#!/usr/bin/env bash
# Install the OpenShell/NemoClaw revisions this dashboard is validated against.

set -euo pipefail

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

OPENSHELL_VERSION="${OPENSHELL_VERSION:-v0.0.85}"
OPENSHELL_INSTALL_URL="${OPENSHELL_INSTALL_URL:-https://raw.githubusercontent.com/NVIDIA/OpenShell/main/install.sh}"
# NemoClaw is pinned to TAG v0.0.95 (commit 64df93a9c; bumped from v0.0.92 on
# 2026-07-25). Why the bump: routine security/lifecycle release
# (NVIDIA/NemoClaw#7524) — hardened sandbox recovery, immutable base-image
# digest enforcement (#6884), plus security refresh of npm packages, libexpat
# + jq (#7503), and the sandbox Perl runtime (#7504). No OpenClaw/OpenShell
# functional move for us; this is a NemoClaw-tag-only bump.
# Pre-flight against the v0.0.92..v0.0.95 diff (all verified 2026-07-25):
#   - blueprint min_openshell_version == max_openshell_version == "0.0.85"
#     UNCHANGED, so OPENSHELL_VERSION stays v0.0.85 and `--skip-openshell` is
#     valid on a box already at 0.0.85 (NO destructive OpenShell window).
#     min_openclaw_version still "2026.3.11".
#   - OpenClaw reviewed default STILL 2026.7.1 (ARG OPENCLAW_VERSION=2026.7.1,
#     integrity pin OPENCLAW_2026_7_1_INTEGRITY intact in Dockerfile.base).
#     Hermes base STILL 0.18.0 (agents/hermes/manifest.yaml expected_version;
#     remote-desktop semantics unchanged — HERMES_REMOTE_DESKTOP.md §1a valid).
#     langchain-deepagents dcode STILL 0.1.34.
#   - NEW base-image structure (#7503/#7504): Dockerfile.base now (a) builds
#     Perl 5.44.0 from source in a `perl-builder` stage (SHA-pinned CPAN
#     tarball from www.cpan.org) and (b) installs SHA-pinned libexpat/libjq/jq
#     .debs from snapshot.debian.org (20260724T000000Z). These are NEW
#     build-time network deps — if a cloud IP is blocked from cpan.org or
#     snapshot.debian.org the base build fails (same failure CLASS as the
#     Sigstore TUF gate below, but no shim: the artifacts are SHA-pinned and
#     there's no evidence of blocking yet — watch-item, not a fix).
#   - APT PINS: the exact-pinned trixie apt block grew 4 packages —
#     build-essential=12.12, netbase=6.5, xz-utils=5.8.1-1+deb13u1 (all in the
#     perl-builder stage) and libonig5=6.9.9-1+b1 (jq's oniguruma dep, main
#     stage; the old jq= apt pin is replaced by the SHA-pinned .deb). Checked
#     ALL 20 pins against live trixie (node:22-trixie-slim @sha256:e6d9a389,
#     Debian 13) on 2026-07-25 — EVERY one still resolves, so NO new unpins
#     needed; the curl/ripgrep/procps/e2fsprogs/tmux wildcard unpin below stays
#     a defensive no-op. If a future point release supersedes any of the 4 new
#     pins (build-essential/netbase/xz-utils/libonig5), add it to the unpin sed.
#   - `npm audit signatures` is STILL a hard gate (Dockerfile.base:493 `&&`
#     AND Dockerfile:487 `; \`) — the best-effort wrap below is still required.
#   - The 256 MiB backup maxBuffer bug is STILL present (3 sites in
#     src/lib/state/sandbox.ts) — the 8 GiB sed shim below still applies.
NEMOCLAW_INSTALL_REF="${NEMOCLAW_INSTALL_REF:-${NEMOCLAW_INSTALL_TAG:-v0.0.95}}"
NEMOCLAW_SOURCE_URL="${NEMOCLAW_SOURCE_URL:-https://github.com/NVIDIA/NemoClaw.git}"
OPENCLAW_VERSION="${OPENCLAW_VERSION:-2026.7.1}"
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

  # --- openshell-sandbox coherence guard (learned on the v0.0.88 bump) ---
  # The OpenShell .deb that install.sh lays down ships ONLY /usr/bin/openshell
  # and /usr/bin/openshell-gateway. /usr/bin/openshell-sandbox — the supervisor
  # / L7 router sideloaded into EVERY sandbox container — is installed
  # SEPARATELY, downstream, by nemoclaw's own scripts/install-openshell.sh
  # (invoked from `nemoclaw onboard` during install_nemoclaw below).
  #
  # On a live box that already carried an OLDER openshell-sandbox, the .deb
  # upgrade bumps CLI+gateway but leaves the sandbox binary STALE. NemoClaw's
  # coherence check then hard-fails onboarding with "The selected OpenShell
  # sandbox does not match the active CLI build" and refuses to auto-repair
  # (its stable channel ignores FORCE_INSTALL on that path). Remove the stale /
  # mismatched host binary here so the downstream onboarding takes its
  # "missing Docker-driver binaries -> reinstall pinned OpenShell" branch and
  # lays down a coherent, checksum-verified gateway+sandbox set. This is a
  # no-op on a fresh box (no openshell-sandbox yet) and only fires when the two
  # versions actually disagree — at which point no sandbox is safely running an
  # incoherent supervisor anyway.
  local _os_sbx _cli_ver _sbx_ver
  _os_sbx="$(command -v openshell-sandbox 2>/dev/null || true)"
  if [[ -n "$_os_sbx" ]] && command -v openshell >/dev/null 2>&1; then
    _cli_ver="$(openshell --version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1 || true)"
    _sbx_ver="$(openshell-sandbox --version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1 || true)"
    if [[ -n "$_cli_ver" && -n "$_sbx_ver" && "$_cli_ver" != "$_sbx_ver" ]]; then
      warn "openshell-sandbox $_sbx_ver != openshell CLI $_cli_ver — removing the stale supervisor so NemoClaw onboarding reinstalls a coherent $_cli_ver set (the .deb ships only CLI+gateway)."
      rm -f "$_os_sbx"
    fi
  fi
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
  # (607 MiB of OpenClaw state). Raise the cap to 8 GiB before the CLI is
  # built. Remove when upstream streams backups to disk instead of memory.
  #
  # Why 8 GiB and not 2 GiB: OpenClaw agent state grows unbounded (the
  # gateway keeps per-session transcripts + attachments under
  # /sandbox/.openclaw). On the same Oracle box by 2026-07-24 that dir had
  # reached 1.8 GiB — already brushing the old 2 GiB cap, and the
  # rebuild-with-restore path buffers the tar TWICE (backup then restore).
  # 8 GiB clears both current agents (OpenClaw 1.8 GiB, Hermes .hermes
  # 351 MiB) with headroom for months of growth. The buffer is only
  # allocated as the tar streams, so oversizing it costs nothing until a
  # backup actually runs.
  _state_ts="$source_dir/src/lib/state/sandbox.ts"
  if [[ -f "$_state_ts" ]]; then
    sed -i.bak \
      -e 's/maxBuffer: 256 \* 1024 \* 1024/maxBuffer: 8192 * 1024 * 1024/g' \
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
