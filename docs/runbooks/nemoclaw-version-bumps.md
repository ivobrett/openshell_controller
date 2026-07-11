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
