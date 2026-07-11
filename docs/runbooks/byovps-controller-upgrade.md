# Runbook — upgrading the controller + pinned versions on a live BYOVPS

> Admin-facing checklist for upgrading `openshell-controller` (the
> dashboard code) **and** the pinned NemoClaw/OpenClaw versions on a
> BYOVPS that already has running sandboxes — without touching those
> sandboxes. Written 2026-07-11 for the Oracle BYOVPS operation.
>
> Deep-dive companions (read the relevant one if a step fails):
> - `docs/runbooks/live-vps-upgrades.md` — the three traps that destroy
>   sandboxes + every installer gate, with fixes. **This runbook assumes
>   you follow its Policy section.**
> - `docs/runbooks/nemoclaw-version-bumps.md` — what to check in the
>   NemoClaw source *before* changing a pin in
>   `install_versioned_nemoclaw_openshell.sh`.
> - `docs/runbooks/byovps-architecture.md` — BYOVPS-specific quirks
>   (gateway on 8080, needrestart, Traefik-in-Gerbil, slow first build).

## What this operation does and does not do

| Component | Before (manidae BYOVPS bootstrap) | After | Effect on existing sandboxes |
|---|---|---|---|
| Controller code | `gatewaydashboard` at clone time | latest `gatewaydashboard` | None — controller restart does not touch the gateway |
| NemoClaw CLI + source | `v0.0.73` | `v0.0.78` (repo pin) | None — running containers keep their old base image |
| OpenClaw pin (build-arg) | per old source | `2026.6.10` | None — only used when building new sandbox images |
| OpenShell | `v0.0.72` | **unchanged** — skipped | Skipping is what keeps them alive (Trap 1) |
| Sandbox base image | old | new `nemoclaw-sandbox-base-local:<sha>` built lazily at first create | Existing sandboxes stay on the old image — by policy, never "align" them |

**Existing sandboxes do not upgrade. New sandboxes created after this
operation use the new versions.** That is the intended outcome.

## Pre-flight (10 min, nothing changes yet)

All on the VPS. SSH in and become root — everything below runs as root
with `HOME=/root`:

```bash
ssh -i ~/.ssh/tf_oracle ubuntu@<VPS_IP>
sudo -i
export PATH="/root/.nvm/current/bin:/root/.local/bin:/usr/local/bin:$PATH"
export HOME=/root
```

1. **Record the rollback state:**

   ```bash
   cd /opt/openshell-controller
   echo "controller rollback SHA: $(git rev-parse HEAD)"
   openshell --version        # expect 0.0.72
   nemoclaw --version         # see warning below
   docker images | grep nemoclaw   # base-image tags reveal the real source rev
   ```

   **Warning (hit 2026-07-11):** `nemoclaw --version` reports upstream's
   `package.json` version (e.g. `v0.1.0`), which upstream does NOT bump
   per release tag — it does not tell you which tag/SHA is installed.
   The reliable indicator is the base-image tag
   (`nemoclaw-*-sandbox-base-local:<sha>` — that `<sha>` is the source
   commit sandboxes were built from). Also don't trust
   manidae-cloud's `NEMOCLAW_INSTALL_TAG` constant in
   `byovps_bootstrap.py` as ground truth for an existing box: the
   backend that deployed it may have carried a different pin (our
   Oracle BYOVPS said constant `v0.0.73` but actually ran SHA
   `1162e89b`).

2. **Confirm OpenShell already equals the repo pin** (`v0.0.72` as of
   this writing — check `OPENSHELL_VERSION` at the top of
   `install_versioned_nemoclaw_openshell.sh`). If it matches, the
   `--skip-openshell` flag in Step 2 below is **mandatory**. If it does
   NOT match, stop — an OpenShell bump is a maintenance window that
   takes every sandbox down; follow "OpenShell version bump" in
   `live-vps-upgrades.md` instead of this runbook.

3. **Confirm every sandbox is Ready** (the installer's strict
   pre-upgrade backup hard-fails on anything not running — Gate A):

   ```bash
   OPENSHELL_GATEWAY=nemoclaw openshell sandbox list
   docker ps --format '{{.Names}}\t{{.Status}}' | grep openshell
   ```

   If a sandbox is not Ready, fix that first (`CLAUDE.md` §3 gateway
   recovery). Do not proceed with anything Exited — Exited containers
   are racing the sandbox-token TTL (Trap 2).

4. **Check registry rows for missing route metadata** (Trap 3 — since
   v0.0.78 one metadata-less row blocks *all* creates/recovery):

   ```bash
   python3 - <<'PYEOF'
   import json
   d = json.load(open("/root/.nemoclaw/sandboxes.json"))
   for name, row in d.get("sandboxes", {}).items():
       missing = [k for k in ("provider","model","endpointUrl",
                  "credentialEnv","preferredInferenceApi") if not row.get(k)]
       print(name, "OK" if not missing else f"MISSING: {missing}")
   PYEOF
   ```

   Any `MISSING` row: back up `sandboxes.json` and patch the row with
   the gateway's real route **before** running the installer — exact
   procedure under "Trap 3" in `live-vps-upgrades.md`, but note its
   example values are the hosted-NVIDIA route. On a
   compatible-endpoint box, copy the five fields from a complete
   sibling row instead (the gateway has one shared route, so the
   sibling's values are the truth). Also note each row's `provider`
   value; you need it in Step 2.

5. **Take backups** (belt and braces — the installer also backs up):

   ```bash
   HOME=/root nemoclaw backup-all     # want: 0 failed, 0 skipped
   mkdir -p /root/sandbox-preserve
   for c in $(docker ps --format '{{.Names}}' | grep openshell); do
     docker cp "$c":/sandbox "/root/sandbox-preserve/${c}-sandbox-$(date +%F)"
   done
   ```

   `backup-all` failures — both hit for real on 2026-07-11; the error
   message is the same misleading "in-sandbox SSH endpoint did not
   answer" for two totally different causes. Diagnose with
   `NEMOCLAW_REBUILD_VERBOSE=1 nemoclaw backup-all`:

   - **Leaked dashboard tunnels exhaust the sandbox SSH limit**
     (verbose shows `sandbox SSH connection limit reached`). The
     controller's lazy OpenClaw dashboard listener can leak dozens of
     duplicate host-side ssh processes
     (`ssh ... -N -L 127.0.0.1:<port>:127.0.0.1:18789` to the same
     sandbox); each holds an in-sandbox connection slot. Count with
     `pgrep -fc ':18789'`-style patterns, then kill the duplicates.
     **pkill footgun:** run the pkill from a script file
     (`ssh host 'sudo bash -s' < script.sh`), NOT inline in
     `bash -c "...pattern..."` — `pkill -f` matches your own command
     line containing the pattern and kills your session. Do not touch
     the `nemoclaw-start` ssh sessions (they hold the agents up) or
     the hermes-remote forwards.
   - **Sandbox state bigger than 256 MiB always fails** (verbose shows
     `SSH+tar download: exit=255, stdout=268... bytes`). NemoClaw's
     backup buffers the whole tar in memory with a hard-coded
     `maxBuffer: 256 MiB` (`src/lib/state/sandbox.ts`) — a sandbox
     with more state than that can never pass, and it's mislabeled as
     unreachable. Upstream bug. Since commit `ca4806c` our wrapper
     installer sed-raises the cap to 2 GiB in the extracted source
     before the CLI builds, so the installer's own gate passes. Note
     `NEMOCLAW_SKIP_UNREACHABLE_SANDBOX_BACKUP=1` does NOT bypass the
     installer gate — install.sh hard-codes
     `NEMOCLAW_REQUIRE_ALL_SANDBOX_BACKUPS=1` and under it a
     *skipped* sandbox fails the gate exactly like a failed one
     (verified against v0.0.78 `scripts/install.sh:1788` +
     `src/lib/actions/maintenance.ts`). The skip flag only helps
     interactive `backup-all` / recreate flows.

   One more scripting gotcha: `openshell forward start --background`
   leaves its child ssh holding stdout — never pipe its output
   (`| tail` hangs forever); redirect to a file or `/dev/null`.

## Step 1 — upgrade the controller code (safe for sandboxes)

The controller is a shallow clone of
`github.com/ivobrett/openshell_controller` branch `gatewaydashboard`
(made by the manidae BYOVPS bootstrap). Restarting the controller does
**not** restart the OpenShell gateway — sandboxes are unaffected.

```bash
cd /opt/openshell-controller
git status --short          # expect ONLY package-lock.json drift (see below)
git checkout -- package-lock.json   # discard npm-regenerated lockfile drift
git fetch origin gatewaydashboard
git merge --ff-only origin/gatewaydashboard   # fast-forward only; if this
                                              # fails the box has local
                                              # commits — stop and investigate
git rev-parse HEAD                            # MUST equal the new tip — verify!
npm ci                                        # exact install from the lockfile
npm run build

# The build must produce the custom-server entry point:
test -f /opt/openshell-controller/server.mjs && echo BUILD-OK

systemctl restart openshell-controller
sleep 6
curl -sS -o /dev/null -w "/login -> %{http_code}\n" http://127.0.0.1:3000/login
```

Expect `/login -> 200`. Then confirm the inventory still shows both
sandboxes Ready in the dashboard UI (or
`OPENSHELL_GATEWAY=nemoclaw openshell sandbox list`).

Two failure modes seen live (2026-07-11):
- The merge aborted on `package-lock.json` drift (an earlier
  `npm install` on the box regenerated it). That's why the checkout
  line above comes first. Anything *else* in `git status` means real
  local changes — stop.
- Piping the merge output (`git merge ... | tail`) makes `set -e`
  see the pipe's exit code, silently masking an aborted merge — the
  box then rebuilds the OLD code and everything "looks green". Always
  verify `git rev-parse HEAD` equals the intended tip before building.

If the service fails to start, check
`journalctl -u openshell-controller -n 100`. Note: if the unit is in
`failed` state from a previous needrestart storm, recover with
`systemctl reset-failed openshell-controller && systemctl start
openshell-controller` (see `byovps-architecture.md`).

## Step 2 — upgrade the NemoClaw / OpenClaw pins

The `git merge` in Step 1 already brought the new
`install_versioned_nemoclaw_openshell.sh` with the current pins
(NemoClaw `v0.0.78`, OpenClaw `2026.6.10`). Now run it — with the
sandbox-preserving flags:

```bash
cd /opt/openshell-controller

# Provider mapping, from the registry rows' `provider` field
# (pre-flight step 4):
#   "nvidia-prod" (hosted NVIDIA)          → NEMOCLAW_PROVIDER=build
#   "compatible-endpoint" (e.g. entrim.ai) → NEMOCLAW_PROVIDER=custom
# Do NOT omit this — the script's default (vllm) is wrong (Gate C).
NEMOCLAW_PROVIDER=custom \
  ./install_versioned_nemoclaw_openshell.sh --skip-openshell
```

The installer runs 10+ minutes (base-image docker build) — run it
detached (`nohup ... > /tmp/versioned-install.log 2>&1 &`) and tail
the log, or your SSH session timeout will orphan it mid-flight.

**Gate B will fire** for any OpenClaw sandbox created by a controller
older than the 2026-07-09 metadata fix ("N existing sandbox(es)
predate managed-image provenance tracking"). Verify the sandbox used
the managed flow before confirming: its
`nemoclaw-sandbox-local:<name>-<millis>` image tag timestamp must
match the registry creation time (the `<millis>` suffix is a Unix
epoch in ms — e.g. `1783345424773` ≈ 2026-07-06 13:43:44, one minute
before a 13:44:46 creation = managed create). Then re-run with:

```bash
NEMOCLAW_CONFIRM_LEGACY_MANAGED_RECREATE='["<name>"]' \
NEMOCLAW_PROVIDER=custom \
  ./install_versioned_nemoclaw_openshell.sh --skip-openshell
```

Reassurance while staring at these gates: on a box whose OpenShell is
already ≥ 0.0.37 (ours: 0.0.72), v0.0.78's install.sh does **not**
retire the gateway or recreate any sandbox — the destructive
"retire + recreate" path is only for pre-0.0.37 legacy gateways
(`preinstall_backup_and_retire_legacy_gateway` in
`scripts/install.sh`). The backup gate and legacy confirmation are
precautionary state for *future* recreates.

Deploying a non-default branch to the box (e.g. to test an installer
fix): the bootstrap's shallow clone only tracks `gatewaydashboard`,
so `git checkout <branch>` after a fetch fails with "pathspec did not
match". Use `git fetch origin <branch> && git checkout -B <branch>
FETCH_HEAD`.

`--skip-openshell` is **not optional**. Without it the installer
"reinstalls" OpenShell even at the same version, which restarts the
openshell-gateway user service; its ExecStartPre `pkill -KILL`s the
gateway binary, and the dying gateway takes every sandbox container
down with it. On BYOVPS the installer then also errors on its 17670
readiness probe (the gateway here binds 8080) — after the damage is
done. This is Trap 1 and it has happened for real.

If the installer stops at a gate (strict backup, legacy recreate
confirmation, provider mismatch, stale onboarding session), do **not**
improvise: look it up in the "Installer gates" table in
`live-vps-upgrades.md`, resolve exactly as written, and re-run.

## Step 3 — verify

```bash
# New CLI version, old sandboxes untouched:
HOME=/root nemoclaw --version                        # new pin, e.g. 0.0.78
openshell --version                                  # still 0.0.72
OPENSHELL_GATEWAY=nemoclaw openshell sandbox list    # both old sandboxes Ready
```

Then create a **fresh throwaway sandbox through the controller UI**.
Expectations:

- First create after the bump builds the new base image, so it is
  slow — on BYOVPS budget **up to 10 minutes**; the browser request may
  time out while the create completes in the background (normal, see
  `byovps-architecture.md`). Refresh the sandbox list after ~10 min.
- The new pinned base image appears:

  ```bash
  docker images | grep nemoclaw-sandbox-base-local   # tag = new nemoclaw commit sha
  ```

- Its registry row has full route metadata (re-run the pre-flight
  step 4 script — the new sandbox must print `OK`).

Delete the throwaway sandbox through the controller UI (deleting via
the UI also cleans its registry row). Done.

## Rollback

- **Controller code:**

  ```bash
  cd /opt/openshell-controller
  git checkout <controller rollback SHA from pre-flight>
  npm install && npm run build
  systemctl restart openshell-controller
  ```

- **NemoClaw pin:** re-run the installer with the old ref — this only
  changes what *future* sandboxes are built from; running sandboxes are
  untouched either way:

  ```bash
  NEMOCLAW_INSTALL_REF=v0.0.73 NEMOCLAW_PROVIDER=build \
    ./install_versioned_nemoclaw_openshell.sh --skip-openshell
  ```

## Execution record — 2026-07-11, Oracle BYOVPS (130.61.64.124)

This procedure was executed end-to-end with 2 live sandboxes
(`ivos-openclaw`, `ivos-hermes`). Outcome: **both sandboxes stayed
Ready with zero container restarts through the entire operation.**

- Controller: `84e5558` → `3b8b6db`+installer fixes (35+ commits incl.
  the full UI refresh). `/login → 200`, service active.
- NemoClaw: SHA `1162e89b` → tag `v0.0.78` (installed source commit
  `e962d05`, now at `/opt/nemoclaw-src` — the npm-link target; the old
  `/opt/nemoclaw` is a stale bootstrap leftover, ignore it). Verify
  the installed rev with `git -C /opt/nemoclaw-src describe --tags`.
- OpenShell: untouched at 0.0.72 (`--skip-openshell`).
- Every failure documented above (leaked tunnels, 256 MiB backup cap,
  Gate B, lockfile drift, dangling npm link) was hit during this run —
  none were theoretical.

Follow-ups spotted during the run (not blocking, worth fixing):

1. **Controller leaks dashboard-tunnel ssh processes.** ~17 duplicate
   `-L 127.0.0.1:20931 → 18789` forwards to `ivos-openclaw`
   accumulated over 5 days (one per `/dashboard/open` when the old
   listener isn't detected?), eventually exhausting the sandbox's SSH
   connection slots. Needs reap-or-reuse logic in
   `ensureOpenClawDashboardListener()` (`app/lib/openshellHost.ts`).
2. **In-sandbox OpenClaw gateway logs
   `failed to start server "openshell-control"
   (https://host.docker.internal:3000/...): fetch failed`** — the MCP
   broker URL is https against the controller's http port 3000.
3. The `agents` state dir (563 MB) makes every backup slow and once
   failed transiently mid-tar while the agent was writing — if the
   installer gate fails on `(agents)` alone, just re-run.
4. The backup `maxBuffer` shim deserves an upstream NemoClaw issue
   (stream to disk instead of buffering tar in memory).

## If something goes wrong mid-operation

- `openshell sandbox list` → `transport error / Connection refused`:
  the gateway died. Recover **immediately** (containers sitting Exited
  are racing their token TTL — Trap 2):

  ```bash
  PATH=/root/.nvm/current/bin:/root/.local/bin:$PATH HOME=/root \
    OPENSHELL_GATEWAY=nemoclaw nemoclaw <any-sandbox-name> recover
  ```

- A container restart fails with `invalid token: ExpiredSignature`:
  that sandbox is unrecoverable (Trap 2). Its `/sandbox` data is in
  `/root/sandbox-preserve/` from pre-flight step 5 (and `docker cp`
  still works on the stopped container). Delete + recreate through the
  controller, restore data, and patch nothing else until sandboxes are
  green again.
