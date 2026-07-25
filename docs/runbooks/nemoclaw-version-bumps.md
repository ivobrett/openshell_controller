# Runbook — NemoClaw / OpenClaw / OpenShell version bumps

> Indexed from CLAUDE.md §4 (Runbooks index). Reach for this when bumping
> `NEMOCLAW_INSTALL_REF`, `NEMOCLAW_INSTALL_TAG`, `OPENSHELL_VERSION`, or
> `OPENCLAW_VERSION` in `install_versioned_nemoclaw_openshell.sh`.

## Why this runbook exists

Bumping `NEMOCLAW_INSTALL_REF` to `v0.0.56` once left every fresh sandbox
creation hanging for ~90 s with no usable error in the UI. Root cause:
a pinned `tmux=3.5a-3` (and friends) in NemoClaw's `Dockerfile` /
`Dockerfile.base` — Debian-version strings against an Ubuntu noble base.
Apt returned exit 100, the docker build died at step 11 / 86, and the
controller's readiness polls never saw a sandbox.

**Before bumping any of these versions:** also skim
`docs/upstream-divergence-audit.md`. The audit lists every fork-local
shim that exists *specifically because* of the current upstream version
(e.g. `scripts/hermes-remote/upgrade-hermes.sh` only exists because the
NemoClaw base ships Hermes 0.14; the apt-pin sed-patch only exists
because NemoClaw pins Debian package versions on Ubuntu). A version
bump may obsolete several — check, then delete what's no longer needed
in the same change set.

## Floating base-image drift — the failure mode that has NO code change on our side

> **Update (2026-07-22, the v0.0.88 base-image-float outage):** this is a
> DIFFERENT failure class from the apt-pin traps below — nothing on our side
> changed. NemoClaw's per-sandbox build does `FROM ghcr.io/nvidia/nemoclaw/sandbox-base:latest`,
> a **floating** tag. Upstream periodically rebuilds `:latest` with a newer
> OpenClaw. NemoClaw has an **anti-downgrade guard**: if the base image's
> OpenClaw is NEWER than the pinned/reviewed `OPENCLAW_VERSION`, it hard-fails
> the build:
>
> ```
> #NN ERROR: Base image has OpenClaw 2026.7.1, which is newer than reviewed target 2026.6.10
> Failed to build OpenClaw sandbox base image (exit 1)
> SandboxBaseImageResolutionError: ... inputs differ from main, but no image built
> ```
>
> So one day every OpenClaw create starts failing with zero commits from us —
> the base floated past our pin. In the controller journal it looks like endless
> `readiness:attempt ... verified=false` + `openshell sandbox get → "sandbox not
> found"` (red herrings; the real error is the base-image build). To SEE the
> real error, nemoclaw suppresses build output — run `nemoclaw onboard` in the
> background, grab the staged context from `/tmp/nemoclaw-build-*` (prefix
> `nemoclaw-build-`, cleaned on exit), then `docker build --progress=plain .`
> it directly (all ARGs default).
>
> **The 2026-07-22 fix:** bumped NemoClaw v0.0.88→v0.0.92 (OpenClaw
> 2026.6.10→2026.7.1) to match the floated base. OpenShell stayed 0.0.85.
> Controller repo: `gatewaydashboard` 9e375c5. See NVIDIA/NemoClaw#7393.
>
> ### DECISION (2026-07-22): freeze the base to a digest, don't track `:latest`
>
> To stop this recurring, manidae-cloud's **cloud** deploy path now pins the
> base image to an **immutable digest** instead of the floating tag. The cloud
> template (`backend/app/core/deployment/terraform_templates/includes/startup_agentgateway.sh.j2`)
> defines `NEMOCLAW_SANDBOX_BASE_IMAGE_REF=ghcr.io/nvidia/nemoclaw/sandbox-base@sha256:<digest>`
> and writes it into the controller's `.env.local`, which is passed through to
> `nemoclaw onboard`. NemoClaw's `imageRefCanRefresh()` never re-pulls a ref
> containing `@sha256:`, so upstream can no longer float us into a broken state.
> The guard also trusts a digest-pinned `sandbox-base@sha256:*` as a first-party
> base. A digest that is OLDER than the target is safe (the build just installs
> the reviewed OpenClaw in-layer); only a NEWER floating tag hard-fails — which
> the digest pin makes impossible.
>
> **LOCKSTEP RULE for every future NemoClaw/OpenClaw bump:** when you move
> `NEMOCLAW_INSTALL_REF` / `OPENCLAW_VERSION`, also refresh the digest so it
> carries the new OpenClaw. Recipe:
>
> ```bash
> docker pull -q ghcr.io/nvidia/nemoclaw/sandbox-base:latest
> docker run --rm ghcr.io/nvidia/nemoclaw/sandbox-base:latest openclaw --version   # must equal OPENCLAW_VERSION
> docker images --digests ghcr.io/nvidia/nemoclaw/sandbox-base | grep latest       # copy the sha256 into NEMOCLAW_SANDBOX_BASE_IMAGE_REF
> ```
>
> Test guarding it: `backend/tests/test_startup_agentgateway_template.py::test_sandbox_base_image_frozen_to_digest`.
> The pin lives in FOUR sync'd places (keep them coherent):
> `install_versioned_nemoclaw_openshell.sh` (controller, version pin only —
> doesn't write runtime env), the cloud template (version + digest, runtime
> env), `vps_validation.py` (BYOVPS AgentGateway phase 1, version pin), and
> `byovps_bootstrap.py` (BYOVPS phase 2, `NEMOCLAW_INSTALL_TAG` + digest in its
> onboard export and `.env.local`). **SPLIT STATE (2026-07-25):** the
> controller installer is now at **v0.0.95** (NemoClaw-tag-only security bump,
> #7524); the three manidae-cloud writers are still at **v0.0.92 / OpenClaw
> 2026.7.1** and must be bumped to v0.0.95 + a refreshed digest to re-coheer.
> Because OpenClaw stays 2026.7.1 across v0.0.92→v0.0.95, the existing digest
> is NOT anti-downgrade-fatal (the base still carries the reviewed OpenClaw),
> so the split is non-breaking — but refresh the digest with the recipe above
> when you bump manidae-cloud. The digest freeze is wired into both manidae
> runtime-env writers (cloud template + `byovps_bootstrap.py`). Full write-up:
> `memory/project_openclaw_floating_base_image_skew.md`.

> **Update (2026-07-11, first live instance of the trixie failure):**
> Debian shipped curl `8.14.1-2+deb13u4` and dropped the pinned `deb13u3`
> from the index — every base-image build (OpenClaw, Hermes, AND the
> per-agent `agents/hermes/Dockerfile.base` +
> `agents/langchain-deepagents-code/Dockerfile.base`, which the old sed
> never touched) died with apt exit 100. In the UI this surfaces as
> "Sandbox creation command failed" immediately (~10 s), journal shows
> `SandboxBaseImageResolutionError ... inputs differ from main`. The
> installer now finds ALL `Dockerfile*` in the tree and also unpins
> `curl`. On a live box, patch `/opt/nemoclaw-src/**/Dockerfile*` in
> place (nemoclaw re-reads them per build; `/opt/nemoclaw-src` is the
> npm-linked install since installer `ae9bdaa`). The pin-check stub
> below identifies the stale package in seconds:
> `docker run --rm node:22-trixie-slim bash -c 'apt-get update -qq;
> apt-cache policy <pkg>'` and compare Candidate to the pin.
>
> **Update (2026-07-09, v0.0.78 bump):** since NemoClaw v0.0.74+
> (commit `1162e89b`) the `Dockerfile` / `Dockerfile.base` base image is
> `node:22-trixie-slim` (Debian 13), **not** `openshell/sandbox-base-u24`
> (Ubuntu noble). The apt pins are now distro-correct, so they resolve —
> until Debian ships a point-release security update that supersedes a
> pinned version and drops it from the live index. Same exit-100
> failure, new cause. `Dockerfile.base` also now carries ~16 pinned
> packages (python3, curl, git, …), not just the original three. The
> cheap pre-flight before any bump: extract the tag's `Dockerfile.base`
> apt layer into a stub dockerfile and
> `docker build --platform linux/amd64` it locally — it fails in
> seconds if any pin has gone stale. Sections below predate this and
> describe the noble era; the sed-unpin strategy itself is unchanged.

## What can break when a pin changes

NemoClaw upstream's Dockerfiles install:

```bash
apt-get install -y --no-install-recommends \
    procps=2:4.0.4-9 \
    e2fsprogs=1.47.2-3+b11 \
    tmux=3.5a-3 \
    ...
```

…inside a conditional that only fires if the package is missing from the
base image. Most of the time `openshell/sandbox-base-u24` already has
them and the install short-circuits. As soon as upstream bumps a base
or one of those packages, the conditional fires, the Debian-style pin
hits Ubuntu noble's apt index, and the build dies.

We don't notice on a happy-path build because the conditional skips.
We notice loudly when:

1. NemoClaw bumps `NEMOCLAW_INSTALL_REF` or `NEMOCLAW_INSTALL_TAG`
   and re-extracts the source on a fresh VPS.
2. NemoClaw rebuilds `sandbox-base-u24` and one of the pinned tools
   drops out.
3. We rebuild from scratch (e.g. CI in a clean container).

## Where the patch lives

`install_versioned_nemoclaw_openshell.sh` sed-patches the extracted
Dockerfiles to drop the version pin on `procps`, `e2fsprogs`, `tmux`.
Apt then picks whatever is actually available on the running base.

The same patch must also be applied to **already-deployed VPS Dockerfiles**
when the bug surfaces post-install (see "After a version bump on a
live VPS" below).

## Distro robustness

The pin failure does **not** depend on the host's Ubuntu version. The
build happens *inside* the docker image whose base is hard-coded to
`openshell/sandbox-base-u24:latest`. Manidae-cloud's host can be 24.04,
22.04, or BYOVPS with anything — irrelevant for this code path. So a
Hetzner box on 22.04 jammy and a Linode box on 24.04 noble both fail
in exactly the same way, and our patch fixes both.

## How to test a version bump *before* shipping

```bash
# 1) On a clean VPS (or after `rm -rf /opt/nemoclaw`):
./install_versioned_nemoclaw_openshell.sh
# Should finish without docker build errors.

# 2) Inspect the extracted Dockerfiles for NEW pinned apt installs
#    beyond the three we know about:
grep -nE 'apt-get install.*=[0-9]+' /opt/nemoclaw/Dockerfile /opt/nemoclaw/Dockerfile.base
# Expected (since v0.0.74+/trixie): `procps`, `e2fsprogs`, `tmux` appear
# unpinned (stripped by the installer's sed); Dockerfile.base additionally
# has a large upstream-intended pinned block (python3, curl, git, …).
# Those pins are legitimate on trixie — only add one to the sed block if
# the build actually fails on it (superseded point-release version).

# 3) End-to-end smoke test: create a real sandbox through the controller.
COOKIE=$(curl -sS -i -X POST http://127.0.0.1:3000/api/auth/login \
  -H 'Content-Type: application/json' \
  -d "{\"password\":\"$OP_PW\"}" \
  | grep -i set-cookie | head -1 \
  | sed -E 's/.*openshell_control_session=([^;]+).*/\1/')
curl -sS --max-time 720 -b "openshell_control_session=$COOKIE" \
  -X POST -H 'Content-Type: application/json' \
  -d '{"blueprint":"nemoclaw-blueprint","sandboxName":"smoke","gpuMode":"none","createInference":{"mode":"auto"}}' \
  http://127.0.0.1:3000/api/sandbox/create \
  | python3 -c 'import json,sys; d=json.load(sys.stdin); print("created=", d.get("created"), "verified=", d.get("verification",{}).get("verified"))'

# Expect: created=True, verified=True. Then clean up:
openshell sandbox delete smoke
```

## If a new pinned package shows up

Extend the sed block in `install_versioned_nemoclaw_openshell.sh`:

```bash
sed -i.bak \
  -e 's/procps=2:4\.0\.4-9/procps/g' \
  -e 's/e2fsprogs=1\.47\.2-3+b11/e2fsprogs/g' \
  -e 's/tmux=3\.5a-3/tmux/g' \
  -e 's/NEW_PACKAGE_NAME=[^[:space:]\\]*/NEW_PACKAGE_NAME/g' \
  "$_dockerfile" && rm -f "${_dockerfile}.bak"
```

The wildcard form (`s/PKG=[^[:space:]\\]*/PKG/g`) is preferred when you
don't want to chase exact version strings.

## After a version bump on a live VPS

If the failure has already surfaced (sandbox creation hangs and times
out), the Dockerfiles on disk are already stale. Patch them in place
before retrying — the controller doesn't re-extract until the install
script runs again:

```bash
ssh <vps> '
  for f in /opt/nemoclaw/Dockerfile /opt/nemoclaw/Dockerfile.base; do
    sed -i \
      -e "s/procps=2:4\\.0\\.4-9/procps/g" \
      -e "s/e2fsprogs=1\\.47\\.2-3+b11/e2fsprogs/g" \
      -e "s/tmux=3\\.5a-3/tmux/g" \
      "$f"
  done'
```

Then re-create the sandbox through the controller UI. No service
restart needed; nemoclaw re-reads the Dockerfiles per build.

## Other places that pin versions (audit notes)

- **`install_versioned_nemoclaw_openshell.sh`** — pins `OPENSHELL_VERSION`,
  `NEMOCLAW_INSTALL_REF`, `OPENCLAW_VERSION`. Bumping any of these can
  re-introduce the Dockerfile-pin failure if NemoClaw added new pins.
- **`package.json`** — Next.js, React, `xterm`, `node-pty`. These pin the
  *controller's* build, not the sandbox build. Standard `npm install`
  validation suffices.
- **`Dockerfile.base` ARG OPENCLAW_VERSION** — set by `--build-arg` from
  `install_versioned_nemoclaw_openshell.sh`. Bumps here need a re-test
  of `openclaw doctor --generate-gateway-token` because the CLI surface
  can change (we've already seen flag renames in this CLI's recent
  history).
- **`tests/sandbox-lifecycle-check.mjs`** — has version-aware
  assertions. Re-run after any bump.

**General rule:** bump one version at a time, re-run the smoke test
above, and grep the extracted Dockerfiles for new pinned apt installs
before declaring the bump done.

## Pre-flight additions learned on the v0.0.80 bump (2026-07-11)

Do these against a local shallow checkout BEFORE editing the pin
(`git fetch --depth 1 origin <tag>`; note release tags are ANNOTATED —
`git rev-parse FETCH_HEAD^{commit}` for the real commit sha, which is
also what base-image tags like `nemoclaw-hermes-sandbox-base-local:<sha>`
use; `git describe --tags` fails on our tag-less shallow clones, use
`git log -1 --format=%h`):

1. **Diff `scripts/install.sh` and `src/lib/actions/` between the pins,
   not just the Dockerfiles.** v0.0.80 added `upgrade-sandboxes --auto`
   to the install flow — a behavior change that rebuilds running stale
   sandboxes (see live-vps-upgrades.md Policy). Dockerfile-only review
   would have missed it entirely.
2. Check which of our wrapper seds still match: the apt unpin list AND
   the backup `maxBuffer` shim (`grep -c 'maxBuffer: 256' src/lib/state/
   sandbox.ts` — still 3 sites in v0.0.80).
3. Check `nemoclaw-blueprint/blueprint.yaml` `min/max_openshell_version`
   (still 0.0.72 at v0.0.80 → `--skip-openshell` path stays valid) and
   `agents/*/manifest.yaml` `expected_version` — those decide which live
   sandboxes the v0.0.80+ installer will auto-rebuild.
4. Walk `docs/upstream-divergence-audit.md` for shims the new tag
   obsoletes (v0.0.80: none — `upgrade-hermes.sh` stays a safe no-op,
   short-circuiting at >=0.16).
5. **If the Hermes pin moves** (`agents/hermes/Dockerfile.base`
   `HERMES_VERSION`): re-check the dashboard guard functions in Hermes'
   `hermes_cli/web_server.py` — `_is_accepted_host`,
   `_ws_host_origin_is_allowed`, `_ws_client_is_allowed`, and the
   non-loopback bind auth-provider gate. Our remote-desktop exposure is
   calibrated to their 0.18 semantics (HERMES_REMOTE_DESKTOP.md §1a);
   the 0.17→0.18 bump silently broke every exposure until adapted.
