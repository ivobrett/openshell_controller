# Minimal install on a plain OpenShell host

Stand up OpenShell Control against a host that has **only** the OpenShell CLI +
a local gateway — no NemoClaw, no OpenClaw, no Hermes. The controller manages
**plain custom sandboxes** only. Selected with `./install.sh --minimal`
(`OPENSHELL_CONTROL_PROFILE=minimal`).

This was validated end-to-end on a fresh Ubuntu 24.04 box using the `openshell`
snap (gateway `openshell-gateway`, v0.0.88): create → Ready → inventory →
delete, all driven through the controller API.

When to read this: bringing up the dashboard on a snap/bare-OpenShell host, or
debugging why the gateway won't create sandboxes. For the full (NemoClaw) flow
see the main README and `fresh-vps-setup.md`.

---

## 1. OpenShell snap + local Docker gateway

A fresh `openshell` snap install ships the CLI **and** a gateway daemon
(`openshell.gateway`, port 17670) but starts with **no gateway configured** and
**no driver able to create sandboxes**. Bring it fully up:

```bash
snap install openshell
snap install docker

# Wire the confined gateway to the docker snap + observability interfaces.
snap connect openshell:docker docker:docker-daemon
snap connect openshell:log-observe
snap connect openshell:system-observe

snap start openshell.gateway         # daemon; refresh-mode=endure (not auto-restarted)
```

The gateway now listens on `127.0.0.1:17670` (plaintext; the snap wrapper sets
`OPENSHELL_DISABLE_TLS=true`). But **Docker sandboxes require a sandbox-JWT
signing key** — without it, `openshell sandbox create` fails with:

```
docker sandboxes require gateway JWT auth; configure [openshell.gateway.gateway_jwt]
```

Generate the signing keys and a `gateway.toml` (the snap wrapper auto-passes
`$SNAP_COMMON/gateway.toml` as `--config`):

```bash
mkdir -p /var/snap/openshell/common/tls
/snap/openshell/current/bin/openshell-gateway generate-certs \
  --output-dir /var/snap/openshell/common/tls --server-san 127.0.0.1
# writes tls/jwt/{signing.pem,public.pem,kid} (+ server/client/ca PEMs)

cat > /var/snap/openshell/common/gateway.toml <<'TOML'
[openshell.gateway.gateway_jwt]
signing_key_path = "/var/snap/openshell/common/tls/jwt/signing.pem"
public_key_path  = "/var/snap/openshell/common/tls/jwt/public.pem"
kid_path         = "/var/snap/openshell/common/tls/jwt/kid"
gateway_id       = "openshell-gateway"
ttl_secs         = 0   # 0 = non-expiring sandbox JWTs; fine for a single host

[openshell.gateway.auth]
# REQUIRED: enabling gateway_jwt turns on user-auth enforcement, so without this
# the CLI itself gets "missing authorization header". This is the documented
# local-dev / trusted-proxy escape hatch: CLI/API calls go unauthenticated while
# sandbox supervisors still present gateway-minted JWTs.
allow_unauthenticated_users = true
TOML

snap restart openshell.gateway
```

Register the gateway and smoke-test:

```bash
openshell gateway add http://127.0.0.1:17670 --local --name openshell-gateway
openshell status                       # Connected, v0.0.x
openshell sandbox create --name smoke  # → Ready
openshell sandbox exec --name smoke -- sh -c 'whoami; uname -sm'   # runs as `sandbox`
openshell sandbox delete --name smoke
```

> **Gateway name.** The controller defaults `OPENSHELL_GATEWAY` to
> `openshell-gateway` in minimal mode. If you registered a different name,
> `install.sh --minimal` auto-detects the active (`*`) gateway from
> `openshell gateway list`, or set `OPENSHELL_GATEWAY` in `.env.local` yourself.

> **Not on a snap?** The equivalent standalone container gateway is documented at
> docs.nvidia.com/openshell → *Running the Gateway as a Container*. The same
> `gateway_jwt` requirement applies.

---

## 2. Controller (minimal profile)

On the same host, as the user that owns the gateway metadata:

```bash
# Prereqs the fresh box likely lacks: Node 20+, and build tools for node-pty.
apt-get install -y build-essential python3     # node-pty compiles natively
# (install Node 20+/npm however you prefer, e.g. NodeSource)

cd /path/to/openshell_controller
./install.sh --minimal --allow-root            # drop --allow-root if not root
grep OPENSHELL_CONTROL_PASSWORD .env.local     # operator password
npm start                                      # custom server on :3000
```

`--minimal` writes an `.env.local` with `OPENSHELL_CONTROL_PROFILE=minimal`,
`OPENSHELL_GATEWAY=<detected>`, `OPENSHELL_BIN`, empty `OPEN_SHELL_CONTAINER`,
and **no** `NEMOCLAW_*` / `MCP_BROKER_*` / Ollama keys. It skips the npx/uvx MCP
toolchain and treats Docker/NemoClaw as optional (the controller drives sandboxes
through the `openshell` CLI, not the Docker socket).

### What minimal mode changes (vs. full)

| Surface | Minimal |
| --- | --- |
| Create wizard (web + mobile) | Only **New Custom Sandbox** — server filters the `/api/sandbox/create` blueprint list |
| `/api/auth/me` capabilities | `openDashboard`, `manageInference`, `manageMcp`, `viewWizards` forced **off** → those nav items + per-sandbox buttons disappear |
| Sandbox inventory / create / delete / restart / terminal / files | ✅ unchanged |
| Mobile app | Connects identically (auth/handoff/CORS preserved) |

Everything is gated by `OPENSHELL_CONTROL_PROFILE`; the default `full` profile is
untouched. Implementation lives in `app/lib/controlProfile.ts`; the invariants
are locked by `tests/minimal-profile-check.mjs`.

---

## 3. Verify end-to-end

```bash
PW=$(grep '^OPENSHELL_CONTROL_PASSWORD=' .env.local | cut -d= -f2-)
COOKIE=$(curl -sS -i -X POST http://127.0.0.1:3000/api/auth/login \
  -H 'Content-Type: application/json' -d "{\"password\":\"$PW\"}" \
  | sed -nE 's/.*openshell_control_session=([^;]+).*/\1/p' | head -1)
CB="openshell_control_session=$COOKIE"

curl -sS -b "$CB" http://127.0.0.1:3000/api/auth/me            # openDashboard/manageMcp = false
curl -sS -b "$CB" http://127.0.0.1:3000/api/sandbox/create     # blueprints = [custom-sandbox]
curl -sS -b "$CB" http://127.0.0.1:3000/api/telemetry/real     # nemoclaw.available = false
curl -sS -b "$CB" -X POST http://127.0.0.1:3000/api/sandbox/create \
  -H 'Content-Type: application/json' \
  -d '{"blueprint":"custom-sandbox","sandboxName":"ctltest","policy":null,"preset":null}'
```

Expected: `ctltest` reaches **Ready** in `openshell sandbox list`, and
`POST /api/sandbox/delete {"sandboxName":"ctltest"}` removes it.

---

## Gotchas

- **`node-pty` gyp failure during `npm ci`** (`getNotFoundError` / node-gyp
  rebuild) = missing build tools on a fresh box. `apt-get install -y
  build-essential python3` and re-run `./install.sh --minimal`.
- **"missing authorization header" from the CLI** after adding `gateway_jwt` =
  you omitted `[openshell.gateway.auth] allow_unauthenticated_users = true`.
- **Gateway restart interrupts running sandboxes.** The snap deliberately does
  not auto-restart `openshell.gateway` on refresh (`refresh-mode: endure`); after
  `snap refresh openshell` run `snap restart openshell.gateway` yourself.
