#!/usr/bin/env bash
# Install the OpenShell/NemoClaw revisions this dashboard is validated against.

set -euo pipefail

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

# *** OPENSHELL DID NOT MOVE ON THE v0.0.113 -> v0.0.116 BUMP. ***
# v0.0.116's blueprint still declares min==max_openshell_version == "0.0.106",
# so this is a TAG-ONLY bump: `--skip-openshell` is VALID on any box already at
# OpenShell 0.0.106, and no destructive maintenance window is required. Follow
# docs/runbooks/byovps-controller-upgrade.md, NOT
# live-openshell-bump-with-agent-upgrade.md. (A box still on 0.0.101 or 0.0.85
# has NOT caught up — it still crosses the earlier destructive window(s) first.)
OPENSHELL_VERSION="${OPENSHELL_VERSION:-v0.0.106}"
OPENSHELL_INSTALL_URL="${OPENSHELL_INSTALL_URL:-https://raw.githubusercontent.com/NVIDIA/OpenShell/main/install.sh}"
# NemoClaw is pinned to TAG v0.0.116 (commit b12bede; bumped from v0.0.113 on
# 2026-08-30, spanning 3 upstream releases v0.0.114..v0.0.116). Headline changes
# (NVIDIA/NemoClaw discussion #10594): OpenClaw endpoint validation now works
# from inside the sandbox without a messaging channel (#10458/#10531/#10540),
# Hermes recovery manages only the published receipt-owned Portable Ollama
# runner (#10505), sandbox identity/authority persists across retries and
# process restarts (#10510/#10512), uninstall snapshots before deleting unless
# --destroy-user-data (#10231/#10550/#10562), WSL credential-free Docker
# fallback (#10470/#10554/#10561), re-onboarding preserves `brave` policy
# presets (#10457), and OpenSSL 3.5.7 / libevent 2.1.13 security updates
# (#10532/#10526).
# Pre-flight against the v0.0.113..v0.0.116 diff (all verified 2026-08-30 from
# source at tag v0.0.116 / commit b12bede):
#   - blueprint.yaml is BYTE-IDENTICAL to v0.0.113 — min_openshell_version ==
#     max_openshell_version == "0.0.106". OPENSHELL_VERSION stays v0.0.106 and
#     the installer's OpenShell phase can be skipped on an up-to-date box.
#   - HERMES UNCHANGED at 0.19.0 (calver v2026.7.20; ARG HERMES_VERSION is
#     byte-identical). The mandatory remote-desktop guard re-check in
#     docs/runbooks/nemoclaw-version-bumps.md is therefore NOT triggered — it
#     fires only when the Hermes pin moves. HERMES_REMOTE_DESKTOP.md §1a stays
#     valid as written. agents/hermes/start.sh did change, but only to add
#     HERMES_LAZY_INSTALL_TARGET and an extra `refresh_hermes_runtime_config_
#     hashes compat` reconciliation — no bind-address, Origin-allowlist or
#     auth-provider semantics were touched.
#   - OpenClaw reviewed default STILL 2026.7.1 (ARG OPENCLAW_VERSION=2026.7.1 in
#     both Dockerfile and Dockerfile.base; confirmed live in the release-tag
#     image: `OpenClaw 2026.7.1 (2d2ddc4)`).
#   - NO agent expected_version moved: hermes 0.19.0, openclaw 2026.7.1,
#     langchain-deepagents-code 0.1.55, pi 0.84.1 are all byte-identical, and
#     package.json stays "0.1.0". Combined with the unchanged blueprint this is
#     a PURE TAG BUMP — `upgrade-sandboxes --auto` has nothing to rebuild and no
#     running sandbox is recreated. src/lib/sandbox/version.ts (the staleness
#     logic itself) is also unchanged.
#   - `pi` and `nemocua` still ship and the controller still does not surface
#     them — app/lib/sandboxCreate/agentFilter.ts models a closed
#     "openclaw" | "hermes" union and maps anything else to "unknown".
#   - `npm audit signatures` is STILL absent from every Dockerfile, so the shim
#     retired on the v0.0.108 bump stays retired (see the REMOVED note below the
#     unpin block).
#   - The 256 MiB backup maxBuffer bug is STILL present (3 sites in
#     src/lib/state/sandbox.ts) — the 8 GiB sed shim below still applies.
#   - ONE NEW live-index apt pin: `libssl3t64=3.5.7-1~deb13u2` (OpenSSL 3.5.7,
#     #10532), added to the main Dockerfile.base apt block alongside gnupg /
#     ca-certificates / iproute2, and to Dockerfile, agents/hermes,
#     agents/langchain-deepagents-code and agents/pi. It is DELIBERATELY NOT
#     ADDED TO THE UNPIN LIST BELOW — unlike every other pin we unpin, this one
#     is ALSO byte-verified by NemoClaw's frozen security inventory
#     (`test "$(dpkg-query -W libssl3t64)" = "3.5.7-1~deb13u2"` plus the
#     security-packages.txt line compared against
#     SANDBOX_BASE_SECURITY_PACKAGE_INVENTORY). Unpinning it would let apt
#     select a newer OpenSSL and then fail the dpkg-query assertion and the
#     inventory byte-compare — trading a recoverable apt exit 100 for an
#     unrecoverable one. If Debian ever supersedes 3.5.7-1~deb13u2 in trixie,
#     the ONLY fix is a NemoClaw tag bump; do not reach for the sed.
#     `libssl-dev` moved 3.5.6-1~deb13u2 -> 3.5.7-1~deb13u2 in the same block
#     but is already wildcard-unpinned (and is not inventory-verified), so it
#     needs no change. `libevent-core-2.1-7t64=2.1.13-stable-1` (#10526) is a
#     SHA256-pinned .deb from the frozen snapshot, installed with `dpkg -i` —
#     frozen, so no unpin either. All 26 live-index pins were re-scanned against
#     the trixie index on 2026-08-30 (apt-cache madison inside the pinned base
#     node:22-trixie-slim@sha256:db8a96a6…, which itself is UNCHANGED) and every
#     one still resolves — this bump is NOT blocked on a stale pin.
#   - SECURITY INVENTORY MOVED, so the base-image digest MUST move in lockstep.
#     v0.0.116 adds "libssl3t64=3.5.7-1~deb13u2" to
#     SANDBOX_BASE_SECURITY_PACKAGE_INVENTORY and introduces a SECOND, wider
#     list — OPENCLAW_SANDBOX_BASE_SECURITY_PACKAGE_INVENTORY = the base list
#     plus "libevent-core-2.1-7t64=2.1.13-stable-1" — checked by the new
#     openClawSandboxBaseImageHasSecurityInventory() that src/lib/onboard/
#     base-image.ts uses for the digest-pinned sandbox-base override. A base
#     image pinned for v0.0.113 (sha256:31fcee7b…) FAILS that check on v0.0.116
#     and breaks every create — exactly the 2026-08-15 outage class, and the
#     THIRD consecutive bump where the inventory moved while `openclaw
#     --version` stayed reassuringly at 2026.7.1. This file carries the version
#     pin only; the digest lives in manidae-cloud's startup_agentgateway.sh.j2,
#     startup_nemoclaw.sh.j2 and byovps_bootstrap.py, all moved to
#     sha256:03a1a319… in the same change set (the v0.0.116 RELEASE TAG,
#     verified 2026-08-30: OpenClaw 2026.7.1, security-packages.txt
#     byte-identical to the OpenClaw inventory, root:root 0444).
#   - BEHAVIOUR CHANGE on the upgrade path (#10211): `upgrade-sandboxes --check`
#     now `process.exit(1)` when it finds stale, unknown, orphaned or
#     recovery-candidate sandboxes; it used to return 0 and only print. Our
#     pre-flight green light in docs/runbooks/byovps-controller-upgrade.md is
#     still "All sandboxes are up to date", but a non-zero exit is now the
#     NORMAL signal for "there is work to do" — do not run it under `set -e`
#     and do not read exit 1 as a broken CLI.
NEMOCLAW_INSTALL_REF="${NEMOCLAW_INSTALL_REF:-${NEMOCLAW_INSTALL_TAG:-v0.0.116}}"
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
  # libssl-dev / openssh-server / zlib1g-dev / util-linux joined on the
  # v0.0.96->v0.0.108 bump (2026-08-14): all four are NEW live-index pins added
  # by NemoClaw's native-security-builder + runtime stages — the same
  # drift-exposed class. All four RESOLVED on the day of the bump, so these
  # unpins are pre-emptive, not a fix for an observed failure. Unpinning only
  # ever selects apt's Candidate (>= the pinned version), so there is no
  # downgrade or CVE-regression risk. NOTE the `openssh-server=` pattern
  # deliberately does NOT match `openssh-sftp-server=` (different literal),
  # which stays pinned — as do the SHA256-pinned snapshot .debs (expat/jq/Vim)
  # and the in-tree-built `+nemoclaw1` packages, none of which are index-resolved.
  # THE ONE INDEX-RESOLVED PIN WE DELIBERATELY LEAVE ALONE is
  # `libssl3t64=3.5.7-1~deb13u2` (new at v0.0.116, #10532). It is also frozen
  # into NemoClaw's security inventory — a `dpkg-query` assertion AND the
  # security-packages.txt byte-compare against
  # SANDBOX_BASE_SECURITY_PACKAGE_INVENTORY. Unpinning it would let apt pick a
  # newer OpenSSL and fail BOTH of those, turning a recoverable apt exit 100
  # into an unrecoverable one. If trixie ever supersedes it, the fix is a
  # NemoClaw tag bump, not a sed. (`libssl-dev` in the same apt block is NOT
  # inventory-verified, so its wildcard unpin above stays correct.)
  while IFS= read -r _dockerfile; do
    sed -i.bak \
      -e 's/procps=2:4\.0\.4-9/procps/g' \
      -e 's/e2fsprogs=1\.47\.2-3+b11/e2fsprogs/g' \
      -e 's/tmux=3\.5a-3/tmux/g' \
      -e 's/curl=[^[:space:]\\]*/curl/g' \
      -e 's/ripgrep=[^[:space:]\\]*/ripgrep/g' \
      -e 's/libssl-dev=[^[:space:]\\]*/libssl-dev/g' \
      -e 's/openssh-server=[^[:space:]\\]*/openssh-server/g' \
      -e 's/zlib1g-dev=[^[:space:]\\]*/zlib1g-dev/g' \
      -e 's/util-linux=[^[:space:]\\]*/util-linux/g' \
      "$_dockerfile" && rm -f "${_dockerfile}.bak"
  done < <(find "$source_dir" -name 'Dockerfile*' -not -path '*/node_modules/*' -type f)

  # REMOVED 2026-08-14 on the v0.0.96->v0.0.108 bump: the `npm ...
  # mcporter-runtime audit signatures` best-effort wrap. Upstream moved Sigstore
  # auditing OUT of the image builds entirely (discussion #8944), so the command
  # no longer appears in Dockerfile or Dockerfile.base and our sed had become a
  # silent no-op. This retires the Sigstore-TUF-403 failure class (fresh cloud
  # boxes failing base-image builds because tuf-repo-cdn.sigstore.dev returns
  # 403 to some Hetzner IP ranges) — see
  # memory/project_openclaw_build_audit_signatures_tuf_403.md. If a future tag
  # reintroduces an in-build `audit signatures`, restore the wrap from git
  # history (commit 6f366fc) rather than rewriting it. The parallel copy in
  # manidae-cloud startup_agentgateway.sh.j2 is removed in lockstep.

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
