# Runbook — upgrading OpenShell / NemoClaw on a live VPS without destroying sandboxes

> Indexed from CLAUDE.md §4 (Runbooks index). Written 2026-07-09 after the
> NemoClaw v0.0.78 upgrade on the BYOVPS orphaned both live sandboxes.
> Every trap below was hit for real that day; none of this is theoretical.
> Companion doc: `docs/runbooks/nemoclaw-version-bumps.md` (what to check
> in the NemoClaw source before bumping); this one is about executing the
> upgrade on a box that has running sandboxes.

## Policy

- **Existing sandboxes stay on the old base image.** A NemoClaw version
  bump only affects newly created sandboxes; running containers keep
  working as long as nothing restarts the gateway out from under them.
  Leaving old sandboxes on the previous NemoClaw/base version is
  explicitly acceptable — never force-recreate them just to "align
  versions".
- **An upgrade must never require deleting a running sandbox.** If a
  procedure would, stop and re-plan.

## TL;DR — safe NemoClaw-only bump (OpenShell version unchanged)

```bash
# 0. All of this over ssh on the VPS, as root.

# 1. Confirm OpenShell is already at the pinned version — if yes, you
#    MUST skip the OpenShell step (see Trap 1):
openshell --version          # e.g. "openshell 0.0.72" == pin → --skip-openshell

# 2. Confirm every registered sandbox is Ready (strict pre-upgrade
#    backup fails on anything not running — see Gate A):
OPENSHELL_GATEWAY=nemoclaw openshell sandbox list

# 3. Run the versioned installer with the box's real provider:
cd /opt/openshell-controller
NEMOCLAW_PROVIDER=build \   # 'build' = hosted NVIDIA (nvidia-prod); NOT the vllm default
  ./install_versioned_nemoclaw_openshell.sh --skip-openshell

# 4. Verify: create a fresh sandbox through the controller UI/API and
#    confirm existing sandboxes are still Ready.
```

If step 3 stops at a gate, find it under "Installer gates" below —
resolve and re-run. Do NOT improvise around a gate; each one exists to
prevent data loss.

## The three traps that destroy sandboxes

### Trap 1 — the OpenShell reinstall kills every sandbox

Running the versioned installer **without** `--skip-openshell` reinstalls
OpenShell even when the version is unchanged (apt no-ops, but the
installer still "restarts the openshell-gateway user service"). That
restart runs the unit's ExecStartPre:

```
pkill -KILL -f /usr/bin/openshell-gateway
```

which kills the NemoClaw docker-driver gateway too (same binary), and
the dying gateway takes **every sandbox container** down with it
(`Exited (1)`).

On BYOVPS it then gets worse: the OpenShell installer waits 30 s for a
listener on `https://127.0.0.1:17670`, but on an onboarded box the
gateway.env binds **8080** — nothing ever listens on 17670, so the
installer errors out and (because our wrapper is `set -e`) the whole
versioned install aborts *after* the damage is done.

**Rule: on any box where `openshell --version` already equals the pin,
always pass `--skip-openshell`.** Only run the OpenShell step when the
pin actually changed — and then only inside the "OpenShell version
bump" procedure below.

### Trap 2 — the static sandbox-token expiry (the killer)

Each sandbox container authenticates to the gateway with a bind-mounted
JWT:

```
/root/.local/state/openshell/docker-sandbox-tokens/default/<id>/sandbox.jwt
  → /etc/openshell/auth/sandbox.jwt (ro)
```

While the container runs, the token is refreshed **in memory** via
`RefreshSandboxToken`; the file keeps the mint-time token. If the
container stays down past the token TTL, restart fails permanently:

```
invalid token: ExpiredSignature
RefreshSandboxToken returned Unauthenticated; static token sources
cannot rebootstrap automatically
```

OpenShell 0.0.72 has **no supported way to re-mint** the token for an
existing sandbox — not `nemoclaw recover` (it only repairs the inner
gateway of a *running* sandbox), not any `openshell` CLI verb. A
sandbox in this state can only be deleted and recreated.

**Consequences:**
- Any gateway restart is a race: containers that restart quickly
  (fresh token) survive; containers that sit Exited past TTL are dead.
- If sandboxes are down and you're not sure why, **fix them before
  anything expires** — do not leave them Exited while debugging
  something else.
- Emergency data preservation for a container that can no longer start
  (docker cp works on stopped containers):
  ```bash
  docker cp <container>:/sandbox /root/sandbox-preserve/<name>-sandbox
  ```

### Trap 3 — v0.0.78's shared-route metadata rule bricks creates/recovery

Since v0.0.78, NemoClaw refuses any create/recover on a gateway when
**any** registered sandbox row in `/root/.nemoclaw/sandboxes.json`
lacks durable route metadata (`provider`/`model` null):

```
Error: OpenShell gateway 'nemoclaw' has one inference route shared by
every registered sandbox. Cannot set ... because it conflicts with
'<name>'. At least one registered sandbox lacks durable provider or
model metadata ...
```

Two ways rows end up metadata-less:
1. Sandboxes created before fingerprint/metadata tracking (pre-0.78).
2. **Our own controller's OpenClaw blueprint create**: the create route
   SIGTERMs `nemoclaw onboard` as soon as the sandbox is reachable
   (readiness re-poll design), which on 0.78 is *before* onboarding
   writes provider/model into the registry. Every Quick-Created OpenClaw
   sandbox therefore poisons the route for the next create until fixed
   (controller-side fix pending; see "Known issues").

**Fix (verified 2026-07-09):** back up and patch the registry row with
the route the sandbox actually uses (on our boxes: the hosted NVIDIA
route). All five fields the compatibility check reads:

```bash
cp /root/.nemoclaw/sandboxes.json /root/.nemoclaw/sandboxes.json.bak-$(date +%s)
python3 - <<'PYEOF'
import json
p = "/root/.nemoclaw/sandboxes.json"
d = json.load(open(p))
d["sandboxes"]["<NAME>"].update({
  "provider": "nvidia-prod",
  "model": "nvidia/nemotron-3-super-120b-a12b",
  "endpointUrl": "https://integrate.api.nvidia.com/v1",
  "credentialEnv": "NVIDIA_INFERENCE_API_KEY",
  "preferredInferenceApi": "openai-completions",
})
json.dump(d, open(p, "w"), indent=2)
PYEOF
```

This is truthful, not a hack: the gateway has exactly one shared
inference route, so a sandbox that runs on that gateway runs on that
route — the row just predates the tracking.

## Installer gates you may hit (v0.0.78 install.sh)

| Gate | Trigger | Resolution |
|---|---|---|
| **A. Strict pre-upgrade backup** — `Strict pre-upgrade backup requires every registered sandbox to be backed up; N skipped` | Any registered sandbox not in Ready phase (`backup-all` skips not-running; `NEMOCLAW_REQUIRE_ALL_SANDBOX_BACKUPS=1` is hard-coded by install.sh, no bypass) | Bring every sandbox to Ready first. If one is permanently dead (Trap 2), preserve its data, delete it, and remove its registry row before re-running. |
| **B. Legacy managed recreate** — `Legacy sandbox recovery requires explicit confirmation` | Registry rows that predate managed-image provenance tracking | Verify the sandbox was created via the controller's managed flow (its `nemoclaw-sandbox-local:*` image timestamps match creation), then re-run with the exact JSON from the error: `NEMOCLAW_CONFIRM_LEGACY_MANAGED_RECREATE='["name1",...]'` |
| **C. Provider mismatch** — `Requested provider 'vllm' is not available in this environment` | Empty registry → install.sh runs fresh onboarding with our installer's `NEMOCLAW_PROVIDER` default (vllm) | Pass the box's real provider: `NEMOCLAW_PROVIDER=build` (hosted NVIDIA / nvidia-prod) plus `NVIDIA_INFERENCE_API_KEY` (grab from the controller's `.env.local` `NVIDIA_API_KEY`). |
| **D. Stale onboarding session** — `Previous onboarding session failed. Re-run with --fresh...` | A previous onboarding attempt died mid-flight | `HOME=/root nemoclaw onboard --fresh --non-interactive ...` to discard, or `--resume` to continue it. The versioned installer does not pass either flag, so clear the session before re-running it. |

## OpenShell version bump (the destructive one) — only when the pin changes

There is no way to restart the OpenShell gateway without stopping every
sandbox container (Trap 1), so an OpenShell bump is inherently a
maintenance window:

1. Confirm the new NemoClaw pin's `blueprint.yaml`
   `min/max_openshell_version` actually requires the new OpenShell.
2. All sandboxes Ready → run `HOME=/root nemoclaw backup-all` and
   confirm `0 failed, 0 skipped` (backups land in
   `~/.nemoclaw/rebuild-backups/`).
3. Belt-and-braces: `docker cp <cnt>:/sandbox` per sandbox (see Trap 2).
4. Run the full versioned installer (no `--skip-openshell`). On BYOVPS
   expect the 17670 readiness probe to fail (Trap 1) — the OpenShell
   *package* upgrade itself will have completed; continue with
   `--skip-openshell` for the NemoClaw half.
5. **Immediately** restart the containers before tokens expire; anything
   that comes back Ready survived. Anything hitting `ExpiredSignature`
   is dead: delete it and recreate through the controller, then restore
   data from the backup.

## Verifying after any upgrade

```bash
# CLI is the new version and the gateway is untouched/healthy:
HOME=/root nemoclaw --version
OPENSHELL_GATEWAY=nemoclaw openshell sandbox list   # old sandboxes still Ready

# Create a fresh sandbox through the controller (UI or API) — on
# v0.0.78 this also builds the new base image on first use, tagged
# nemoclaw-sandbox-base-local:<nemoclaw-commit-sha> (e.g. e962d05b for
# v0.0.78). Its presence proves the new source actually built.
docker images | grep nemoclaw-sandbox-base-local
```

## Known issues / follow-ups (as of 2026-07-09)

- **Controller leaves OpenClaw registry rows metadata-less on 0.78**
  (Trap 3, cause 2). Until the create route is fixed to complete or
  resume onboarding metadata, apply the registry patch after each
  OpenClaw Quick Create if a subsequent create fails with the
  route-conflict error.
- **`install_versioned_nemoclaw_openshell.sh` base-image build may be
  redundant on 0.78+**: NemoClaw now builds and pins its own
  `nemoclaw-sandbox-base-local:<sha>` at first sandbox create. The
  installer's `ghcr.io/nvidia/nemoclaw/sandbox-base:latest` build is
  possibly vestigial — verify on the next fresh install and drop if so
  (audit §11 territory).
- `/opt/nemoclaw` is a leftover source checkout from the original
  bootstrap and does NOT track the installed CLI version (it still held
  1162e89b after the 0.78 CLI was live). Check the running CLI with
  `nemoclaw --version` / the base-image tag, not that directory.
