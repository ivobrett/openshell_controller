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

> **Variant seen on the v0.0.123 → v0.0.127 bump (2026-09-19): conditions
> 1 and 2 held but condition 3 did NOT.** OpenShell moved 0.0.106 → 0.0.116
> while *neither* agent version moved (OpenClaw stayed 2026.7.1, Hermes
> stayed 0.20.6). Use this runbook anyway — condition 1 is what makes the
> window unavoidable — but note the risk profile inverts: with no
> version-driven rebuild, **no** sandbox gets the fresh container + fresh
> token that a rebuild grants, so **every** sandbox races the token TTL in
> Trap 2 below rather than just the already-at-target one. Step 3d's
> "recreate every non-Ready sandbox from its validated backup" is then doing
> all the work, and the `docker cp` safety net matters more, not less.
> Run `upgrade-sandboxes --check` first regardless: a NemoClaw release can
> rewrite the agent images without moving the agent version (#11792 did), in
> which case it will ask for rebuilds anyway. See
> `nemoclaw-version-bumps.md` §"v0.0.123 → v0.0.127".

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

## Execution record — 2026-10-09, Oracle BYOVPS (130.61.64.124): 0.0.85 → 0.0.116

Second run on the same box, this time a **multi-hop** jump: OpenShell
0.0.85 → 0.0.116, NemoClaw v0.0.92 → **v0.0.130** (not the v0.0.131 pin —
see trap 1), OpenClaw 2026.7.1 → 2026.9.2, Hermes 0.18.0 → 0.21.3,
controller `2d0f742` → `a44d8b0`. Both agents ended Ready with state
restored and a chat turn verified, but it took ~85 min of agent downtime
instead of 25 and **the Step 3 sequence above no longer works as written**
on NemoClaw ≥ v0.0.130. Everything below was hit for real. Working files
and logs: `/root/upgrade-2026-10-09/` on the box; rollback material:
`/root/backups/2026-10-09-pre-upgrade/` (+ images `rollback/ivos-*:2026-10-09`).

### What to do differently (the sequence that worked)

1. **Run every `nemoclaw`/`openshell` command with the controller unit's
   environment**, not a bare `sudo` shell: `HOME=/root`,
   `OPENSHELL_GATEWAY=nemoclaw`, `XDG_RUNTIME_DIR=/run/user/0`,
   `DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/0/bus`. Without the last
   two, `systemctl --user` is unreachable and the v0.0.130+ installer takes
   its "systemd user manager is unavailable" branch, which can move the
   gateway to an alternate port.
2. **`apt-get install lsof` first.** NemoClaw's gateway-port probe runs
   `lsof -ti :8080 -sTCP:LISTEN`; without it every rebuild/recover preflight
   fails with `System readiness could not confirm required capabilities:
   gateway.version.compatible, gateway.port.uncontested`. Oracle's Ubuntu
   image does not ship it.
3. **Make the registry rows match the live inference route** before any
   recreate. Rows still said `compatible-endpoint` (dead Entrim) while the
   gateway was on `nvidia-prod`; a recreate re-applies the row. Also give the
   gateway provider the credential name the row expects:
   `openshell provider update nvidia-prod --credential NVIDIA_INFERENCE_API_KEY=…`
   (keep the existing `NVIDIA_API_KEY` / `OPENAI_API_KEY` entries).
4. **Take the full rollback set while Ready**: `/usr/bin/openshell*`
   binaries, `~/.local/state/nemoclaw` (minus the gateway log),
   `~/.local/state/openshell`, `~/.config/openshell`, `~/.nemoclaw` (minus
   `rebuild-backups`), `/opt/nemoclaw-src` (the wrapper `rm -rf`s it — it is
   the old CLI), plus `docker cp <cnt>:/sandbox`. On OpenShell 0.0.85 the
   `sandbox.jwt` has `exp: 0`, so the *old* containers can be restarted under
   the *old* gateway — a real rollback exists until the old container is
   deleted. After the gateway kill, take a quiesced `docker cp` and
   `docker commit` of each stopped container.
5. **Prune the junk that makes the backup impossible** (trap 2), verifying
   every file is in the `docker cp` copy first.
6. **Install the new CLI without letting install.sh retire the gateway**:
   move `~/.local/state/nemoclaw/openshell-docker-gateway/openshell-gateway.pid`
   aside for the duration of the `--skip-openshell` wrapper run (restore it
   after). The run ends at "Could not retire the legacy OpenShell gateway" —
   or earlier, at the backup — with the gateway untouched. On this box the
   PID file is root-owned and valid, so **without this the wrapper would have
   run the whole destructive window unattended**.
7. `backup-all` with the new CLI → `install-openshell.sh` → kill the old
   gateway → quiesced snapshots → **start the new gateway yourself**
   (`systemctl --user start openshell-gateway`, then copy
   `…/openshell-docker-gateway/tls/{ca.crt,client/tls.crt,client/tls.key}`
   over `~/.config/openshell/gateways/nemoclaw/mtls/` — the first 0.0.116
   start regenerates the whole PKI and the CLI then fails with
   `invalid peer certificate: BadSignature`).
8. For each sandbox: `openshell sandbox delete <name>` (the migrated legacy
   row is stuck `Ready`, see trap 5) and then
   `NEMOCLAW_RESTORE_LATEST_BACKUP_ON_RECREATE=1 nemoclaw upgrade-sandboxes --auto --yes`.
   `--check` must show the sandbox under **"Prepared backup recovery"**.
   Hermes additionally needs `TELEGRAM_BOT_TOKEN` in the environment.
9. Afterwards: `nemoclaw <name> recover` (host forwards), then the
   controller's own post-create steps via its API — `POST
   /api/sandbox/<name>/openclaw-remote`, `POST /api/sandbox/<name>/hermes-remote`,
   `POST /api/sandbox/<name>/mcp {"action":"sync"}` — and copy loose
   `/sandbox` files (anything outside `.openclaw` / `.hermes`) back from the
   quiesced copy by hand.

### New traps

1. **NemoClaw v0.0.131 cannot upgrade a real sandbox.** #12340's
   whole-home capture (a) refuses the backup if *any* file contains
   token-shaped text — chat transcripts, `runtime/state.db`, a Hermes
   `bin/tirith` binary, pip/uv caches, raw token files — with "native state
   archive contains credential-bearing or uninspectable content", (b)
   SIGSTOPs every sandbox-user process during capture and fails with
   `exit 21` when it cannot (seen on Hermes), and (c) **cannot restore
   backups taken by any earlier version** ("Legacy selective backups require
   manual file recovery"; manifest v1 backups are not even listed). v0.0.130
   sanitises instead of refusing, and has the same OpenShell/OpenClaw/Hermes
   versions, so this box was taken to v0.0.130. Treat v0.0.131 as
   fresh-install-only until upstream relaxes this; `upgrade-sandboxes` /
   `rebuild` / installer Gate A on a v0.0.131 box will hit it.
2. **v0.0.130's backup sanitiser caps structured state at 32 MiB / 100k
   entries** (`MAX_TOTAL_BYTES` in `snapshot-sanitizer-boundary.ts`; counts
   every `.json`/`.yaml`/`.env`). Over it: `Credential sanitization failed;
   removed the incomplete backup`. Not sed-fixable — the helper returns all
   candidate content as one base64 JSON string. Two things blew it here:
   26,700 Hermes `sessions/request_dump_*.json` failure dumps (554 MiB, one
   per failed cron inference call since August) and 38,400 OpenClaw session
   transcripts no longer referenced by `sessions.json` (2.8 GiB). Prune those
   (after confirming they are in the `docker cp` copy) and the backup passes
   in under a minute. A sandbox that has run for months will need this.
3. **The OpenClaw image build does a live `npm audit`.** On v0.0.130 it now
   fails with `mcporter-runtime: unaccepted npm audit findings at or above
   high: GHSA-6qxp-vccf-f47h, GHSA-jqcg-44mw-7w3h` — in `Dockerfile.base`
   *and* in the sandbox `Dockerfile`, so pulling the published base image
   does not avoid it. **No OpenClaw sandbox can be created or rebuilt on a
   stock v0.0.130 install today.** v0.0.131 carries the fix; applying just
   its `agents/openclaw/mcporter-runtime/package{,-lock}.json` and the
   matching `lockSha256` in `ci/reviewed-npm-audit.json` to the v0.0.130
   checkout makes the build pass. **Pre-build both agent images before
   killing the gateway** — this was only caught because of that.
4. **Our installer's Dockerfile unpin forces a local base-image build.**
   NemoClaw only pulls the published `ghcr.io/nvidia/nemoclaw/*sandbox-base:<tag>`
   when `Dockerfile.base` is git-clean and a version tag resolves
   (`NEMOCLAW_INSTALL_REF` in the environment). The `sed` unpin makes it
   dirty, so every box builds locally (15 min on arm64) and is exposed to
   trap 3. Reverting the Dockerfiles in `/opt/nemoclaw-src` and exporting
   `NEMOCLAW_INSTALL_REF` let Hermes use the published image.
5. **0.0.85 sandbox rows are unusable under the 0.0.116 gateway.** They list
   as `Ready` forever while the container restart-loops (`provider
   'compatible-endpoint' not found`, `sandbox requires a non-empty
   workspace`), `stop` is rejected, and `upgrade-sandboxes` reports them as
   "Unknown version … No running stale sandboxes to rebuild". Delete the row;
   the prepared-backup recovery then applies.
6. **`nemoclaw <name> recover` no longer starts the shared gateway**
   (v0.0.130: "This sandbox-scoped command will not restart the shared host
   gateway. Start the gateway again with `nemoclaw onboard`"), and the
   installer's own post-retire start targets `nemoclaw-openshell-gateway.service`,
   which does not exist on boxes carrying the upstream `.deb` unit. Start
   `openshell-gateway.service` directly (step 7 above). CLAUDE.md §3 predates this.
7. **The policy handoff carries the old live policy verbatim** and the new
   CLI rejects parts of it *after* pre-flight: a stock channel preset from
   the old version ("live network policy 'telegram' does not match the
   enabled channel requirement"), and approved rules with a binary path of
   `"-"` ("does not satisfy the shipped sandbox policy schema"). Edit the
   `rebuild-policy-handoff.<sha>.yaml` in the backup dir, rename it to its
   new sha256 and update `rebuildPolicyHandoff` in `rebuild-manifest.json`.
   A failed attempt **strips both handoffs from the manifest** ("Cannot
   rebuild an absent sandbox without its authoritative OpenShell policy" /
   "retained rebuild MCP recovery observation is unavailable") and leaves a
   `.nemoclaw-rebuild-recovery.json` journal ("already belongs to another
   transaction") — keep copies and put them back before each retry.
8. **The controller's own MCP broker entry blocks rebuilds.** `mcp.servers.
   openshell-control` in `openclaw.json` has a bearer header rather than an
   OpenShell credential binding: "MCP server 'openshell-control' has no
   complete authenticated credential binding". Remove it from the backup's
   `openclaw.json` and set `rebuildMcpHandoff.entries` to `[]`; the
   controller's MCP sync re-issues it afterwards. This will affect every
   OpenClaw rebuild on v0.0.130+ and wants a controller-side fix.
9. **A main-process exit puts the sandbox in a sticky `Error` phase.**
   `stop`, `start`, `exec`, `backup-all` and `recover` are all refused, a
   healthy restarted container does not clear it, and neither does a gateway
   restart. Only delete + recreate does. Two ways we got there: restarting
   the OpenClaw gateway on un-migrated 2026.7.1 state ("Legacy workspace
   setup state requires migration … run openclaw doctor --fix"), and Hermes
   refusing to start because the agent itself had appended a raw
   `TELEGRAM_BOT_TOKEN` to `.hermes/.env`.
10. **Manual OpenClaw state restore, when the pipeline wedges** (it did:
    "OpenShell did not return one exact durable sandbox identity", then a
    retained-recovery record that blocked both retry and `destroy`): remove
    the registry row, `nemoclaw onboard --fresh --name <name>`, `nemoclaw
    <name> stop`, stream the state dirs into the stopped container owned by
    the sandbox uid (`tar --owner=998 --group=998 … | docker cp - <cnt>:/sandbox/.openclaw/`,
    keeping the new `openclaw.json` and `models.json`), drop a
    `.nemoclaw-post-upgrade-doctor` marker (content
    `nemoclaw-openclaw-post-upgrade-doctor-v2`, mode 600, **owned by the
    sandbox uid** — a root-owned marker is refused and the start fails),
    `nemoclaw <name> start`, wait for "post-upgrade doctor completed" in
    `/tmp/nemoclaw-start.log`, then atomically replace the marker with
    `nemoclaw-openclaw-post-upgrade-doctor-release-v1`. `snapshot restore`
    is not an option ("legacy snapshot lacks managed workload and provider
    runtime authority").

### Not carried over / still open on this box

- OpenClaw's Telegram channel and its custom approved network rules were in
  the old `openclaw.json` / live policy and were not re-applied (the
  sanctioned `channels add` queues a rebuild, which fails on a source
  install: "managed image catalog 'v0.1.0' is unavailable … HTTP 404").
- The box runs v0.0.130 with a hand-applied lock fix in `/opt/nemoclaw-src`;
  re-running the installer replaces it.
- `~/.local/state/nemoclaw/openshell-docker-gateway/openshell-gateway.log`
  had grown to 2.7 GiB (the pre-0.0.116 standalone gateway logged there with
  no rotation). The 0.0.116 gateway runs as a systemd user service and logs
  to the journal, so the file is now dead weight.
