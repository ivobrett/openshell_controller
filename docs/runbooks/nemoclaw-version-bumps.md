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

> **⚠️ RETIRED 2026-09-13 — DO NOT set `NEMOCLAW_SANDBOX_BASE_IMAGE_REF` for
> 'openclaw' sandboxes anymore.** Everything below this notice through the end
> of the "DECISION" subsection describes the digest-freeze mechanism this
> repo carried from 2026-07-22 through v0.0.120 — it is now **actively
> harmful**, not just obsolete. Read it for history, but do not follow its
> recipe.
>
> **What broke:** fresh 'openclaw' sandbox creation on NemoClaw v0.0.121+
> hard-fails with `Error: Sandbox workload preparation failed:
> 'NEMOCLAW_SANDBOX_BASE_IMAGE_REF' is set, but the managed image workload for
> 'openclaw' installs an exact, pre-verified digest and does not consult this
> override. ... otherwise unset 'NEMOCLAW_SANDBOX_BASE_IMAGE_REF' to use the
> managed image.` In the controller journal this is masked by the SAME
> "endless `readiness:attempt ... verified=false`" symptom described below for
> the ORIGINAL float-drift failure — you must read the `ready-command`
> subprocess's stderr (`journalctl -u openshell-controller`, grep
> `ready-command:close-stderr`) to see the real error; `openshell sandbox get`
> just reports "sandbox not found" like every other stuck-onboarding case.
>
> **Root cause (traced in NemoClaw source, `src/lib/onboard/workload/preparation.ts`
> `rejectManagedWorkloadBaseImageOverride`, upstream issue #11138):** `openclaw`
> has been a `SHIPPED_MANAGED_IMAGE_AGENT` — NemoClaw resolves its own
> pre-verified digest internally, keyed to the installed NemoClaw release —
> since before v0.0.108. Our `NEMOCLAW_SANDBOX_BASE_IMAGE_REF` override was
> therefore **already a silently-ignored no-op for openclaw the entire time we
> maintained it**; NemoClaw v0.0.121..v0.0.123 just added a fail-closed guard
> that turns the silent-ignore into a hard error instead (a good change on
> their part — it caught our stale assumption). NemoClaw's managed image
> catalog structurally can't drift the way `sandbox-base:latest` could, so it
> already solves the exact problem this override existed for. The fix is
> deletion, not a re-pin — confirmed live 2026-09-13: unsetting the override
> let a fresh `nemoclaw onboard --name my-claw` complete with "Deployment
> verified — gateway, dashboard, and inference route are healthy."
>
> **What changed:** `NEMOCLAW_SANDBOX_BASE_IMAGE_REF` is no longer written or
> exported anywhere — removed from manidae-cloud's `startup_agentgateway.sh.j2`,
> `startup_nemoclaw.sh.j2`, and `byovps_bootstrap.py` (the three of the five
> pin-writer files that ever carried it; `vps_validation.py` and this repo's
> `install_versioned_nemoclaw_openshell.sh` never set it). Their regression
> tests were inverted to guard the removal, same pattern as
> `test_audit_signatures_shim_removed_as_obsolete`. **If a box already has
> `NEMOCLAW_SANDBOX_BASE_IMAGE_REF=...` in `/opt/openshell-controller/.env.local`
> from a PRIOR provisioning run, that line must be removed (comment it out)
> and `openshell-controller` restarted before fresh openclaw sandboxes will
> onboard** — a re-provision does not happen automatically on an existing box.
>
> If NemoClaw ever ships a genuinely non-managed-image agent that needs a
> base-image override again, it gets its own env var name — every agent
> except `openclaw`/`nemocua` uses
> `NEMOCLAW_<AGENT>_SANDBOX_BASE_IMAGE_REF` (see NemoClaw's
> `getAgentSandboxBaseImageEnvVar`) — so reintroducing the mechanism for a
> different agent would not collide with this retirement.
>
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
> `NEMOCLAW_INSTALL_REF` / `OPENCLAW_VERSION`, also refresh the digest.
>
> **PIN FROM THE RELEASE TAG, NEVER FROM `:latest`.** `sandbox-base:latest` is
> rebuilt continuously and floats ahead of the NemoClaw tag you are installing.
> Pin from `sandbox-base:v<NEMOCLAW_INSTALL_REF>` — the base that release was
> cut against. Recipe:
>
> ```bash
> TAG=v0.0.116   # == NEMOCLAW_INSTALL_REF
> REF="ghcr.io/nvidia/nemoclaw/sandbox-base:$TAG"
> docker pull -q "$REF"
> # 1. anti-downgrade guard — must equal OPENCLAW_VERSION
> docker run --rm --network none --entrypoint /bin/sh "$REF" -c 'openclaw --version'
> # 2. security-package inventory — must be byte-identical to the inventory in
> #    NemoClaw's src/lib/sandbox-base-image/security-inventory.ts at $TAG
> #    (and root:root 0444). SINCE v0.0.116 THERE ARE TWO LISTS: use the LONGER
> #    OPENCLAW_SANDBOX_BASE_SECURITY_PACKAGE_INVENTORY — that is the one
> #    openClawSandboxBaseImageHasSecurityInventory() applies to this
> #    digest-pinned sandbox-base override. (The shorter
> #    SANDBOX_BASE_SECURITY_PACKAGE_INVENTORY covers the per-agent base images.)
> docker run --rm --network none --entrypoint /bin/sh "$REF" -c \
>   'stat -c %u:%g:%a /usr/local/share/nemoclaw/security-packages.txt; \
>    cat /usr/local/share/nemoclaw/security-packages.txt'
> # 3. copy the sha256 into NEMOCLAW_SANDBOX_BASE_IMAGE_REF
> docker inspect --format '{{index .RepoDigests 0}}' "$REF"
> ```
>
> **Step 2 is NOT optional — skipping it caused a total fresh-deploy outage on
> 2026-08-15.** NemoClaw v0.0.108 added `sandboxBaseImageHasSecurityInventory()`,
> which execs into the base image and byte-compares
> `/usr/local/share/nemoclaw/security-packages.txt` against a hard-coded list.
> The digest refreshed from `:latest` on 2026-08-14 (`sha256:929a45a9…`) passed
> the `openclaw --version` check (still 2026.7.1) but carried
> `vim-common`/`vim-tiny` `2:9.2.0858-1` (expected `2:9.2.0782-1`) and
> `libssh2-1t64 …+nemoclaw2` (expected `…+nemoclaw1`). Every OpenClaw and Hermes
> create on a fresh box died with:
>
> ```
> Warning: OpenClaw sandbox base image … lacks the immutable security package inventory.
> Error: OpenClaw sandbox base image override '…' could not be resolved to an
> immutable trusted digest or failed required compatibility checks.
> ```
>
> Fixed by re-pinning to the `v0.0.108` release tag,
> `sha256:7643e189773a01f12a1beacd3bbc0ef709d7ca748e10c9f00222039f4d4c6aac`.
> Note the **controller's own installer is unaffected** — it *builds*
> `Dockerfile.base` locally and tags it, rather than pulling the remote tag.
>
> Test guarding it: `backend/tests/test_startup_agentgateway_template.py::test_sandbox_base_image_frozen_to_digest`.
> The pin lives in **FIVE** sync'd places (keep them coherent):
> `install_versioned_nemoclaw_openshell.sh` (controller, version pin only —
> doesn't write runtime env), the cloud AgentGateway template
> `startup_agentgateway.sh.j2` (version + digest, runtime env),
> `startup_nemoclaw.sh.j2` (cloud **NemoClaw package** path, version + digest —
> joined the set on 2026-08-23 when it was un-stranded from `v0.0.73`),
> `vps_validation.py` (BYOVPS AgentGateway phase 1, version pin), and
> `byovps_bootstrap.py` (BYOVPS phase 2, `NEMOCLAW_INSTALL_TAG` + digest in its
> onboard export and `.env.local`). **COHERENT (2026-09-05):** all five writers
> are at **v0.0.120 / OpenShell 0.0.106 / OpenClaw 2026.7.1 / Hermes 0.20.6**.
> This bump **IS tag-only** on the OpenShell/OpenClaw/pi/langchain axes —
> `--skip-openshell` is VALID for a live box already at 0.0.106 (a box still on
> 0.0.101, or 0.0.85, has not caught up and still crosses the earlier
> destructive window(s) first). Hermes DID move (0.19.0 → 0.20.6), so
> `upgrade-sandboxes --auto` will rebuild Hermes sandboxes only.
> The base-image digest is
> `sha256:58a88e885f2b9df7334d5b6246dc2aed9bfb0a7effe943fc0e044da88a6c5863`
> — the **`sandbox-base:v0.0.120` release tag** (OpenClaw 2026.7.1, security
> inventory byte-identical to v0.0.116's, root:root 0444).
> **The digest still had to move — for the FOURTH consecutive bump — while
> `openclaw --version` stayed at 2026.7.1.** This is now the rule, not the
> exception: treat step 2 of the recipe as the load-bearing check and
> `openclaw --version` as the cheap one. This time the trigger wasn't the
> security inventory (byte-identical to v0.0.116) but the OpenClaw npm
> lockfile SHA (`OPENCLAW_LOCK_SHA256` in `Dockerfile.base`) plus other
> Docker-layer content — verify the digest by inspecting the GHCR manifest
> directly (`docker buildx imagetools inspect
> ghcr.io/nvidia/nemoclaw/sandbox-base:v<TAG>`) rather than assuming "no
> inventory change" means "no digest change".
> Digest history: `03a1a319…` (v0.0.116, 2026-08-30); `31fcee7b…` (v0.0.113,
> 2026-08-22); `7643e189…` (v0.0.108, corrected 2026-08-15 from
> `sha256:929a45a9…`, which had been taken from the floating `:latest` on
> 2026-08-14 and broke every create — note that bad image was in fact carrying
> the *future* v0.0.113 package set). The digest freeze is wired into all three
> manidae runtime-env writers (both cloud templates + `byovps_bootstrap.py`).
> Full write-up: `memory/project_openclaw_floating_base_image_skew.md`.
>
> ### v0.0.120 → v0.0.123 pre-flight results (2026-09-13)
>
> Discussions NVIDIA/NemoClaw#11278 (v0.0.121), #11408 (v0.0.122), #11537
> (v0.0.123) — 3 releases. **Clean tag-only bump on every axis this fork
> depends on** — the first bump since v0.0.108 that required zero code
> changes, only pin/digest edits. `nemoclaw-blueprint/blueprint.yaml` OpenShell
> bound is byte-identical (min==max stays `0.0.106`; v0.0.121's #11253
> "reviewed OpenShell 0.0.116 replacement identities" is confirmed
> test-fixture-only plumbing, not an active pin change — watch for it to go
> live in a future bump). `ARG OPENCLAW_VERSION` stays `2026.7.1`, `ARG
> HERMES_VERSION` stays `v2026.8.27` (0.20.6, UNCHANGED this bump — no
> upstream hermes-agent diff exists, so the mandatory
> `hermes_cli/web_server.py` guard re-check is a no-op and
> `HERMES_REMOTE_DESKTOP.md` §1a needs no recalibration). `pi` (0.84.1) and
> `langchain-deepagents-code` (0.1.55) are unchanged, `package.json` stays
> `0.1.0` — `upgrade-sandboxes --auto` has nothing stale to rebuild. The
> security package inventory (both `SANDBOX_BASE_SECURITY_PACKAGE_INVENTORY`
> and `OPENCLAW_SANDBOX_BASE_SECURITY_PACKAGE_INVENTORY`) is byte-identical to
> v0.0.120 — no new apt pins beyond the three known ones (`procps`,
> `e2fsprogs`, `tmux`), nothing new to unpin. `maxBuffer: 256` shim still
> anchors at 3 sites in `src/lib/state/sandbox.ts`. `npm audit signatures`
> stays retired. Shields stay removed (only retirement-workflow test files
> remain at v0.0.123).
>
> Two v0.0.123 features were checked and confirmed inert for us: the
> experimental external-host-component registration
> (`src/lib/onboard/external-component/index.ts`) only activates if
> `~/.config/nemoclaw/external-component.json` exists, which nothing in this
> fork ever creates — even though we always pass `--fresh` to onboarding
> (commit `ef6733c`); and the stopped-sandbox status change
> (`status-preflight.ts`, #11211/#11091) only engages when a sandbox's
> registry row has `stopped === true`, which a gateway-death scenario
> (CLAUDE.md §3) never sets, so normal `nemoclaw <sandbox> recover` still
> triggers as documented. The v0.0.122 remote-dashboard-bind refactor
> (`resolveDashboardPlatformHints()`, #10931) touches only NemoClaw's own
> `nemoclaw <sandbox> dashboard` forwarding and `NEMOCLAW_DASHBOARD_BIND` /
> `CHAT_UI_URL`, both of which already existed at v0.0.120 and which this fork
> never sets — confirmed by grep, distinct from our own SSH-tunnel-based
> OpenClaw dashboard-token architecture (CLAUDE.md §10).
>
> The digest still had to move despite the unchanged pins and byte-identical
> inventory — same pattern as every bump since v0.0.108. New digest:
> `sha256:2f3c8820fd355b337631e060d80ed8d85236aa3bc96db6ce3cdd212eb2af975c`
> (the `sandbox-base:v0.0.123` release tag's multi-arch manifest index,
> verified 2026-09-13 via `docker buildx imagetools inspect
> ghcr.io/nvidia/nemoclaw/sandbox-base:v0.0.123`; `openclaw --version` inside
> confirms 2026.7.1). Pushed to all five sync'd locations: this repo's
> `install_versioned_nemoclaw_openshell.sh` (pin only), and manidae-cloud's
> `startup_agentgateway.sh.j2`, `startup_nemoclaw.sh.j2`, `vps_validation.py`
> (pin only, no digest — same as the controller), and `byovps_bootstrap.py`
> (pin + digest).
>
> ### v0.0.116 → v0.0.120 pre-flight results (2026-09-05)
>
> Discussion NVIDIA/NemoClaw#11104, 4 releases (v0.0.117..v0.0.120).
> `nemoclaw-blueprint/blueprint.yaml` OpenShell bound is byte-identical
> (min==max stays `0.0.106`), `ARG OPENCLAW_VERSION` stays `2026.7.1`, `pi`
> (0.84.1) and `langchain-deepagents-code` (0.1.55) are unchanged, and
> `package.json` stays `0.1.0`. **Hermes moved 0.19.0 → 0.20.6** — the guard
> re-check is logged in step 5 below (result: no recalibration needed). The
> security package inventory (`SANDBOX_BASE_SECURITY_PACKAGE_INVENTORY` /
> `OPENCLAW_SANDBOX_BASE_SECURITY_PACKAGE_INVENTORY`) is byte-identical to
> v0.0.116 — no new apt pins, nothing new to unpin, all 26 live-index pins from
> the v0.0.116 scan still resolve. `maxBuffer: 256` shim still anchors at 3
> sites in `src/lib/state/sandbox.ts`.
>
> **Shields removed from NemoClaw core (#10722).** Every file under
> `src/lib/shields/` and the `nemoclaw <sandbox> shields up|down|status` CLI
> subcommands are gone at v0.0.120 (verified by diffing the tag's file tree).
> This fork had a first-class feature built on that CLI surface —
> `app/components/ShieldsPanel.tsx`, `app/api/sandbox/[sandboxId]/shields/route.ts`,
> and the Shields functions in `app/lib/nemoclawCli.ts` — which is REMOVED in
> the same commit as this bump (see `install_versioned_nemoclaw_openshell.sh`'s
> header comment for the full file list). `upgrade-sandboxes` also gained
> `enforceRemovedImmutabilityMigrationBoundary()`, which throws and demands a
> host reboot + manual quarantine if a sandbox being rebuilt still has an
> in-flight Shields-transition marker (`shields-timer-*` etc.) from the old
> binary — it tolerates a plain past-use "state record" but not a live
> transition. Under this bump it can only fire on the Hermes sandboxes that
> actually rebuild.
>
> Managed dashboard/messaging/MCP forwarding moved from ambient
> NemoClaw-owned SSH-forwarding receipts to detached `openshell forward
> service` processes — this is internal to NemoClaw's own `nemoclaw <sb>
> dashboard`/messaging/MCP CLI paths and does not touch our own SSH tunnel in
> `app/lib/openshellHost.ts` (`ensureSandboxOpenClawDashboardTunnel`), which
> execs `openclaw gateway run` directly over our own `openshell ssh-proxy`
> ProxyCommand and never calls into NemoClaw's forwarding machinery.
> `nemoclaw <sandbox> recover` (CLAUDE.md §3) is unaffected as a black-box CLI
> invocation.
>
> The default Model Router pool swapped `nemotron-3-nano-reasoning` for
> `gpt-oss-20b-high` in `nemoclaw-blueprint/router/pool-config.yaml` — no
> impact, our deployments pin `nvidia-prod`/`nemotron-3-super-120b-a12b`
> directly rather than using the router pool.
>
> ### v0.0.113 → v0.0.116 pre-flight results (2026-08-30)
>
> Discussion NVIDIA/NemoClaw#10594, 3 releases (v0.0.114..v0.0.116), tag
> `v0.0.116` = commit `b12bede`. **A pure tag-only bump on every axis that
> matters:** `nemoclaw-blueprint/blueprint.yaml` is byte-identical
> (min==max_openshell_version stays `0.0.106`), `ARG OPENCLAW_VERSION` stays
> `2026.7.1`, `ARG HERMES_VERSION` stays `v2026.7.20` (0.19.0), and **no agent
> `expected_version` moved** (hermes 0.19.0, openclaw 2026.7.1,
> langchain-deepagents-code 0.1.55, pi 0.84.1) with `package.json` still
> `0.1.0`. `src/lib/sandbox/version.ts` — the staleness logic itself — is also
> unchanged. So `upgrade-sandboxes --auto` has nothing to rebuild and no running
> sandbox is recreated. The Hermes guard re-check below is **not triggered**
> (`agents/hermes/start.sh` did change, but only to add
> `HERMES_LAZY_INSTALL_TARGET` and one extra config-hash reconciliation — no
> bind-address, Origin-allowlist or auth-provider semantics moved).
> The `maxBuffer: 256` shim still anchors at 3 sites in
> `src/lib/state/sandbox.ts`; `npm audit signatures` is still absent upstream,
> so the shim retired at v0.0.108 stays retired; `node:22-trixie-slim@sha256:db8a96a6…`
> is unchanged. OpenShell did not move, so the workspace-qualified container-name
> resolvers (commit `2731e3d`) need no re-check either.
>
> **ONE NEW live-index apt pin — and it is the FIRST one we must NOT unpin.**
> `libssl3t64=3.5.7-1~deb13u2` (OpenSSL 3.5.7, #10532) joins the main
> `Dockerfile.base` apt block and `Dockerfile`, `agents/hermes`,
> `agents/langchain-deepagents-code`, `agents/pi`. Every other pin we unpin is
> "just" an apt pin; this one is **also byte-verified by NemoClaw's frozen
> security inventory** — a `test "$(dpkg-query -W libssl3t64)" = "3.5.7-1~deb13u2"`
> assertion AND a `security-packages.txt` line compared against
> `SANDBOX_BASE_SECURITY_PACKAGE_INVENTORY`. Unpinning it would let apt select a
> newer OpenSSL and fail both, trading a recoverable apt exit 100 for an
> unrecoverable inventory failure. **If trixie ever supersedes it, the only fix
> is a NemoClaw tag bump — do not reach for the sed.** `libssl-dev` moved
> `3.5.6-1~deb13u2`→`3.5.7-1~deb13u2` in the same block but is already
> wildcard-unpinned and is *not* inventory-verified, so it needed no change.
> `libevent-core-2.1-7t64=2.1.13-stable-1` (#10526) is a SHA256-pinned
> frozen-snapshot `.deb` installed with `dpkg -i` — frozen, so no unpin either.
> All 26 live-index pins were re-scanned against trixie on 2026-08-30 (via
> `apt-cache madison` inside the pinned base) and every one resolves.
>
> **The security inventory grew a SECOND list.** v0.0.116 adds
> `libssl3t64=3.5.7-1~deb13u2` to `SANDBOX_BASE_SECURITY_PACKAGE_INVENTORY`, and
> introduces `OPENCLAW_SANDBOX_BASE_SECURITY_PACKAGE_INVENTORY` = that list plus
> `libevent-core-2.1-7t64=2.1.13-stable-1`. The old
> `sandboxBaseImageHasSecurityInventory()` now covers only the *agent* base
> images (`src/lib/agent/base-image.ts`,
> `src/lib/agent/deep-agents-code-base-image.ts`); the new
> `openClawSandboxBaseImageHasSecurityInventory()` in `src/lib/onboard/base-image.ts`
> is what validates **our digest-pinned `NEMOCLAW_SANDBOX_BASE_IMAGE_REF`**. So
> when you run step 2 of the recipe, the `sandbox-base` image's
> `security-packages.txt` must match the **OpenClaw** (longer) list — 12 package
> lines plus the leading `architecture=<arch>`.
>
> **BEHAVIOUR CHANGE on the upgrade path (#10211):**
> `upgrade-sandboxes --check` now `process.exit(1)` when it finds stale,
> unknown, orphaned or recovery-candidate sandboxes; it used to exit 0 and only
> print. Non-zero is the NORMAL "there is work to do" signal — do not run it
> under `set -e`, and do not read exit 1 as a broken CLI. Only the literal "All
> sandboxes are up to date" path exits 0. See
> `docs/runbooks/byovps-controller-upgrade.md` step 1.
>
> Other upstream changes reviewed and found not to touch us: uninstall now
> snapshots before deleting unless `--destroy-user-data` (#10231/#10550/#10562)
> — the controller never invokes `nemoclaw uninstall`; a new
> `--defer-onboarding` install flag (Hermes-only, hosted-inference-only) which
> we do not use; and `scripts/install.sh` now hard-errors instead of skipping
> the nvm integrity check when no `sha256sum`/`shasum` exists.
>
> ### v0.0.108 → v0.0.113 pre-flight results (2026-08-22)
>
> No new apt pins — the pinned package SET is identical to v0.0.108, and the two
> versions that moved are not index-resolved (vim from frozen snapshot
> `20260727T143429Z`, libssh2 built in-tree), so the unpin sed list is
> UNCHANGED. All 23 live-index pins re-scanned against trixie and every one
> resolves. The `maxBuffer: 256` shim still anchors at 3 sites in
> `src/lib/state/sandbox.ts`. `npm audit signatures` is still absent upstream, so
> the shim retired at v0.0.108 stays retired. OpenShell's
> `container_name_for_sandbox()` is **byte-identical** across 0.0.101→0.0.106, so
> the workspace-qualified container-name resolvers (commit `2731e3d`,
> `tests/sandbox-container-name-workspace-check.mjs`) need no change.
>
> ### Second v0.0.108 fresh-deploy regression — the gateway placeholder
>
> Independent of the digest, v0.0.108 also broke fresh deploys via the
> **`nemoclaw`@17670 gateway placeholder** that manidae's provisioning used to
> register. v0.0.108's gateway-authority preflight resolves the managed gateway
> name `nemoclaw` at its expected port 8080 and compares the registered
> endpoint; `17670 != 8080` yields `endpointBinding = "mismatch"`, which with
> `reuseState = "healthy"` becomes a **blocking** `gateway.port.owner_mismatch`
> finding. `nemoclaw onboard` aborts in ~1.4s with "The gateway port is held by
> an incompatible or ambiguous owner. / Gateway port 8080 is occupied by an
> unknown listener" — the second line is misleading, nothing is on 8080. Our own
> bootstrap placeholder blocked the onboarding that used to re-point it.
>
> It also **masked a second blocker**: NemoClaw only auto-remediates the Docker
> containerd-snapshotter conflict (`host.docker.storage_incompatible`, hit on
> Docker 26+ with no `/etc/docker/daemon.json`) when
> `hasRemediableStorageConflict()` sees *exactly one* blocking finding.
>
> Fix: never pre-register `nemoclaw`; let `onboard` create it on 8080. Applied
> in manidae-cloud (`startup_agentgateway.sh.j2`, `vps_validation.py`,
> `byovps_bootstrap.py`) 2026-08-15. `nemoclaw host probe --json` is the
> diagnostic — read `gateway.port_conflict` / `gateway.owner.port`, not the
> user-facing message.
>
> ### Shim retired at v0.0.108 — `npm audit signatures`
>
> Upstream moved Sigstore auditing OUT of the image builds (discussion #8944),
> so `npm --prefix … mcporter-runtime audit signatures` no longer appears in any
> Dockerfile. Our best-effort wrap in **both** the controller installer and
> `startup_agentgateway.sh.j2` had degraded to a silent no-op and has been
> removed. This retires the Sigstore-TUF-403 failure class
> (`memory/project_openclaw_build_audit_signatures_tuf_403.md`). The
> manidae-cloud test `test_audit_signatures_made_best_effort` was **inverted**
> to `test_audit_signatures_shim_removed_as_obsolete`, so a careless re-add is
> still caught. If a future tag reintroduces the in-build command, invert the
> test back and restore the wrap from history (controller `6f366fc`,
> manidae-cloud `4d673add`).
>
> ### New live-index apt pins at v0.0.108
>
> `libssl-dev`, `openssh-server`, `zlib1g-dev`, `util-linux` are new pins in
> `Dockerfile.base`'s `native-security-builder` and runtime stages. They read the
> LIVE trixie index, so they carry the usual point-release drift risk; all four
> were unpinned pre-emptively (controller installer + cloud template — **not**
> `vps_validation.py`, which retains its known older three-package form).
> All 24 live-index pins were scanned against the index on 2026-08-14 and every
> one still resolved, so this bump was not blocked on a stale pin. Scan recipe:
> run `apt-cache madison <pkg>` for each pin inside the exact base digest
> (`node:22-trixie-slim@sha256:db8a96a6…`) and compare to the pinned string.
> Note `libexpat1` moved 2.8.2-1→2.8.3-1 but is fetched as a SHA256-pinned .deb
> from a NEW frozen snapshot (`20260811T082421Z`, alongside the existing
> `20260724T000000Z` for jq/Vim) — frozen, so no unpin needed.

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

## v0.0.123 → main@e38726c8d7 (2026-09-19) — OpenShell floor moved + OpenClaw needs a SHA

> **Shipped ref: the main-branch commit `e38726c8d792dc99c03ce3a29619ed21f7d32d34`
> (2026-09-18, 28 commits past tag v0.0.127), NOT the v0.0.127 tag.**
>
> **Why a SHA.** OpenClaw 2026.9.1 exists on no NemoClaw tag — it landed on
> main one day after v0.0.127 was cut. `Dockerfile.base` carries a
> per-OpenClaw-version integrity hash and rejects any other value, so the
> NemoClaw ref and `OPENCLAW_VERSION` are a **package deal**:
>
> | ref | OPENCLAW_VERSION | valid |
> |---|---|---|
> | tag v0.0.122..v0.0.127 | 2026.7.1 | ✅ |
> | main @ e38726c8d7 | 2026.9.1 | ✅ |
> | tag v0.0.127 | 2026.9.1 | ❌ no hash |
> | main @ e38726c8d7 | 2026.7.1 | ❌ hash dropped from main |
>
> This is the 2026-07-05 situation again (interim SHA `1162e89` for OpenClaw
> 2026.6.10). **Retire it the same way: move to the first TAG whose
> `Dockerfile.base` carries 2026.9.1's hash.** Pin the SHA, not the bare
> `main` that upstream tracks — see the v0.0.88 float outage above.
>
> **The tag also carries a real bug the SHA fixes (NemoClaw #12047).**
> #11933 (in v0.0.127) restored a Hermes call to
> `/usr/local/bin/nemoclaw-gateway-control`, which #11792 had removed from
> managed images. Gateway observation then returns "unknown" while the
> gateway and inference route are healthy, so Hermes `sandbox start` and
> `connect --probe-only` never finish after a stopped sandbox recovers —
> exactly the path a destructive window exercises for every sandbox.
>
> **Coupled code change.** Taking OpenClaw 2026.9.1 retires
> `repairOpenClawExecApprovalsFile`. It rewrote
> `/sandbox/.openclaw/exec-approvals.json` to replace a symlink older
> OpenClaw builds left there; 2026.9.1 writes a real sandbox-owned file
> itself, so the repair now deletes and rewrites live approvals state on
> every create. Removed from `create/route.ts` (3 sites),
> `sandboxMcpManifest.ts`, and `sandboxPrivilegedFiles.ts`;
> `tests/sandbox-lifecycle-check.mjs` now guards the removal. Upstream did
> the same in its 2026.9.1 sync (mmckeen-nv#50). `writeSandboxFilePrivileged`
> STAYS — our MCP manifest still needs it.
>
> Because OpenClaw moves, `upgrade-sandboxes --auto` WILL rebuild OpenClaw
> sandboxes (so they dodge the token-TTL trap); Hermes stays 0.20.6 and is
> only restarted, so Hermes sandboxes still race it. That is the opposite of
> what the v0.0.127-tag plan implied — re-read the note below with that in
> mind.

### Original tag-only analysis (v0.0.127), kept for the OpenShell reasoning

**Read this before assuming any future NemoClaw bump is tag-only.** The
v0.0.120→v0.0.123 and v0.0.116→v0.0.120 bumps were tag-only on the
OpenShell axis, and it is easy to carry that assumption forward. It broke
at v0.0.124.

| Axis | v0.0.123 | v0.0.127 | Moves? |
|---|---|---|---|
| blueprint `min`/`max_openshell_version` | `0.0.106` | `0.0.116` | **YES — at v0.0.124** |
| OpenClaw | 2026.7.1 | 2026.7.1 | no |
| Hermes (`agents/hermes/manifest.yaml` `expected_version`) | 0.20.6 | 0.20.6 | no |
| blueprint sandbox digest | `sha256:b3d832b5…` | `sha256:b3d832b5…` | no |

### Consequence: `--skip-openshell` is no longer valid

An OpenShell reinstall is unavoidable on any box at 0.0.106, and it takes
every sandbox container down (Trap 1 in `live-vps-upgrades.md`). The
governing runbook is `live-openshell-bump-with-agent-upgrade.md`, **not**
`byovps-controller-upgrade.md`.

### …but this bump does NOT match that runbook's stated conditions

`live-openshell-bump-with-agent-upgrade.md` §"When this runbook applies"
requires all three of: (1) OpenShell pin > box's version, (2) you must keep
agent data, (3) **at least one agent's pinned version moves**, so
`upgrade-sandboxes --auto` rebuilds it. Conditions 1 and 2 hold here;
**condition 3 does not** — neither OpenClaw nor Hermes moves.

That makes the window *differently* risky, not less risky:

- Nothing is rebuilt for version reasons, so **no sandbox gets the fresh
  container + fresh token that a rebuild grants**. Every sandbox is merely
  restarted, so every sandbox races the sandbox-token TTL (Trap 2) with no
  rebuild to dodge it. Minimise the Exited window; keep the raw `docker cp`
  backup as the recreate-from-scratch safety net.
- Conversely, the v0.0.124+ agent images are materially rewritten by #11792
  (`agents/hermes/start.sh` alone lost ~1100 lines), so
  `upgrade-sandboxes --check` may well report existing sandboxes as stale
  anyway. **Run it first and let its answer, not this table, pick the
  plan.** Remember it exits 1 when there is work to do — that is the normal
  signal, so don't run it under `set -e` (#10211).

### The defensive `max_openshell_version` sed does not save you

`startup_agentgateway.sh.j2` seds NemoClaw's blueprint `max_openshell_version`
up to match the installed OpenShell. It **only touches `max`, never `min`**.
With the floor now at 0.0.116, a box whose OpenShell install failed or was
skipped sits at 0.0.106 < min and `nemoclaw onboard` hard-refuses — which
surfaces as the usual endless `readiness:attempt … verified=false` hang, not
as a clear error. Check `openshell --version` on the box first.

### What was verified against the v0.0.123..v0.0.127 source diff

The headline change (#11792) returned gateway lifecycle authority to the
native agents: OpenClaw and Hermes now own their gateways, plugins,
packages, child processes and hooks, while NemoClaw keeps sandbox selection,
credential projection, health observation and host-forward repair. Checked,
at the tags, in a local NemoClaw checkout:

- **§10 token chain intact.** The gateway still compares against
  `gateway.auth.token` in `/sandbox/.openclaw/openclaw.json`. #11829 only
  made the host-side token fetch async internally.
- **`recover` unchanged.** `src/commands/sandbox/recover.ts` is
  byte-identical v0.0.123..v0.0.127, and the docs still describe it as
  repairing a stopped in-sandbox gateway plus the dashboard forward in one
  idempotent step. CLAUDE.md §3 and `app/lib/restartRuntime.ts` stay valid.
- **MCP broker unaffected.** #11866 retires NemoClaw's own *host-side* MCP
  registry; the native `mcp_servers` content is now authoritative "including
  direct edits". Our broker never used `nemoclaw mcp` — it writes the sandbox
  config directly, which is exactly the path upstream just blessed.
- **Not applicable:** Hermes Portable's Podman 5.7.0 requirement (#11907) —
  our Hermes runs in-sandbox. #11865's untrusted `OPENSHELL_GATEWAY_ENDPOINT`
  rejection — we never set that variable.

### The one thing to watch: `ensureOpenClawGatewayToken`

`app/api/sandbox/create/route.ts` seeds the gateway token and then does a
**manual in-sandbox gateway relaunch** (`nohup openclaw gateway run --force`
over `openshell sandbox exec`). NemoClaw's
`docs/manage-sandboxes/gateway-lifecycle-control.mdx` says plainly:
*"Ordinary `openshell sandbox exec` and manual in-sandbox relaunch are not
fallback paths."*

**That rule is not new** — it already shipped at v0.0.120 and v0.0.123, and
its OpenClaw half is unchanged at v0.0.127 (the only diff is the Hermes MCP
paragraph). Our function has worked in production against both. So v0.0.127
does **not** newly break it, and this is not a reason to block the bump.

It is, however, the single most likely thing to break, because #11792
consolidates the supervisor that owns the gateway child. The function's own
code comment still asserts our sandboxes have "no supervisor" — **that claim
is already stale** (`nemoclaw-start` is in `Dockerfile.base` at both tags).
Treat a live create as the gate. If the dashboard shows "Auth did not
match", the supported replacement is `nemoclaw <sandbox> gateway restart`,
which routes through the topology-specific controller and exists at
v0.0.120/123/127 alike.

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

   **How to actually run this check** (done for 0.18.0→0.19.0 on 2026-08-14):
   shallow-fetch both calver tags from `NousResearch/hermes-agent`, extract each
   function body from `hermes_cli/web_server.py` at both tags, and diff the
   bodies — do NOT diff the whole file, which grew +6007 lines between those two
   releases and buries the signal completely.

   ```bash
   git init -q hermes-src && cd hermes-src
   git remote add origin https://github.com/NousResearch/hermes-agent.git
   for t in v2026.7.1 v2026.7.20; do
     git fetch -q --depth 1 origin "$t" && git tag -f "$t" FETCH_HEAD^{commit}
   done
   # then extract each `def <fn>` block at both tags and diff the two extracts
   ```

   **Result for 0.18.0→0.19.0: all four guards BYTE-IDENTICAL**, so
   `HERMES_REMOTE_DESKTOP.md` needed no recalibration on the v0.0.108 bump.
   Record the outcome here on every Hermes move so the next agent knows whether
   the check was actually performed or merely intended.

   **Result for 0.19.0→0.20.6 (NemoClaw v0.0.116→v0.0.120, 2026-09-05):**
   `_ws_host_origin_is_allowed` and `_ws_client_is_allowed` BYTE-IDENTICAL.
   `_is_accepted_host` gained a new `trusted_public_hosts` parameter (default
   empty, sourced from `dashboard.public_url` / `HERMES_DASHBOARD_PUBLIC_URL`,
   neither of which this repo ever sets — confirmed by grep) and the
   non-loopback-bind auth gate gained a companion trigger: a *loopback* bind
   now also hard-refuses to start if `dashboard.public_url` is set, not just a
   non-loopback bind as before. Both changes are no-ops for us today because we
   never populate that config key, but if a future change ever wires Hermes'
   own public-URL feature in (instead of our Host/Origin rewrite hack), this is
   the gate that would engage. `HERMES_REMOTE_DESKTOP.md` §1a needed no
   recalibration on this bump.

   **Result for v0.0.120→v0.0.123 (2026-09-13): HERMES_VERSION DID NOT MOVE**
   (stays `v2026.8.27` / 0.20.6 in both `agents/hermes/Dockerfile.base` trees) —
   no upstream `hermes-agent` diff exists, so this check is a no-op this bump.
   Recorded per the "record the outcome on every Hermes move" instruction even
   when the outcome is "nothing to check."
