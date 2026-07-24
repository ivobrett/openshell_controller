# Runbook — live OpenShell bump + OpenClaw/Hermes agent upgrade with backup & restore

> The hard case: upgrading a BYOVPS (or cloud VPS) with **running
> OpenClaw + Hermes agents you must keep**, where the target NemoClaw
> pin **also forces an OpenShell version bump** — the destructive
> maintenance window — AND the agents' pinned versions actually move
> (e.g. OpenClaw 2026.6.10 → 2026.7.1 so the current Android app
> reconnects). Written 2026-07-24 for the Oracle BYOVPS
> (`130.61.64.124`) upgrade of OpenShell 0.0.72→0.0.85 /
> NemoClaw v0.0.81→v0.0.92.
>
> This wraps and specialises three existing docs — read them for the
> "why" behind each trap:
> - `live-vps-upgrades.md` — the three sandbox-killing traps + every
>   installer gate. **Its "OpenShell version bump (the destructive
>   one)" section is the spine of this procedure.**
> - `byovps-controller-upgrade.md` — the controller ff-upgrade half.
> - `nemoclaw-version-bumps.md` — what to check in NemoClaw source
>   before moving a pin.

## When this runbook applies (vs the easier `--skip-openshell` path)

Use `byovps-controller-upgrade.md` (the non-destructive path) when the
repo's `OPENSHELL_VERSION` pin **equals** the box's `openshell
--version`. Use THIS runbook when **all** of the following hold:

1. `OPENSHELL_VERSION` in `install_versioned_nemoclaw_openshell.sh` is
   **higher** than the box's `openshell --version` → an OpenShell
   reinstall is unavoidable, and it takes every sandbox container down
   (Trap 1 in `live-vps-upgrades.md`). There is **no** way to restart
   the OpenShell gateway without stopping all sandboxes.
2. You must **keep** the running agents' data.
3. At least one agent's pinned version moves, so you actually *want*
   `upgrade-sandboxes --auto` to rebuild it (OpenClaw here) — while
   any already-at-target agent (Hermes here) must merely survive the
   window.

## The two things that make this dangerous

- **Trap 2 — sandbox-token TTL.** When the OpenShell gateway is killed,
  every sandbox container goes `Exited`. A container that stays down
  past its bind-mounted `sandbox.jwt` TTL can **never restart**
  (`invalid token: ExpiredSignature`) on OpenShell ≤ 0.0.72 — it can
  only be deleted + recreated. An agent being **rebuilt** dodges this
  (it gets a fresh container + token). An agent that is only
  **restarted** (already at target version, e.g. Hermes) is racing the
  TTL. Minimise the Exited window; keep the raw `docker cp` backup as
  the recreate-from-scratch safety net.
- **Backup buffer cap vs multi-GB agent state.** NemoClaw's backup
  (`src/lib/state/sandbox.ts`) buffers the whole SSH+tar stream in RAM
  via `spawnSync` `maxBuffer`. Stock cap is 256 MiB (this is the "128
  MB"/"limited" error you hit trying a manual `nemoclaw backup`). Our
  installer sed-raises it — **as of 2026-07-24 to 8 GiB** — because
  OpenClaw agent state grows unbounded (`/sandbox/.openclaw` was
  1.8 GiB on the Oracle box). The strict pre-upgrade backup gate
  (Gate A, hard-coded `NEMOCLAW_REQUIRE_ALL_SANDBOX_BACKUPS=1`) fails
  the **entire** installer if any one sandbox's state exceeds the cap,
  so the cap MUST exceed your largest agent-state dir. Check first
  (Pre-flight step 4); bump the sed value if needed.

## Pre-flight (nothing changes yet)

SSH in and become root; everything runs as root with `HOME=/root`:

```bash
ssh -i ~/.ssh/tf_oracle ubuntu@<VPS_IP>
sudo -i
export HOME=/root
export PATH="$(ls -d /root/.nvm/versions/node/*/bin | head -1):/root/.local/bin:/usr/local/bin:$PATH"
```

1. **Record rollback state:**
   ```bash
   echo "controller: $(git -C /opt/openshell-controller rev-parse HEAD)"
   echo "nemoclaw-src: $(git -C /opt/nemoclaw-src log -1 --format=%h)"
   openshell --version
   ```

2. **Confirm the OpenShell pin really moves** (this runbook, not the
   easy one): compare `OPENSHELL_VERSION` in the repo's
   `install_versioned_nemoclaw_openshell.sh` against `openshell
   --version`. If equal → wrong runbook, use `byovps-controller-upgrade.md`.

3. **Confirm which agents move.** Diff the target NemoClaw tag's
   `agents/*/manifest.yaml` `expected_version` against what's running
   (`docker exec <cnt> openclaw --version` / `hermes --version`, and
   the registry rows). Only agents whose `expected_version` moved get
   rebuilt by `upgrade-sandboxes --auto`; the rest just restart.

4. **Measure agent-state size vs the backup cap** — the make-or-break
   check:
   ```bash
   for c in $(docker ps --format '{{.Names}}' | grep '^openshell-'); do
     echo "== $c =="
     docker exec "$c" sh -c 'du -sh /sandbox/.openclaw /sandbox/.hermes 2>/dev/null'
   done
   ```
   The largest of these must be **below** the installer's `maxBuffer`
   sed value (grep `maxBuffer:` in
   `install_versioned_nemoclaw_openshell.sh`). If not, raise the sed
   value on your upgrade branch before deploying (see "The code change"
   below).

5. **Registry route metadata OK** (Trap 3 — one metadata-less row
   blocks all creates/recovery):
   ```bash
   python3 - <<'PYEOF'
   import json
   d = json.load(open("/root/.nemoclaw/sandboxes.json"))
   for n, r in d.get("sandboxes", {}).items():
       miss=[k for k in ("provider","model","endpointUrl","credentialEnv","preferredInferenceApi") if not r.get(k)]
       print(n, "OK" if not miss else f"MISSING {miss}", "| provider=", r.get("provider"))
   PYEOF
   ```
   Note each row's `provider` — you need it for the installer
   (`nvidia-prod`→`build`, `compatible-endpoint`→`custom`). Patch any
   MISSING row per Trap 3 in `live-vps-upgrades.md` before proceeding.

6. **Reap leaked dashboard tunnels** (they hold in-sandbox SSH slots
   and cause the misleading "SSH endpoint did not answer" backup
   failure). Kill by PID — `pkill -f` would match its own arg string:
   ```bash
   pgrep -af 'sandbox@openshell-.* -N -L 127.0.0.1'   # verify they are
       # the lazy per-sandbox forwards, NOT nemoclaw-start / :18789 primary
   pgrep -f 'sandbox@openshell-.* -N -L 127.0.0.1' | xargs -r kill
   ```

7. **Bulletproof raw backup (the real safety net).** `docker cp` has no
   size cap and works on stopped containers, so this is what you
   restore from if an agent tokens-out and must be recreated:
   ```bash
   STAMP=$(date +%F-%H%M); mkdir -p /root/sandbox-preserve
   for c in $(docker ps --format '{{.Names}}' | grep '^openshell-'); do
     n=$(echo "$c" | sed -E 's/^openshell-([a-z0-9-]+)-[0-9a-f-]{36}$/\1/')
     docker cp "$c":/sandbox "/root/sandbox-preserve/${n}-sandbox-$STAMP"
   done
   du -sh /root/sandbox-preserve/*; df -h /
   ```

## The code change (on your laptop, before deploying)

The box pulls the installer via `git`. On an upgrade branch off
`gatewaydashboard`:

- If Pre-flight step 4 showed any agent-state dir near/over the current
  `maxBuffer` sed value, raise it in
  `install_versioned_nemoclaw_openshell.sh` (the
  `s/maxBuffer: 256 \* 1024 \* 1024/maxBuffer: <N> * 1024 * 1024/g`
  line). 2026-07-24 raised 2 GiB → 8 GiB.
- `npm run build && npm test` (baseline: all PASS except the one known
  `control-auth-cookie-check.mjs` tech-debt failure).
- `git push -u origin <branch>`.

## Step 1 — controller ff-upgrade (non-destructive)

Restarting the controller does NOT touch the gateway; sandboxes are
unaffected.

```bash
cd /opt/openshell-controller
git status --short                 # expect only package-lock.json drift
git checkout -- package-lock.json 2>/dev/null || true
git fetch origin <branch>
git checkout -B <branch> FETCH_HEAD   # shallow clones track only
                                      # gatewaydashboard; -B from FETCH_HEAD
git rev-parse HEAD                     # MUST equal the branch tip — verify
npm ci
npm run build
test -f server.mjs && echo BUILD-OK
systemctl restart openshell-controller
sleep 6
curl -sS -o /dev/null -w "/login -> %{http_code}\n" http://127.0.0.1:3000/login
```

Expect `/login -> 200`; confirm both sandboxes still Ready
(`OPENSHELL_GATEWAY=nemoclaw openshell sandbox list`).

## Step 2 — sanctioned pre-upgrade backup (with the raised cap)

The installer will take its own strict backup, but run it manually
first to catch a cap/size problem BEFORE the destructive step:

```bash
HOME=/root nemoclaw backup-all      # want: N backed up, 0 failed, 0 skipped
```

If a sandbox fails here with "SSH endpoint did not answer", diagnose
with `NEMOCLAW_REBUILD_VERBOSE=1 nemoclaw backup-all` — `exit=255` at
~`<cap>` bytes means the cap is still too small (raise the sed value);
`sandbox SSH connection limit reached` means more leaked tunnels
(Pre-flight step 6).

## Step 3 — the destructive window (the sequence that ACTUALLY works on BYOVPS)

> **Do NOT run the full wrapper (no `--skip-openshell`) and expect it to
> do the OpenShell bump.** On a BYOVPS with a source checkout at
> `/opt/nemoclaw-src`, that path is broken two ways: (1) the wrapper's
> naive `install_openshell` (the NVIDIA project `install.sh`) kills the
> gateway *before* the backup and dies at the 17670 probe; (2) even the
> NemoClaw-native retire path (v0.0.92 `install.sh`
> `preinstall_backup_and_retire_legacy_gateway`) can't self-complete —
> its `stop_legacy_openshell_gateway_process` refuses on the BYOVPS
> PID-file trust check, and the source-checkout `install_nemoclaw` uses
> `maybe_install_openshell_during_install if-missing` (won't upgrade an
> already-present OpenShell). So we decompose the bump into explicit,
> observable steps. All verified on the 2026-07-24 Oracle run.

The ordering that matters: **install the new CLI + take the validated
backup while containers are Ready → lay down the new OpenShell binaries
(non-destructive) → only then kill the gateway → recreate+restore.** The
pre-upgrade backup gate needs Ready containers, so it MUST run before the
gateway dies; and you can't re-run `install.sh` afterward (its backup
gate fails on the dead containers).

```bash
cd /opt/openshell-controller
NODE=$(ls -d /root/.nvm/versions/node/*/bin | head -1); export PATH="$NODE:/root/.local/bin:/usr/local/bin:$PATH"

# 3a. Validated backup while Ready (the restore source):
NEMOCLAW_REQUIRE_ALL_SANDBOX_BACKUPS=1 HOME=/root nemoclaw backup-all   # 0 failed, 0 skipped

# 3b. Install the new NemoClaw CLI while Ready, via the wrapper
#     --skip-openshell. It re-takes the backup with the new 8 GiB CLI,
#     builds+links v0.0.92, then EXPECTEDLY dies at "Could not retire the
#     legacy OpenShell gateway after backup" — HARMLESS (gateway +
#     containers untouched). Confirms Gate B for the legacy row.
nohup env HOME=/root NEMOCLAW_NON_INTERACTIVE=1 \
  NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE=1 NEMOCLAW_PROVIDER=<build|custom> \
  NEMOCLAW_CONFIRM_LEGACY_MANAGED_RECREATE='["<legacy-sandbox>"]' \
  ./install_versioned_nemoclaw_openshell.sh --skip-openshell \
  > /tmp/vinstall-cli.log 2>&1 &
# wait for "Could not retire the legacy OpenShell gateway" — that is DONE.
# Verify: containers still Ready; new CLI at git -C /opt/nemoclaw-src log -1.

# 3c. Install the new OpenShell binaries — NON-destructive. The running
#     old gateway keeps its inode; containers stay Ready. (Use NemoClaw's
#     install-openshell.sh, NOT the wrapper's install_openshell — it just
#     downloads+verifies the coherent openshell/-gateway/-sandbox set at
#     the blueprint-pinned version; no 17670 probe, no gateway restart.)
bash /opt/nemoclaw-src/scripts/install-openshell.sh   # -> openshell 0.0.85
openshell --version; openshell-sandbox --version       # both new pin

# 3d. Kill the old gateway + recreate/restore in one shot. This respawns a
#     fresh new-version gateway and recreates EVERY non-Ready sandbox from
#     its validated backup (fresh container + token + state), rebuilding
#     version-moved agents. Detached — the base-image build is 10+ min.
cat > /root/restore-upgrade.sh <<'S'
#!/usr/bin/env bash
export HOME=/root
NODE=$(ls -d /root/.nvm/versions/node/*/bin | head -1); export PATH="$NODE:/root/.local/bin:/usr/local/bin:$PATH"
pkill -f /usr/bin/openshell-gateway; sleep 3
NEMOCLAW_RESTORE_LATEST_BACKUP_ON_RECREATE=1 \
NEMOCLAW_CONFIRMED_LEGACY_MANAGED_SANDBOXES='["<legacy-sandbox>"]' \
NEMOCLAW_CONFIRM_LEGACY_MANAGED_RECREATE='["<legacy-sandbox>"]' \
  nemoclaw upgrade-sandboxes --auto --yes 2>&1
echo "EXIT: $?"
S
chmod +x /root/restore-upgrade.sh
nohup /root/restore-upgrade.sh > /tmp/restore-upgrade.log 2>&1 &
tail -f /tmp/restore-upgrade.log
```

**Because both agents' file-tokens were already expired (Trap 2), the
old containers can never restart — but that is fine here: step 3d
*recreates* them (new tokens) and restores state. There is no TTL race
to win; take your time.**

### Gates in step 3d (each hit for real on 2026-07-24)

- **Legacy OpenClaw row lacks `dashboardPort` → "the recorded recreate
  target is invalid" / "Recorded recreate target is invalid."** OpenClaw
  is a dashboard-managed agent; `buildRebuildRecreateOnboardOpts` throws
  when the pre-fingerprint row has no `dashboardPort`. Hermes rows (post
  the 2026-07 fingerprint era) already carry it. Fix — patch the row:
  ```bash
  cp ~/.nemoclaw/sandboxes.json{,.bak-$(date +%s)}
  python3 - <<'PY'
  import json; p="/root/.nemoclaw/sandboxes.json"; d=json.load(open(p))
  d["sandboxes"]["<legacy-sandbox>"]["dashboardPort"]=18789
  json.dump(d,open(p,"w"),indent=2)
  PY
  ```
  then re-run `restore-upgrade.sh`. (18789 = NemoClaw's `DASHBOARD_PORT`
  default, same value every sandbox uses.)
- **Gate E — "Dashboard port 18789 belongs to sandbox '<sibling>'."**
  The singleton host dashboard forward is held by the sandbox rebuilt
  first. Fails safe (untouched). Free it, then re-run:
  ```bash
  OPENSHELL_GATEWAY=nemoclaw openshell forward stop 18789 <sibling>
  ```
- **`upgrade-sandboxes` exits 1 with "Post-upgrade structure check
  skipped (doctor returned 255)" even though "rebuilt successfully."**
  The rebuild itself succeeded; the non-zero is a transient post-rebuild
  doctor probe (forward not yet re-spun). Confirm with `nemoclaw <name>
  doctor` (→ "Summary: healthy") — do not re-run blindly.

## Step 4 — post-restore fixups

The recreate restores `/sandbox/.<agent>` state (workspace, policy
presets, device pairing, gateway auth token). A couple of things it does
NOT carry:

```bash
# Re-establish host forwards (recreate can leave 18790/18789 dead):
OPENSHELL_GATEWAY=nemoclaw nemoclaw <name> recover

# OpenClaw external clients (Android app, browser Control UI): the
# recreate resets gateway.controlUi.allowedOrigins to localhost-only.
# On a Pangolin-auth + IP-gated box the gateway still requires the token,
# so re-apply the wildcard and restart the in-sandbox gateway (origins
# are NOT hot-reloadable — see project_openclaw_gateway_origin_allowlist):
OC=$(docker ps --format '{{.Names}}' | grep openshell-<name> | head -1)
docker exec -u sandbox "$OC" python3 - <<'PY'
import json; p="/sandbox/.openclaw/openclaw.json"; d=json.load(open(p))
d.setdefault("gateway",{}).setdefault("controlUi",{})["allowedOrigins"]=["*"]
json.dump(d,open(p,"w"),indent=2)
PY
OPENSHELL_GATEWAY=nemoclaw nemoclaw <name> recover   # restarts gateway
```

Files OUTSIDE the recorded managed state path (e.g. `/sandbox/user-data`)
are NOT preserved by the recreate — that is what the Phase-0 `docker cp`
of the whole `/sandbox` is for; copy anything extra back by hand.

## Step 5 — verify

```bash
HOME=/root nemoclaw --version || git -C /opt/nemoclaw-src log -1 --format=%h
openshell --version                                  # new pin
OPENSHELL_GATEWAY=nemoclaw openshell sandbox list     # all Ready
docker exec <openclaw-cnt> openclaw --version         # new agent version
docker images | grep nemoclaw-sandbox-base-local      # tag = new commit sha
```

Then the human checks: **Android app reconnects to OpenClaw**; Hermes
inference returns 200 (not the DNS-503 —
`project_hermes_inference_503`). Re-check registry metadata is `OK` for
the rebuilt sandbox.

## Step 6 — land it

Fast-forward `gatewaydashboard` to the upgrade branch and push; delete
the branch. Update this runbook's execution record.

## Rollback

- **Controller:** `git checkout <rollback SHA>; npm ci; npm run build;
  systemctl restart openshell-controller`.
- **NemoClaw pin (future sandboxes only):** re-run the installer with
  `NEMOCLAW_INSTALL_REF=<old-tag> --skip-openshell`.
- **OpenShell cannot be cleanly rolled back** without another
  maintenance window — this is why the pin bump is one-way in practice.
  Running sandboxes rebuilt onto the new base stay there.

## Execution record — 2026-07-24, Oracle BYOVPS (130.61.64.124)

First end-to-end run of this procedure. **Both agents kept their data and
came back Ready on the new pinned versions.**

- **Start state:** controller `21bb737`, OpenShell **0.0.72**, NemoClaw
  **v0.0.81** (`457311c`), OpenClaw agent **2026.6.10**, Hermes **0.18.0**.
  Two live agents (`ivos-openclaw`, `ivos-hermes`). Provider
  `compatible-endpoint` (entrim.ai / Qwen3.6-35B) → `NEMOCLAW_PROVIDER=custom`.
- **End state:** controller `e642de7`, OpenShell **0.0.85**, NemoClaw
  **v0.0.92** (`3ef2ca8`), OpenClaw **2026.7.1**, Hermes **0.18.0**. Both
  Ready + `doctor: healthy`; Hermes inference route OK (no DNS-503 on this
  box); controller `/login → 200`.
- **The headline finding — both file-tokens were already dead.** Each
  sandbox's bind-mounted `sandbox.jwt` has a **1-hour TTL** and both had
  expired weeks earlier (OpenClaw ~18 days, Hermes ~13 days); the
  containers only survived on in-memory refresh. So there was never a
  "just restart Hermes" path — the OpenShell bump guaranteed both
  containers would need recreate-with-restore, not restart. Decode with
  `cut -d. -f2 sandbox.jwt | base64 -d` and check `exp`. This is why the
  procedure above recreates both rather than racing a restart.
- **Agent-state sizes drove the cap change:** `/sandbox/.openclaw` was
  **1.8 GiB** (brushing the old 2 GiB cap; the raw `nemoclaw backup`
  256 MiB cap is the "limited to 128 MB" the operator hit);
  `/sandbox/.hermes` only 351 MiB. Raised the installer sed to 8 GiB
  (commit `e642de7`) — `backup-all` then ran clean (`2 backed up, 0
  failed`).
- **Why the wrapper's OpenShell bump had to be decomposed:** the
  `--skip-openshell` CLI-install run died exactly at "Could not retire
  the legacy OpenShell gateway after backup" — v0.0.92 `install.sh`'s
  `stop_legacy_openshell_gateway_process` refused (BYOVPS PID-file trust),
  and the gateway/containers were left untouched. Finished by hand:
  `install-openshell.sh` (0.0.85 binaries, non-destructive) →
  `pkill openshell-gateway` → `upgrade-sandboxes --auto` with
  `NEMOCLAW_RESTORE_LATEST_BACKUP_ON_RECREATE=1`.
- **Restore results:** Hermes rebuilt first (15 dirs/4 files, presets incl.
  telegram, new bearer token). OpenClaw failed twice before succeeding —
  once on the missing `dashboardPort` (patched to 18789), once on Gate E
  (18789 held by the just-rebuilt Hermes → `openshell forward stop 18789
  ivos-hermes`) — then rebuilt to 2026.7.1 (12 dirs/1 file, presets incl.
  openclaw-pricing). Device pairing (`identity/device.json`,
  `devices/paired.json`) survived the restore; re-applied
  `controlUi.allowedOrigins=["*"]` for the Android app.
- **Three backups held throughout** (none needed as last resort, but the
  `docker cp` is what makes the whole thing safe to attempt): raw
  `docker cp /sandbox` → `/root/sandbox-preserve/`, the manual
  `backup-all`, and the installer's own re-take.
- **Total agent downtime ≈ 25 min** (from `pkill` to both Ready), driven
  by two sequential base-image builds. Everything else ran with
  containers Ready.
