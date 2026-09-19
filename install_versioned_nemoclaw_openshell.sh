#!/usr/bin/env bash
# Install the OpenShell/NemoClaw revisions this dashboard is validated against.

set -euo pipefail

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

# *** REVERTED 2026-09-19 — DO NOT RE-BUMP WITHOUT READING THIS. ***
# We bumped to NemoClaw main@e38726c8d7 + OpenShell 0.0.116 + OpenClaw 2026.9.1
# and it FAILED LIVE on a GPU-less Hetzner agent gateway. Two independent,
# upstream-caused blockers, both reproduced repeatedly:
#
#  1. SANDBOX CREATE IS ~78% BROKEN. selectedDockerMode() in NemoClaw's
#     src/lib/onboard/managed-bootstrap/docker-runtime.ts is unconditional for
#     GPU-less sandboxes:
#         if (route !== "compatibility" || !sandboxGpuEnabled)
#             return buildDockerGpuMode("startup-command");
#     so NemoClaw ALWAYS recreates the OpenShell container to persist the
#     startup command ("Docker GPU patch" is a misnomer — that mode carries
#     device:"" and args:[], no GPU involvement, and no env var disables it;
#     NEMOCLAW_DOCKER_GPU_PATCH=0 is a NO-OP, it means the same as unset).
#     OpenShell 0.0.116 destroys the replacement mid-commit: docker events show
#     the new container reach health_status:healthy and then be killed and
#     destroyed, after which OpenShell has nothing to start and reports Error.
#     Almost certainly OpenShell v0.0.111's canonical main process (#2726) /
#     reject-stale-exit (#2857) refusing NemoClaw's rename-based swap.
#     Measured: 9 create attempts, 2 succeeded.
#
#  2. CHAT IS BROKEN EVEN WHEN CREATE SUCCEEDS. NemoClaw onboarding writes a
#     legacy /sandbox/.openclaw/agents/main/agent/auth-profiles.json; OpenClaw
#     2026.9.1 refuses it with AuthProfileMigrationRequiredError and every
#     chat.send fails. The documented remedy (`openclaw doctor --fix`) CANNOT
#     run: it needs maintenance mode, and the in-sandbox supervisor owns
#     gateway-lifecycle, so doctor exits with
#     StateDatabaseCoordinatorContentionError. `openclaw gateway stop` is a
#     launchd/systemd command and there is no service manager in the sandbox.
#
# Both live inside a NemoClaw main commit that adopted OpenClaw 2026.9.1
# (#11105) ONE DAY before we pinned it, without the matching migration and
# lifecycle work. Nothing in this repo can fix either. Re-attempt only when a
# NemoClaw TAG ships 2026.9.1 and a fresh create + chat passes end-to-end.
#
# Restored pins below are the combination proven working on 2026-09-13.
OPENSHELL_VERSION="${OPENSHELL_VERSION:-v0.0.106}"
OPENSHELL_INSTALL_URL="${OPENSHELL_INSTALL_URL:-https://raw.githubusercontent.com/NVIDIA/OpenShell/main/install.sh}"
# NemoClaw is pinned to the main-branch COMMIT e38726c8d792dc99c03ce3a29619ed21f7d32d34
# (2026-09-18, 28 commits past tag v0.0.127), bumped from tag v0.0.123 on
# 2026-09-19. Release discussion for the v0.0.124..v0.0.127 span:
# NVIDIA/NemoClaw#12009.
#
# *** WHY A SHA AND NOT A TAG — READ BEFORE "TIDYING" THIS TO v0.0.127. ***
# OpenClaw 2026.9.1 exists on NO NemoClaw tag. It landed on main on
# 2026-09-18, one day AFTER v0.0.127 was cut. Dockerfile.base carries an
# integrity hash per OpenClaw version and rejects anything else, so the ref
# and OPENCLAW_VERSION are a PACKAGE DEAL — these are the only valid pairs:
#     tag v0.0.122..v0.0.127  + OPENCLAW_VERSION=2026.7.1   ✅
#     main @ e38726c8d7       + OPENCLAW_VERSION=2026.9.1   ✅
#     tag v0.0.127            + OPENCLAW_VERSION=2026.9.1   ❌ no hash
#     main @ e38726c8d7       + OPENCLAW_VERSION=2026.7.1   ❌ hash dropped
# This mirrors the 2026-07-05 precedent (interim SHA 1162e89 for OpenClaw
# 2026.6.10, retired once a tag carried it). Retire this SHA the same way:
# move to the first TAG whose Dockerfile.base carries 2026.9.1's hash.
# A SHA, not the bare `main` upstream tracks, so a fresh install is
# reproducible — see the v0.0.88 float outage in
# docs/runbooks/nemoclaw-version-bumps.md.
#
# *** OPENSHELL MOVES: 0.0.106 -> 0.0.116. NOT A TAG-ONLY BUMP. ***
# NemoClaw v0.0.124 raised the blueprint floor to min==max_openshell_version
# == "0.0.116"; it is still 0.0.116 at this SHA. Upstream
# (mmckeen-nv/openshell_controller) independently moved to v0.0.116 too.
# Likely cause: OpenShell v0.0.111's "canonical main process"
# (NVIDIA/OpenShell#2726), the PID-1 shape NemoClaw's OpenShell-managed
# gateway topology depends on. Intervening OpenShell releases 0.0.109/.110/
# .111/.113/.115/.116 declare no breaking change; 0.0.116 is the newest.
#
# CONSEQUENCE: `--skip-openshell` is NOT valid on a box at 0.0.106. The
# OpenShell reinstall takes EVERY sandbox container down (Trap 1 in
# docs/runbooks/live-vps-upgrades.md). Follow
# docs/runbooks/live-openshell-bump-with-agent-upgrade.md, NOT
# byovps-controller-upgrade.md — but note that runbook's condition 3 does
# not hold: OpenClaw moves 2026.7.1 -> 2026.9.1 (so OpenClaw sandboxes DO
# get rebuilt and dodge the token-TTL trap) while Hermes stays 0.20.6 (so
# Hermes sandboxes are only restarted and DO race it). Run
# `upgrade-sandboxes --check` first and let its answer drive the plan; it
# exits 1 when there is work to do, which is normal (#10211).
#
# WHY THIS SHA RATHER THAN THE v0.0.127 TAG, beyond OpenClaw: the tag
# carries a real bug this SHA fixes. NemoClaw #11933 (in v0.0.127) restored
# a Hermes call to /usr/local/bin/nemoclaw-gateway-control, which #11792
# had removed from managed images. Gateway observation then returns
# "unknown" while the gateway and inference route are actually healthy, so
# Hermes `sandbox start` / `connect --probe-only` do not finish after a
# stopped sandbox recovers. #12047 (main, not in any tag) fixes it by
# using the recorded OpenShell gateway's native in-sandbox HTTP health
# check plus a retry-settlement window. That bug lands precisely on the
# "restart a stopped sandbox" path this upgrade's destructive window
# exercises for every sandbox, so shipping the tag would be worse.
#
# Headline upstream change for the whole span (#11792): gateway lifecycle
# authority moved back to the native agents. OpenClaw and Hermes now own
# their gateways, plugins, packages, child processes and hooks; NemoClaw
# keeps sandbox selection, credential projection, health observation and
# host-forward repair. agents/hermes/start.sh shed ~1100 lines. Startup and
# deletion paths now wait for observable convergence (#11914/#11933/#11950,
# #11951/#11614) instead of reporting success optimistically.
#
# Verified against the v0.0.123..main diff on 2026-09-19:
#  * TOKEN CHAIN INTACT — the contract CLAUDE.md §10 depends on is
#    unchanged: the gateway still compares against gateway.auth.token in
#    /sandbox/.openclaw/openclaw.json. #11829 only made the host-side fetch
#    async internally.
#  * `recover` UNCHANGED — src/commands/sandbox/recover.ts is byte-identical
#    v0.0.123..v0.0.127, so CLAUDE.md §3 and app/lib/restartRuntime.ts stay
#    valid.
#  * Hermes 0.20.6 and the blueprint sandbox digest (sha256:b3d832b5…) are
#    unchanged across v0.0.120/123/127/main.
#  * MCP BROKER UNAFFECTED — #11866 retires NemoClaw's HOST-SIDE MCP
#    registry; the native mcp_servers content is now authoritative
#    "including direct edits", which is exactly what our broker
#    (app/lib/mcpBroker*, sandboxOpenClawMcpConfig) already does.
#  * BASE-IMAGE OVERRIDE STAYS RETIRED — nothing here revives
#    NEMOCLAW_SANDBOX_BASE_IMAGE_REF.
#  * NOT APPLICABLE — Hermes Portable's Podman 5.7.0 requirement (#11907) is
#    the portable path; our Hermes runs in-sandbox. #11865 rejects an
#    untrusted OPENSHELL_GATEWAY_ENDPOINT override; we never set it.
#  * WATCH ITEM — ensureOpenClawGatewayToken below still does a manual
#    in-sandbox gateway relaunch, which NemoClaw's
#    docs/manage-sandboxes/gateway-lifecycle-control.mdx calls a
#    non-fallback path. That rule is NOT new (it shipped at v0.0.120) and
#    the function works in production against v0.0.120/v0.0.123, but
#    #11792 consolidates the supervisor that owns the gateway child, and
#    upstream deleted their equivalent manual relaunch from the restart
#    route in favour of `nemoclaw sandbox gateway restart` (their #49).
#    Its code comment claiming "no supervisor" is already stale. Verify
#    with a live create.
NEMOCLAW_INSTALL_REF="${NEMOCLAW_INSTALL_REF:-${NEMOCLAW_INSTALL_TAG:-v0.0.123}}"
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
