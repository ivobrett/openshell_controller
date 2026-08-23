# Runbook — fresh AgentGateway install: known issues and their status

> Indexed from CLAUDE.md §4. Read this after provisioning a fresh cloud
> AgentGateway box, or when a fresh box behaves oddly before its first
> sandbox exists.

Baseline validated end-to-end on a fresh Hetzner box (`49.13.144.137`) on
**2026-08-23** at NemoClaw **v0.0.113** / OpenShell **0.0.106** / OpenClaw
2026.7.1 / Hermes 0.19.0. Both an OpenClaw (`smoke`) and a Hermes
(`my-hermes`) sandbox reached **Ready**, inference served real completions,
and network-policy grants applied.

---

## 1. FIXED — "Unknown gateway 'nemoclaw'" on the dashboard before the first sandbox

**Symptom.** Immediately after provisioning, the dashboard shows a red error:

```
Command failed: /usr/bin/openshell sandbox list
Error: × Unknown gateway 'nemoclaw'.
```

**Cause.** manidae-cloud `b6964b22` (2026-08-15) deliberately stopped
pre-registering a `nemoclaw` gateway placeholder. It had to: on NemoClaw
v0.0.108+ a placeholder bound to 17670 (≠ `DEFAULT_GATEWAY_PORT` 8080) is a
BLOCKING `gateway.port.owner_mismatch` that aborts `nemoclaw onboard`. The
gateway is now created by the first `nemoclaw onboard`, i.e. the first sandbox
create — so between provisioning and that moment, no gateway exists.

**There is no provisioning-side fix.** Registering the gateway at :8080 does
not help, because nothing *listens* there until onboard starts the gateway
process — `sandbox list` would just fail with `Connection refused` instead.
And `onboard` is the only command that creates the gateway, and it is
inherently sandbox-creating (~10 min).

**Fix (controller, `d496b2a`).** `app/api/telemetry/real/route.ts` returns an
empty inventory with `awaitingFirstSandbox: true` for this case, so the UI
renders its normal empty state plus "The NemoClaw gateway is created
automatically with your first sandbox."

**Guarded:** only when the NemoClaw registry lists ZERO sandboxes. A gateway
that vanished on a host that already has sandboxes still 500s loudly. Test:
`tests/fresh-box-gateway-empty-state-check.mjs`.

**Note the repair button is useless here** — `GatewayRepairButton` runs
`openshell gateway start --name nemoclaw`, which only restarts a *registered*
gateway. It cannot create one. It is suppressed in the fresh-box state.

---

## 2. FIXED — granting a policy request fails with "endpoint ambiguity"

**Symptom.** Approving an outstanding permission request toasts:

```
Command failed: /usr/bin/openshell rule approve --chunk-id <id> <sandbox>
network endpoint ambiguity validation failed: network policies
'allow_github_com_443' endpoint[0] (github.com:443) and 'brew' endpoint[1]
(github.com:443) overlap on port(s) 443 with conflicting metadata:
advisor_proposed=true vs false
```

**Cause — a regression we shipped.** OpenShell ≥ 0.0.101 validates policy with
`find_endpoint_ambiguities()` (`crates/openshell-policy/src/ambiguity.rs`).
**That file does not exist in 0.0.85**, which these boxes ran before
2026-08-14; there was no ambiguity check and approval simply worked. It came in
with the NemoClaw v0.0.96 → v0.0.108 bump.

The check rejects endpoint pairs overlapping on host:port whose `tls`,
`allowed_ips` or `advisor_proposed` differ — and **never consults `binaries`**,
the field that actually distinguishes them. Approving stamps
`advisor_proposed=true`; curated presets carry `false`. `brew` alone covers
github.com, ghcr.io, raw/objects.githubusercontent.com and
pkg-containers.githubusercontent.com, so any advisor proposal for those from a
non-brew binary was unapprovable.

Not a controller bug — `app/api/sandbox/[sandboxId]/permissions/route.ts` has
one commit in its entire history.

**Fix (`d496b2a`, `3c88914`).** On an approve failing with this specific error,
`resolveSandboxNetworkRule()` replays the chunk's own endpoints/binaries via
`openshell policy update` (which defaults `advisor_proposed` to false, matching
the preset, so validation passes), then rejects the satisfied chunk. Response
carries `viaAmbiguityFallback: true`.

Verified live: `git → github.com:443` went from `CONNECT tunnel failed, 403` to
a successful `ls-remote`, while `formulae.brew.sh` stayed blocked (no
over-granting). Test: `tests/advisor-ambiguity-approve-fallback-check.mjs`.

### 2a. The one case it cannot auto-fix — `tls` / `allowed_ips`

`policy update --add-endpoint` cannot express `tls` (its options segment
accepts only `websocket-credential-*` / `<IP>`). When the overlapping preset
uses a non-default mode — `brew`'s `formulae.brew.sh` is `tls: skip` — the
re-authored rule defaults to `auto` and trips the same validator on `tls`.

We deliberately do **not** pick a TLS mode on the operator's behalf. The
controller raises an actionable error naming the conflict. Resolve by hand:
`openshell policy set` with the new endpoint matching the existing one, or add
the binary to the policy that already owns the endpoint if its wider access is
acceptable.

`github.com` and `raw.githubusercontent.com` declare no `tls`, which is why
those approve cleanly.

**Upstream fix still wanted:** the ambiguity check should account for
`binaries`, or the advisor should extend a matching endpoint rather than
propose a duplicate. Worth filing against NVIDIA/OpenShell.

---

## 3. OPEN — `host.docker.storage_incompatible` warning

`nemoclaw host probe --json` on a fresh box reports:

```
warning  host.docker.resources_insufficient
warning  host.docker.storage_incompatible
```

The box has **no `/etc/docker/daemon.json`** and runs `overlayfs` with
`io.containerd.snapshotter.v1`.

In NemoClaw's source (`src/lib/readiness/host.ts`) this finding is declared
**blocking**, yet the probe reports it as a *warning* and **nothing is actually
blocked** — both sandboxes reached Ready and worked. NemoClaw auto-remediates
this only when `hasRemediableStorageConflict()` sees exactly one blocking
finding; with two findings present it did not fire, which is why the
2026-08-15 note claiming "the storage conflict auto-remediates" did not hold
here.

**Deliberately not fixed.** Writing `/etc/docker/daemon.json` during
provisioning to force a storage driver is disruptive (a driver switch orphans
existing images) and would be speculative — no observed breakage justifies it.
The NemoClaw *package* template already writes
`{"default-cgroupns-mode": "host"}`; the AgentGateway template writes no
daemon.json at all.

Revisit if a fresh box ever fails on nested overlay mounts (`nemoclaw <name>
share mount`, or containers nested inside a sandbox).

---

## 4. OPEN — the standalone **NemoClaw** package is pinned at v0.0.73

`startup_nemoclaw.sh.j2` line 2 hardcodes:

```jinja
{%- set nemoclaw_install_tag = "v0.0.73" %}
```

That is 40 releases stale and **almost certainly already broken**: v0.0.73
reviews OpenClaw **2026.5.27**, while `sandbox-base:latest` carries
**2026.7.1** today. The template pins no digest, so it tracks the floating tag
straight into NemoClaw's anti-downgrade guard — "Base image has OpenClaw
2026.7.1, which is newer than reviewed target 2026.5.27". It also pins no
`OPENSHELL_VERSION` while its blueprint demands min==max==0.0.71.

**Does not affect AgentGateway.** It is guarded by
`{% if package == "NemoClaw" %}`, a different package from
`{% if is_agentgateway %}`. Every template is concatenated into one startup
script and the guards select the path.

Not fixed because bumping it is not a one-liner: it would need an
`OPENSHELL_VERSION` pin and a digest to match, on a path we have never
exercised. Decide whether that package is still offered before investing.

---

## What a fresh AgentGateway install pulls

- controller: `git clone --depth=1 --branch gatewaydashboard
  https://github.com/ivobrett/openshell_controller.git`
  (`OPENSHELL_CONTROLLER_REPO` / `_BRANCH`, `backend/app/core/config.py`) — so
  fixes 1 and 2 land automatically once pushed to `gatewaydashboard`.
- NemoClaw: `NEMOCLAW_INSTALL_REF="v0.0.113"` from the cloud template.
- OpenShell: `OPENSHELL_VERSION=v0.0.106`, matching the blueprint's
  min==max==0.0.106 so `onboard` cannot silently downgrade the gateway.
- sandbox base: frozen digest `sha256:31fcee7b…` (the v0.0.113 release tag).
