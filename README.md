
# OpenShell Control

THIS IS TRACKING current NVIDIA NemoClaw `main` with the OpenShell version declared compatible by NemoClaw's blueprint.

OpenShell Control is a local, development-stage dashboard for operating OpenShell sandboxes and their OpenClaw gateway dashboards.

It is currently built for active development and lab use. It includes a simple password gate, but it is not a hardened production control plane yet.

## Current Status

- Development software. Expect fast-moving APIs and sharp edges.
- Designed to run near the OpenShell gateway host.
- Uses local shell/CLI access for sandbox lifecycle, network policy grants, file transfer, and OpenClaw dashboard proxying.
- Authentication is intentionally simple so a future dev team can replace it with a real identity provider.

## Features

- View live OpenShell sandbox inventory.
- Create, destroy, and restart OpenClaw and Hermes sandboxes.
- Launch a sandbox-specific OpenClaw Gateway Dashboard through the local proxy.
- Approve or reject pending OpenShell network permission requests.
- Configure per-sandbox inference routes for Ollama, NIM, vLLM, and external endpoints.
- Poll Ollama for available models.
- Search the official MCP Registry, install MCP server definitions, and manage preconfigured/custom MCP servers.
- Enforce per-sandbox MCP access through a control-plane broker so sandboxes only see allowed capabilities.
- Upload files into sandboxes and download files back out.
- Open an operator terminal for the selected sandbox.
- Simple local login, setup account, forgot password, and recovery token flow.

<img width="1719" height="1185" alt="Screenshot 2026-04-27 at 3 40 27 PM" src="https://github.com/user-attachments/assets/c34c5211-aa26-4aa5-a1f8-3256bb78bdce" />

<img width="1717" height="1197" alt="Screenshot 2026-04-27 at 3 41 01 PM" src="https://github.com/user-attachments/assets/206def4d-edf1-46b3-8e00-ef24dec0d18d" />

<img width="1730" height="1183" alt="Screenshot 2026-04-27 at 3 41 12 PM" src="https://github.com/user-attachments/assets/67a0de93-e68a-48dc-845b-356baaa748db" />

<img width="1720" height="1181" alt="Screenshot 2026-04-27 at 3 41 33 PM" src="https://github.com/user-attachments/assets/23af9aac-6be3-453e-9370-c56377ce5ba2" />

<img width="1712" height="1180" alt="Screenshot 2026-04-27 at 3 41 49 PM" src="https://github.com/user-attachments/assets/2e5ce26b-3a82-43f2-b020-257d0b027a8a" />

<img width="1720" height="1185" alt="Screenshot 2026-04-27 at 3 42 09 PM" src="https://github.com/user-attachments/assets/5a573333-ffc3-49b6-9baa-2829b9949c0b" />

<img width="2117" height="1873" alt="Screenshot 2026-04-27 at 3 42 37 PM" src="https://github.com/user-attachments/assets/405ae79c-59e9-4c71-afb7-779eccb7ece7" />


## Compatibility Targets

This dashboard is validated against the current NVIDIA NemoClaw repo and the OpenShell version range declared in NemoClaw's `nemoclaw-blueprint/blueprint.yaml`, not the older April 2026 point releases. NemoClaw `v0.0.78` (the first release tag carrying the OpenClaw 2026.6.10 upgrade) pins OpenShell exactly to `0.0.72`, so the bundled refresh helper defaults to:

- OpenShell installer release: `v0.0.72` (`OPENSHELL_VERSION=v0.0.72`)
- NemoClaw source ref: tag `v0.0.78` (`NEMOCLAW_INSTALL_REF`) — keeps the Hermes v0.17.0 base
- OpenClaw base-image build target: `2026.6.10` (`OPENCLAW_VERSION=2026.6.10`) unless overridden — required for current OpenClaw mobile apps to pair

Runtime/toolchain versions used during development:

- Ubuntu/Linux host
- Node.js `20+` (Node `22.x` recommended for parity with NemoClaw)
- npm `10+`
- Docker `24+`
- OpenShell CLI and gateway compatible with current `NVIDIA/NemoClaw` blueprint constraints
- NemoClaw CLI compatible with the current `NVIDIA/NemoClaw` repo

Use `./install_versioned_nemoclaw_openshell.sh` to install or refresh the OpenShell/NemoClaw pair. Override `OPENSHELL_VERSION`, `NEMOCLAW_INSTALL_REF`, or `OPENCLAW_VERSION` only when intentionally testing a different pair.

The app uses Next.js `15.5.15`, React `18.3.1`, TypeScript, Tailwind CSS, `ws`, `node-pty`, and the official MCP TypeScript SDK.

## Prerequisites

Install and verify:

```bash
node -v
npm -v
docker ps
openshell --version
```

Optional, but useful for stdio MCP servers installed through the broker:

```bash
npx --version
uvx --version
```

OpenShell must already be installed and able to reach its gateway. On this host the active gateway metadata lives under:

```bash
~/.config/openshell/gateways/
```

The installer does not create an OpenShell gateway for you. Start or connect OpenShell first, then install this dashboard.

## Installer

Install or refresh the locked OpenShell/NemoClaw pair first:

```bash
./install_versioned_nemoclaw_openshell.sh
```

That helper defaults to `OPENSHELL_VERSION=v0.0.72`, `NEMOCLAW_INSTALL_REF=v0.0.78`, and `OPENCLAW_VERSION=2026.6.10`.

Then install the dashboard from the repository root:

```bash
./install.sh
```

The installer:

- checks Node, npm, Docker, OpenShell CLI availability, sandbox inventory reachability, and default port occupancy;
- installs or verifies the MCP package runners used by bundled stdio servers: `npx` and `uvx`;
- installs npm dependencies with `npm ci` when `package-lock.json` exists;
- runs a non-blocking `npm audit` summary;
- creates `.env.local` if needed;
- generates a local dashboard password, signing secret, and recovery token if they are missing;
- adds MCP broker defaults for token TTL and request timeout;
- runs `npm run build` as a verification step.

It refuses to run as root unless `--allow-root` is supplied. It does not install or manage a systemd service.

Options:

```bash
./install.sh --no-build
./install.sh --no-audit
./install.sh --clean-next
./install.sh --allow-root
./install.sh --start
./install.sh --help
```

After install, read the generated local password from:

```bash
grep OPENSHELL_CONTROL_PASSWORD .env.local
```

## Run

For local development with hot reload:

```bash
npm run dev
```

For a long-running dashboard or controller node, build once and run the custom server in production mode:

```bash
npm run build
npm run start
```

Open:

```text
http://localhost:3000
```

Default ports:

- `3000`: dashboard HTTP server
- `3011`: operator terminal upstream

If you set `OPENSHELL_TERMINAL_ATTACH_TEMPLATE`, leave `{sandboxId}` and `{alias}` unquoted in the template. The terminal bridge validates sandbox IDs and shell-quotes those placeholder values before executing the template.

The dashboard WebSocket proxy is served on the same listener by default, using `/api/openshell/dashboard/proxy` or `/api/openshell/instances/[instanceId]/dashboard/proxy`. Set `OPENCLAW_DASHBOARD_WS_PROXY_PORT=3001` only if you intentionally want the legacy dedicated sidecar listener.

## Ollama Inference

For WSL2 demo hosts, prefer running Ollama inside WSL2 and routing OpenShell
through `ollama-local` at `http://127.0.0.1:11434/v1`. This avoids Windows/WSL
host routing surprises and was validated with both `qwen2.5:7b` and
`nemotron-3-super:120b`.

The `nemotron-3-super:120b` Ollama tag reports a `262144` token context window
and was smoke-tested end to end through cuFolio sandbox chat on an RTX 6000
Blackwell. It fit in VRAM at Q4_K_M, but responses are much slower than the 7B
fallback.

See [OLLAMA_INFERENCE.md](OLLAMA_INFERENCE.md) for setup commands, context-window
notes, and the optional Windows-host thinkless proxy used for models that return
reasoning without OpenAI `message.content`.

## Authentication

This project currently uses a simple local password and signed HTTP-only cookie.

Configuration keys:

```bash
OPENSHELL_CONTROL_PASSWORD=...
OPENSHELL_CONTROL_AUTH_SECRET=...
OPENSHELL_CONTROL_RECOVERY_TOKEN=...
```

Pages:

- `/login`
- `/setup-account`
- `/forgot-password`

There is no email sender. Forgot-password uses `OPENSHELL_CONTROL_RECOVERY_TOKEN` from `.env.local`, which means it is a host-admin recovery flow. Anyone who can read `.env.local` can reset the dashboard password.

The mobile app (see [Mobile App](#mobile-app-android--ios)) authenticates with the
same operator password but, because a native WebView cannot share the HTTP-only
session cookie cross-origin, it sends the returned operator session token as an
`Authorization: Bearer <token>` header. This is resolved in
`app/lib/auth/context.ts` (`resolveOperator`), so a Bearer token grants the same
operator identity as the cookie. The synthetic WebView origins
(`capacitor://localhost`, `ionic://localhost`, `http://localhost`,
`https://localhost`) are trusted for CORS/CSRF by default; add more via
`OPENSHELL_CONTROL_ALLOWED_APP_ORIGINS` (comma-separated).

After changing `.env.local`, restart the server:

```bash
pkill -f 'node server.mjs|npm run dev|npm run start' || true
npm run start
```

## OpenShell And OpenClaw Notes

The dashboard shells out to the OpenShell CLI for several operations:

- `openshell list`
- `openshell sandbox exec`
- `openshell sandbox delete`
- `openshell policy get`
- `openshell policy update`
- `openshell provider create/update/delete/list`
- `openshell inference set/get/update`

OpenClaw dashboard access is loopback-only inside the host/sandbox context, so the UI uses local proxy routes:

- `/api/openshell/dashboard/proxy`
- `/api/openshell/instances/[instanceId]/dashboard/proxy`

The custom server in `server.mjs` also handles websocket upgrades for:

- operator terminal websocket traffic;
- OpenClaw dashboard websocket traffic.

Those upgrade paths are protected by the same auth cookie as the HTTP routes.
Behind a reverse proxy, route WebSocket upgrades for the dashboard proxy paths to the same `server.mjs` listener as the HTTP app. Use `OPENCLAW_DASHBOARD_BASE_WS_URL` or `BASE_WS_URL` only when the browser-visible WebSocket base must be a fully qualified override such as `wss://control.example.com/api/ws-proxy`.

## Hermes Notes

The create flow includes managed NemoClaw agent options beyond the default OpenClaw sandbox. Fresh Hermes Sandbox uses NemoClaw onboard with `--agent hermes`; Fresh Deep Agents Code Sandbox uses `--agent langchain-deepagents-code` for the upstream LangChain Deep Agents Code terminal harness. The existing Fresh NemoClaw Image and Quick Deploy paths remain OpenClaw-oriented.

## Mobile App (Android / iOS)

A [Capacitor](https://capacitorjs.com) companion app lives in [`mobile/`](mobile/).
It is a native shell (Android + iOS) around a mobile-first UI that connects to a
self-hosted OpenShell Control server over HTTPS and drives the same API as the
web dashboard.

- **Connection modes:** *Pangolin* (server behind a Pangolin tunnel, authorized
  with an access token sent as `?token=`) or *Direct URL*.
- **Controls:** view sandboxes and gateway status, restart runtimes, run health
  checks, create/destroy sandboxes, and open the full web console/terminal in an
  in-app browser (already signed in via the `/api/auth/handoff` endpoint).
- The app signs in as **operator** with the dashboard password and stores the
  returned session token on-device, sending it as a Bearer token (see
  [Authentication](#authentication)).

Build and run:

```bash
cd mobile
npm run setup            # install + create android/ios projects + sync
npm run open:android     # open in Android Studio
npm run open:ios         # open in Xcode (macOS)
```

See [`mobile/README.md`](mobile/README.md) for full setup, prerequisites, and the
security model.

## Standalone OpenShell Install (without manidae-cloud)

This dashboard does not depend on manidae-cloud. manidae-cloud is only an
optional provisioning layer (it pre-creates a baseline sandbox, bootstraps
Ollama, etc.); every feature degrades gracefully when it is absent. If you
installed OpenShell yourself — for example from
[snapcraft.io/openshell](https://snapcraft.io/openshell) or the official
[NVIDIA/OpenShell](https://github.com/NVIDIA/OpenShell) installer — you can run
the web dashboard and the mobile app entirely on your own hosts.

### Topology

The controller shells out to the local `openshell` CLI, so it runs **on the same
host as your OpenShell gateway**. To reach it from a phone, expose it with
[Pangolin](https://docs.fossorial.io). A clean, low-exposure setup is Pangolin
on a small cloud VPS with a WireGuard tunnel (Gerbil + a Newt agent) back to the
internal host — the controller host never needs a public inbound port:

```text
   Phone (mobile app)                Cloud VPS                 Internal host
  ┌───────────────────┐        ┌───────────────────┐     ┌────────────────────────┐
  │ OpenShell Control │  HTTPS │  Pangolin          │ WG  │  Newt agent            │
  │ (Pangolin mode)   │ ─────► │  + Gerbil (WG srv) │◄───►│  → openshell_controller│
  │  URL + token +    │        │  resource + token  │tunnel│    (:3000)             │
  │  operator password│        └───────────────────┘     │  OpenShell + gateway   │
  └───────────────────┘                                  │  (+ NemoClaw optional) │
                                                         └────────────────────────┘
```

Pangolin is optional — on a trusted LAN or VPN (e.g. Tailscale) you can point the
app straight at the controller with the app's **Direct URL** mode instead.

### 1. Install OpenShell (and, optionally, NemoClaw)

Install OpenShell and confirm a gateway is running. The controller reads gateway
metadata from `~/.config/openshell/gateways/`, so the controller must run as the
same user that owns that directory.

> **Snap quick-start.** For a host whose only OpenShell is the snap, bring up a
> local Docker-driver gateway named `openshell-gateway` (the name the controller
> defaults to in minimal mode):
>
> ```bash
> snap install openshell
> snap install docker
> snap connect openshell:docker docker:docker-daemon
> snap connect openshell:log-observe
> snap connect openshell:system-observe
> snap start openshell.gateway
> openshell gateway add http://127.0.0.1:17670 --local --name openshell-gateway
> ```
>
> Docker sandboxes additionally require a sandbox-JWT signing key. Generate one
> and drop a `gateway.toml` next to the snap state, then restart the gateway —
> the full validated recipe (incl. the `[openshell.gateway.gateway_jwt]` and
> `allow_unauthenticated_users` config) is in
> [`docs/runbooks/minimal-openshell-host.md`](docs/runbooks/minimal-openshell-host.md).
> Confirm with `openshell sandbox create --name smoke` → `Ready`.

NemoClaw is optional. Without it you still get a working dashboard; with it you
unlock the managed agent workflows. See the feature matrix below.

### 2. Install and run the controller

From the repository root on the OpenShell host:

```bash
./install.sh                                 # full profile (NemoClaw/OpenClaw features)
# — or, for a host that only has the OpenShell CLI + a local gateway:
./install.sh --minimal
grep OPENSHELL_CONTROL_PASSWORD .env.local   # note the generated operator password
npm run start                                # serves the web dashboard on :3000
```

`install.sh` requires Node 20+ and npm. The default (full) profile also requires
Docker and the npx/uvx MCP toolchain, and expects NemoClaw for the managed-agent
blueprints. It generates the operator password, signing secret, and recovery
token into `.env.local`.

**Minimal profile (`--minimal`)** is purpose-built for a host that already has
just the OpenShell CLI + a local gateway (e.g. the `openshell` snap). It:

- requires only `openshell` on `PATH` — Docker/NemoClaw checks become warnings,
  and the npx/uvx MCP toolchain is skipped;
- auto-detects the active gateway name (defaults to `openshell-gateway`) and
  writes `OPENSHELL_CONTROL_PROFILE=minimal` + no `NEMOCLAW_*`/MCP env;
- restricts the controller to **plain custom sandboxes** — the create wizard (web
  and mobile) offers only *New Custom Sandbox*, and the OpenClaw dashboard,
  inference-routing, MCP, and Wizards surfaces are hidden;
- still generates the auth secret + trusts the mobile-app origins, so the mobile
  app connects exactly as in full mode.

Re-running with (or without) `--minimal` converges an existing `.env.local` to
the chosen profile. Full installs are unaffected — the default is `full`.

### 3. Expose it with Pangolin

On the cloud VPS, install Pangolin and create a **resource** for the controller.
On the internal host, run a **Newt** agent so Pangolin can reach
`http://localhost:3000` over the WireGuard tunnel — no inbound port on the
controller host. Then generate a Pangolin **resource access token** (the value
that appears as `?token=…` in a share link); the mobile app sends it on every
request.

Because the dashboard now sits behind an HTTPS reverse proxy, set these in
`.env.local` so secure cookies and CSRF/origin checks work, then restart:

```bash
# The public HTTPS URL Pangolin serves the resource on.
PUBLIC_BASE_URL=https://control.example.com
# Optional: force secure session cookies if your proxy does not forward
# x-forwarded-proto: https (Pangolin/Newt normally do).
# OPENSHELL_CONTROL_COOKIE_SECURE=true
```

The four Capacitor WebView origins are trusted for CORS/CSRF by default; only set
`OPENSHELL_CONTROL_ALLOWED_APP_ORIGINS` if you customize the app's scheme (see
[Authentication](#authentication)).

### 4. Connect the mobile app

Build the app (`cd mobile && npm run setup`, then open in Android Studio / Xcode —
see [Mobile App](#mobile-app-android--ios)). On the connection screen choose
**Pangolin**, enter the public URL, paste the access token, and sign in with the
operator password. The app stores the returned session token on-device and can
open the full web console/terminal already signed in.

### Feature support: bare OpenShell vs OpenShell + NemoClaw

| Capability | Bare OpenShell | + NemoClaw |
| --- | --- | --- |
| Sandbox inventory / status | ✅ (`openshell sandbox list`) | ✅ (adds NemoClaw status/defaults) |
| Create — **Custom Sandbox** | ✅ (`openshell sandbox create`) | ✅ |
| Create — NemoClaw blueprint / Hermes / Deep Agents | ❌ needs NemoClaw | ✅ |
| Destroy sandbox | ✅ | ✅ |
| Restart runtime | ✅ (in-sandbox fallback) | ✅ (NemoClaw recover) |
| Operator terminal / file transfer | ✅ | ✅ |
| OpenClaw gateway dashboard proxy | ✅ | ✅ |
| Default-sandbox detection / registry cleanup | ⚠️ degraded | ✅ |

The installer prints a warning when the NemoClaw CLI is not found; that is
expected for a bare install and the dashboard still runs. The "Bare OpenShell"
column is what a *full-profile* install exposes against a NemoClaw-less host.
Installing with `--minimal` additionally hides the OpenClaw gateway dashboard,
inference-routing, MCP, and Wizards surfaces (rows that need NemoClaw/OpenClaw),
leaving a focused custom-sandbox controller.

## Remote Controller Nodes

The Wizards page includes **Spawn a Controller Node** for preparing a small OpenShell Control install on another VPS. This is intended for topologies where the browser-facing dashboard and the OpenShell gateway/sandbox hosts are not the same machine.

The wizard supports two deployment paths:

- **Manual Deploy** generates an SSH/bootstrap script, controller `.env` block, parent-controller URL, node shared secret, OpenShell/OpenClaw routing settings, and readiness checks.
- **Autodeploy** connects to the remote host over SSH using a one-time password supplied in the browser, optionally runs the bootstrap with sudo, installs a systemd service when available, and returns bounded stdout/stderr plus the observed host-key fingerprint.

Autodeploy does not store the SSH password or write it into generated scripts. For host-key safety, provide an expected SHA256 host-key fingerprint or explicitly select trust-on-first-deploy on a trusted management network. After the controller is running, use its local OpenShell CLI context to manage the sandboxes reachable from that VPS.

## Inference Endpoints

Inference endpoint configuration is development-stage.

The UI supports per-sandbox route profiles and can apply them live to OpenClaw where possible. Depending on the sandbox and provider, changes may require a sandbox restart to fully take effect inside the container.

Supported provider categories in the UI:

- Ollama
- NVIDIA hosted API with `nvapi-*` credentials through NemoClaw's `build` provider
- OpenAI-compatible NVIDIA/enterprise inference endpoints through NemoClaw's `custom` provider with `NEMOCLAW_ENDPOINT_URL`, `COMPATIBLE_API_KEY`, and `NEMOCLAW_PROVIDER_KEY`
- vLLM
- external HTTP-compatible endpoints

### Changing the inference provider for running sandboxes

The UI options above apply at sandbox provisioning time. To repoint **already-running** Hermes/OpenClaw sandboxes at a different LLM backend — for example when an API key expires or a trial ends — change the **gateway inference route** with the OpenShell CLI instead. There is no controller UI for this.

This works because NemoClaw-provisioned agents are not wired to a vendor endpoint at all. They are wired to the sandbox-local router:

- OpenClaw `/sandbox/.openclaw/openclaw.json` → `models.providers.inference.baseUrl = https://inference.local/v1`, `apiKey: "unused"`
- Hermes `/sandbox/.hermes/config.yaml` → `model.base_url = https://inference.local/v1`, `api_key: sk-OPENSHELL-PROXY-REWRITE`

The real credential lives only in the gateway, which injects it at the boundary. So the backend is a single gateway-level setting shared by every sandbox on that gateway.

**Do not edit the agent config inside the sandbox to change provider or model.** It is not where the credential lives, and the router overrides the model anyway (see below).

Run these on the OpenShell host, with the gateway selected and `node` on `PATH`:

```bash
export PATH=/root/.nvm/versions/node/v22.22.3/bin:$PATH
export HOME=/root
export OPENSHELL_GATEWAY=nemoclaw

# See where inference currently points, and what providers exist.
openshell inference get
openshell provider list
openshell provider list-profiles   # valid --type values

# 1. Create a provider to hold the backend credential.
openshell provider create --name nvidia-prod --type nvidia \
  --credential NVIDIA_API_KEY=nvapi-xxxxxxxx

# 2. Point the gateway's inference route at it.
openshell inference set --provider nvidia-prod \
  --model nvidia/nemotron-3-super-120b-a12b --timeout 180

# 3. Confirm.
openshell inference get
```

`provider create --type` accepts the inference profiles reported by `openshell provider list-profiles` — currently `nvidia`, `openai`, `aws-bedrock`, `deepinfra`, and `google-vertex-ai`. For an OpenAI-compatible endpoint, supply the base URL as config rather than a credential alone:

```bash
openshell provider create --name my-endpoint --type openai \
  --credential COMPATIBLE_API_KEY=sk-xxxxxxxx \
  --config OPENAI_BASE_URL=https://api.example.com/v1
```

Notes on behaviour worth knowing before you rely on this:

- **`--model` forces the model.** The router overwrites whatever model string the agent sends. A request carrying `{"model": "anything"}` still comes back as the configured model. This means agent-side model labels left over from a previous provider are cosmetic only — requests reach the new backend regardless, so there is no need to touch the sandbox to "fix" them.
- **`inference set` validates the endpoint live** before saving and prints the validated URL, so a bad key or unreachable host fails immediately instead of at the next agent turn. `--no-verify` skips that check.
- **Changes hot-reload in roughly five seconds, with no sandbox restart.** Confirm it landed by looking for `OCSF CONFIG:UPDATED ... Inference routes updated` in the sandbox container logs.
- **Timeout defaults to 60s.** Raise it (`--timeout 180`) for reasoning models that spend a long time before first token.
- Reasoning models such as Nemotron 3 return a non-standard `reasoning_content` field alongside `content`. Hermes and OpenClaw both ignore it, but it does count toward completion tokens.

To verify end to end from inside a sandbox, stage the request body as a file rather than inlining JSON in a shell command:

```bash
printf '%s' '{"model":"anything","max_tokens":64,"messages":[{"role":"user","content":"Reply with exactly: ROUTE OK"}]}' > /tmp/req.json
docker cp /tmp/req.json <container>:/tmp/req.json
docker exec <container> sh -c '. /tmp/nemoclaw-proxy-env.sh; \
  curl -s -k -X POST https://inference.local/v1/chat/completions \
  -H "Content-Type: application/json" --data-binary @/tmp/req.json'
```

A healthy response echoes the model you configured on the gateway, not the one in the request.

When checking container logs for authentication failures afterwards, anchor the window to a timestamp **after** the config update (`docker logs --since 2026-08-14T15:42:00Z <container>`). A relative window such as `--since 20m` will include the pre-change failures and make a working route look broken.

Keep the previous provider defined so you can roll back in one command:

```bash
openshell inference set --provider compatible-endpoint \
  --model Qwen/Qwen3.6-35B-A3B --timeout 180
```

To rotate a key without changing the route, update the provider in place:

```bash
openshell provider update nvidia-prod --credential NVIDIA_API_KEY=nvapi-xxxxxxxx
```

## MCP Access Broker

OpenShell Control can install and broker MCP servers without disclosing the full MCP inventory to sandboxes.

The MCP page supports:

- registry search with paged results;
- preconfigured servers, including Blender MCP;
- custom stdio or HTTP MCP servers;
- global enable/disable state;
- per-sandbox `Disabled`, `Allow All`, and `Allow Only` access policy.

The sandbox page shows an MCP indicator on each sandbox card. A sandbox lights up when at least one MCP server is allowed by policy.

For sandbox handoff, OpenShell Control writes:

```text
/sandbox/openshell_control_mcp.md
```

That file contains only the MCP broker endpoints and a sandbox-scoped token. It does not list denied servers, launch commands, credentials, or registry metadata. The broker validates the token and enforces access policy on every capabilities and tool-call request.

Broker endpoints:

```text
/api/mcp/broker/capabilities
/api/mcp/broker/call
```

Broker configuration keys:

```bash
MCP_BROKER_TOKEN_TTL_HOURS=168
MCP_BROKER_REQUEST_TIMEOUT_MS=45000
OPENSHELL_CONTROL_MCP_BROKER_URL=http://localhost:3000/api/mcp/broker
```

`OPENSHELL_CONTROL_MCP_BROKER_URL` is optional. Set it only when you need to override discovery. By default the dashboard discovers the active OpenShell Docker gateway and the selected sandbox's proxy environment before writing `/sandbox/openshell_control_mcp.md`.

Stdio MCP servers run on the control host. The installer verifies `npx`, creates or reuses a Python virtual environment, installs `uvx` there, and persists that venv path in `.env.local` so the MCP broker can launch `uvx` servers later. Custom MCP server launch commands, such as `node` or `python`, must also be available to the dashboard process.

Inter-Sandbox Chat is installed as a baseline MCP server. When it is enabled for at least one sandbox, the controller-launched sidecar watches the lightweight chat store and broker session store, claims only targeted operator messages, writes receipts, and stays out of normal sandbox-to-sandbox chat. It does not run an LLM polling loop. By default, claimed operator messages are routed into the target sandbox's OpenClaw chat over the local OpenClaw websocket gateway.

```bash
INTER_SANDBOX_CHAT_SIDECAR_POLL_MS=5000
INTER_SANDBOX_CHAT_DISPATCH_TIMEOUT_MS=120000
INTER_SANDBOX_CHAT_OPENCLAW_SESSION_KEY=inter-sandbox-chat
```

The built-in OpenClaw adapter uses the same sandbox dashboard tunnel mapping as the controller, reads the gateway token from `/sandbox/.openclaw/openclaw.json`, and sends `chat.send` to the configured session. Set `INTER_SANDBOX_CHAT_OPENCLAW_RAW_MESSAGE=1` if you do not want the adapter to wrap chat-room metadata around the operator text.

Sandbox-to-sandbox messages can use the same delivery path without loading a whole room into context. `post_message` accepts optional `targetSandboxIds`, `targetSandboxNames`, and `targetAgentIds`; the sidecar relays targeted sandbox-originated messages into each target sandbox's OpenClaw chat. By default it sends only the newest matching sandbox message per target/room poll:

```bash
INTER_SANDBOX_CHAT_SIDECAR_RELAY_SANDBOX_MESSAGES=true
INTER_SANDBOX_CHAT_SIDECAR_SANDBOX_LATEST_ONLY=true
```

Untargeted shared-room traffic still does not wake every sandbox unless `INTER_SANDBOX_CHAT_SIDECAR_PROCESS_BROADCAST=true` is set.

To override dispatch, configure a command hook:

```bash
INTER_SANDBOX_CHAT_DISPATCH_COMMAND=/path/to/dispatch-chat-message
INTER_SANDBOX_CHAT_DISPATCH_ARGS_JSON='[]'
```

The sidecar sends one JSON payload on stdin with `room`, `message`, `sandboxId`, `sandboxName`, and `agentId`. A custom dispatch command can return JSON like `{ "reply": "done", "note": "handled" }` or plain text; successful replies are posted back to the same room and the operator message is marked `processed`. Set `INTER_SANDBOX_CHAT_SIDECAR_AUTOSTART=0` to disable the controller sidecar.

## File Transfer

The file transfer UI is scoped to safe sandbox paths:

- `/sandbox`
- `/tmp`

The default max transfer size is `128 MiB`. Override with:

```bash
SANDBOX_FILE_TRANSFER_MAX_BYTES=134217728
```

## Development Commands

```bash
npm run dev
npm run lint
npx tsc --noEmit
npm run build
npm run start
```

After running `npm run build` during development, restart cleanly:

```bash
pkill -f 'node server.mjs|npm run dev' || true
rm -rf .next
npm run dev
```

## Configuration

Copy or edit `.env.local`:

```bash
cp .env.example .env.local
```

Common keys:

```bash
PORT=3000
NEXT_PUBLIC_DASHBOARD_PORT=3000
NEXT_PUBLIC_API_BASE=/api
NEXT_PUBLIC_ENABLE_SANDBOX_OPERATIONS=true
# OPENCLAW_DASHBOARD_BASE_WS_URL=wss://control.example.com
# BASE_WS_URL=wss://control.example.com
# OPENCLAW_DASHBOARD_WS_PROXY_PORT=3001
OPEN_SHELL_CONTAINER=openshell-cluster-nemoclaw
OPENSHELL_GATEWAY=nemoclaw
# Sandbox create GPU mode: none, auto, or required. Default none passes --no-gpu to NemoClaw.
OPENSHELL_CONTROL_CREATE_GPU_MODE=none
# For containerized CLI runs, when supported by the installed OpenShell/NemoClaw versions:
# OPENSHELL_GATEWAY_HOST=host.docker.internal
# OPENSHELL_GATEWAY_PORT=8080
# OPENSHELL_GATEWAY_URL=http://host.docker.internal:8080
OPENSHELL_CONTROL_PASSWORD=change-this-password
OPENSHELL_CONTROL_AUTH_SECRET=change-this-random-secret
OPENSHELL_CONTROL_RECOVERY_TOKEN=change-this-recovery-token
MCP_BROKER_TOKEN_TTL_HOURS=168
MCP_BROKER_REQUEST_TIMEOUT_MS=45000
```

The controller also accepts an OpenShell config-file form at `~/.config/openshell/gateway.json` or `~/.config/openshell/config.json`:

```json
{ "gateway": { "host": "host.docker.internal", "port": 8080 } }
```

Those values are translated into `OPENSHELL_GATEWAY_HOST`, `OPENSHELL_GATEWAY_PORT`, and `OPENSHELL_GATEWAY_URL` for controller-launched OpenShell/NemoClaw child processes.

When the host shell has `HTTP_PROXY`/`HTTPS_PROXY` set, controller-launched OpenShell/NemoClaw commands also augment `NO_PROXY`/`no_proxy` for loopback, container-host aliases, and `inference.local`. This mirrors NemoClaw's current host-subprocess proxy bypass behavior and avoids routing local gateway or managed inference traffic through a workstation proxy.

## Security Limitations

This is not production hardened.

Known limitations:

- single shared local password;
- no user accounts or roles;
- no email reset flow;
- no rate limiting;
- no audit log persistence beyond process/container logs;
- local recovery token can reset the password;
- assumes a trusted operator host and trusted local filesystem.
- MCP stdio servers run as child processes on the control host; only install trusted MCP servers.
- MCP broker tokens grant sandbox-scoped access until expiry or rotation.

Before exposing this outside a trusted lab network, replace auth with a real identity provider, add role-based access control, add audit logging, use TLS, and review every shell-out path.

## Troubleshooting

### Gateway down — `openshell sandbox list` returns "Connection refused"

The OpenShell Docker-driver gateway is a background process managed by NemoClaw. If it crashes or is killed, every `openshell sandbox` command fails with:

```
Error: × transport error
  ╰─▶ Connection refused (os error 111)
```

All sandbox containers are also stopped when the gateway shuts down.

**Recovery — one command:**

```bash
PATH=/root/.nvm/versions/node/v22.22.3/bin:/root/.local/bin:$PATH \
HOME=/root \
OPENSHELL_GATEWAY=nemoclaw \
nemoclaw <any-sandbox-name> recover
```

Replace `<any-sandbox-name>` with any name from `nemoclaw list` (e.g. `my-first-hermes`). The `recover` sub-command restarts the host gateway as a side-effect. Once it prints `✓ Docker-driver gateway is healthy`, `openshell sandbox list` works again and the sandboxes are back to Ready.

`HOME` must be set — NemoClaw needs it to locate `~/.local/state/nemoclaw/`. It is always set correctly inside the controller's systemd unit, but bare SSH sessions may lack it.

After the gateway is back, individual sandbox Hermes/OpenClaw gateways may need their own recovery if the inner gateway process also died:

```bash
# repeat for each sandbox that shows degraded health
PATH=/root/.nvm/versions/node/v22.22.3/bin:/root/.local/bin:$PATH \
HOME=/root \
OPENSHELL_GATEWAY=nemoclaw \
nemoclaw <sandbox-name> recover
```

Check OpenShell:

```bash
openshell --version
openshell list
docker ps | grep openshell
```

If sandbox creation fails with `unresolvable CDI devices nvidia.com/gpu=all`, either create the sandbox with GPU mode set to `none`, or generate the NVIDIA CDI spec on the host:

```bash
sudo nvidia-ctk cdi generate --output=/etc/cdi/nvidia.yaml
nvidia-ctk cdi list
```

Check auth:

```bash
grep OPENSHELL_CONTROL_PASSWORD .env.local
grep OPENSHELL_CONTROL_RECOVERY_TOKEN .env.local
```

Check dashboard:

```bash
npm run lint
npx tsc --noEmit
npm run build
```

If the UI behaves oddly after a production build:

```bash
pkill -f 'node server.mjs|npm run dev|npm run start' || true
rm -rf .next
npm run dev
```

## License

Internal development prototype. Add the appropriate license before distribution.
