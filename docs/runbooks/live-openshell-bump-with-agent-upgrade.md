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

## Step 3 — the destructive window (OpenShell bump + NemoClaw + rebuild)

Run **detached** (base-image build is 10+ min; an SSH drop must not
orphan it). Provider from Pre-flight step 5.

```bash
cd /opt/openshell-controller

# 3a. Full installer — bumps the OpenShell .deb (kills the gateway →
#     all containers Exited). On BYOVPS it then FAILS at the 17670
#     readiness probe (gateway binds 8080, not 17670) — EXPECTED. The
#     OpenShell package upgrade itself has completed by then.
nohup env NEMOCLAW_PROVIDER=<build|custom> \
  ./install_versioned_nemoclaw_openshell.sh \
  > /tmp/vinstall-openshell.log 2>&1 &
tail -f /tmp/vinstall-openshell.log     # watch until it exits at 17670
openshell --version                      # confirm it is now the new pin

# 3b. Finish the NemoClaw half with --skip-openshell. This installs the
#     new CLI, builds the new base image, and runs upgrade-sandboxes
#     --auto: the version-moved agent (OpenClaw) is rebuilt with state
#     restored from the backup; already-at-target agents just restart.
#     Gate B fires for any legacy (pre-fingerprint) row — confirm it.
nohup env NEMOCLAW_PROVIDER=<build|custom> \
  NEMOCLAW_CONFIRM_LEGACY_MANAGED_RECREATE='["<legacy-sandbox>"]' \
  ./install_versioned_nemoclaw_openshell.sh --skip-openshell \
  > /tmp/vinstall-nemoclaw.log 2>&1 &
tail -f /tmp/vinstall-nemoclaw.log
```

**Immediately after 3a, do not dawdle** — every minute a
not-being-rebuilt container sits Exited is TTL burned (Trap 2). If 3b
is delayed, restart the survivors now:

```bash
OPENSHELL_GATEWAY=nemoclaw nemoclaw <any-sandbox> recover
```

Gates you may hit (full table in `live-vps-upgrades.md`):
- **A. strict backup** — a sandbox not Ready, or state > cap. Fix
  (raise cap / bring Ready) and re-run.
- **B. legacy managed recreate** — pre-fingerprint row; verify it was a
  managed create (its `nemoclaw-sandbox-local:<name>-<millis>` image
  timestamp ≈ registry creation time) then pass
  `NEMOCLAW_CONFIRM_LEGACY_MANAGED_RECREATE='["<name>"]'`.
- **C. provider mismatch** — you omitted `NEMOCLAW_PROVIDER` (default
  `vllm` is wrong).
- **E. rebuild preflight: 18789 owned by another sandbox** —
  `openshell forward stop 18789 <other>` and re-run.

## Step 4 — recover any tokened-out survivor

For each agent that was NOT rebuilt (already at target), check it came
back:

```bash
OPENSHELL_GATEWAY=nemoclaw openshell sandbox list
docker ps --format '{{.Names}}\t{{.Status}}' | grep '^openshell-'
```

- Ready → survived the TTL race. Done.
- `invalid token: ExpiredSignature` in `docker logs` / never leaves
  Exited → dead (Trap 2). It must be **deleted + recreated + restored**:
  1. Delete via the controller (cleans the registry row).
  2. Recreate the same agent/name via the controller.
  3. Restore its state from the raw backup: with the new container up
     but the agent gateway stopped, `docker cp
     /root/sandbox-preserve/<name>-sandbox-<STAMP>/. <newcnt>:/sandbox`
     then `chown -R sandbox:sandbox` inside, and `nemoclaw <name>
     recover`. (Prefer restoring the NemoClaw backup via the sanctioned
     rebuild path if it exists; `docker cp` is the last resort.)

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

## Execution record

_(appended after the live run — see below)_
