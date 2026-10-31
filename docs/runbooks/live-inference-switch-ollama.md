# Runbook — switching live agents from NVIDIA to a local Ollama model

> Indexed from CLAUDE.md §4. Written 2026-10-31 after doing it on a fresh
> Hetzner cx33 AgentGateway (4 vCPU, 7.6 GiB, no GPU, no swap) running
> NemoClaw v0.0.140, OpenShell 0.0.116, OpenClaw 2026.9.2 and Hermes 0.21.3.
> The model was `lfm3:latest` (Liquid LFM3 1.7B, Q4_K_M, tool calling).
> Both agents answered a test turn at the end. Anything not run for real is
> marked as untested.

> **Read `docs/local-inference-feasibility.md` first.** On CPU-only boxes,
> local models were too slow for our agents (3–15 min per turn).

## Summary

| Agent | Live switch result on v0.0.140 | What to do |
|---|---|---|
| **Hermes** | Works live. Run `nemoclaw inference set`; it attaches the provider, writes a scoped credential handle into `config.yaml` and restarts the gateway. | §3 |
| **OpenClaw** | Does **not** complete live. The route and config switch, but every turn fails with `HTTP 500` (OpenShell: `credential-binding … credential_unavailable`). | Recreate the sandbox (§4), or try the untested config fix in §6 |

Switching inference is a per-sandbox NemoClaw operation. Since v0.0.132
(#12562), each sandbox calls its model through **its own attached provider**
and not through the shared `inference.local` route. `openshell inference get`
therefore shows `Not configured`, and a gateway-level `openshell inference
set` moves nothing. Use `nemoclaw inference set --sandbox <name>`.

The controller's per-sandbox "apply inference" path
(`app/lib/sandboxInferenceApply.ts`) still runs a raw `openshell inference
set`. It predates this change and does **not** work for this switch. It
should be rewritten to call `nemoclaw inference set` before anyone relies on
it.

## Before you start

- **Memory decides the context window.** Ollama allocates the whole KV cache
  when it loads a model. Measured for lfm3 on the cx33 (RSS of
  `llama-server`, not the smaller size that `ollama ps` reports):

  | `OLLAMA_CONTEXT_LENGTH` | `ollama ps` size | llama-server RSS | host `available` after |
  |---|---|---|---|
  | 4096 (Ollama default) | 1.1 GiB | — | — |
  | 65536 | 1.6 GiB | — | 2.7 GiB |
  | **131072 (chosen)** | 1.8 GiB | 2.7 GiB | 2.1 GiB |
  | 262144 (model max) | 2.3 GiB | 4.3 GiB | **0.9 GiB, no swap: rejected** |

  NemoClaw's floors are 16,384 for OpenClaw and **64,000 for Hermes**. With
  the stock 4,096, `inference set` reports `Context window … 4096 tokens` and
  OpenClaw's ~11k-token prompt cannot fit.
- **CPU-only latency.** On 4 vCPU lfm3 reads the prompt at about 70 tokens/s
  and generates at about 4 tokens/s. The first turn took **3 min (OpenClaw)**
  and **5 min (Hermes)**, almost all of it reading the system prompt.
  Ollama's prompt cache makes follow-up turns faster.
- Take a rollback snapshot on the host:
  ```bash
  B=/root/inference-switch-backup-$(date +%Y%m%d-%H%M%S); mkdir -p $B
  cp -a /root/.nemoclaw/sandboxes.json /opt/openshell-controller/.env.local $B/
  nemoclaw inference get > $B/inference-get.txt 2>&1
  ```
- Run everything as root with
  `export PATH=/root/.local/bin:/root/.nvm/current/bin:$PATH HOME=/root OPENSHELL_GATEWAY=nemoclaw`.

## 1. Install Ollama (if the box was deployed without it)

Do what manidae-cloud's `startup_ollama.sh.j2` does, with two differences.
NemoClaw ≥ v0.0.140 **refuses** an Ollama bound to anything other than
loopback ("The endpoint at 127.0.0.1:11434 is reachable on a non-loopback
interface … would bypass the route's token check"). Bind it to `127.0.0.1`
and set the context window in the same override:

```bash
curl -fsSL https://ollama.com/install.sh | sh
pkill -KILL -f '^/usr/local/bin/ollama serve' || true
pkill -KILL -f '^/usr/bin/ollama serve' || true
mkdir -p /etc/systemd/system/ollama.service.d
printf '[Service]\nEnvironment="OLLAMA_HOST=127.0.0.1:11434"\nEnvironment="OLLAMA_CONTEXT_LENGTH=131072"\n' \
  > /etc/systemd/system/ollama.service.d/override.conf
systemctl daemon-reload && systemctl enable ollama && systemctl restart ollama
until curl -sf localhost:11434 >/dev/null; do sleep 1; done
HOME=/root ollama pull lfm3:latest
ollama show lfm3:latest   # Capabilities must include "tools"
```

On a fresh deploy, onboarding rewrites `override.conf` to loopback, so the
template's `0.0.0.0` is harmless there. A live switch has to do it by hand.

The template's `kill-stale-proxy.conf` drop-in kills
`ollama-auth-proxy.js`. Since v0.0.140 the proxy is
`ollama-auth-proxy.mts`, so the drop-in matches nothing. That is harmless:
NemoClaw now persists the proxy token and restarts the proxy itself on a
mismatch.

## 2. Start NemoClaw's Ollama auth proxy (first switch on a box only)

Sandboxes reach Ollama through NemoClaw's token-checking proxy on
`:11435`. Onboarding normally creates it. If the box was onboarded on NVIDIA,
the proxy is missing and `inference set` fails with
`Docker container reachability check failed for http://host.openshell.internal:11435`.
Start it with the same functions onboarding uses:

```bash
cd /opt/nemoclaw && node -e '
const p=require("./dist/lib/inference/ollama/proxy.js");
(async()=>{ console.log("started",p.startOllamaAuthProxy());
  await p.persistAndProbeOllamaProxy(p.getOllamaProxyToken());
  console.log("healthy",p.isProxyHealthy()); })()'
ss -ltnp | grep 11435
```

ufw must allow the sandbox bridges to reach 11435. AgentGateway boxes already
have `11435/tcp ALLOW 172.0.0.0/8`.

**Every `systemctl restart ollama` may need the proxy re-checked:**
`node -e 'require("/opt/nemoclaw/dist/lib/inference/ollama/proxy.js").ensureOllamaAuthProxy()'`.

## 3. Hermes — live switch (verified)

```bash
nemoclaw inference set --provider ollama-local --model lfm3:latest --sandbox <hermes-sb>
```

Expected output: `Using attached native provider`, then `Context window for
'lfm3:latest': 131072 tokens`, `Syncing Hermes model route`, `Restarting the
Hermes gateway` and `Inference route synced`. NemoClaw creates a
**per-sandbox** local provider (`nemoclaw-local-v1-<hash>`), attaches it and
detaches the NVIDIA one.

Then check that the scoped handle in the config matches the sandbox's current
revision:

```bash
C=$(docker ps --format '{{.Names}}' | grep -- "--<hermes-sb>-")
docker exec $C grep -n 'api_key: openshell' /sandbox/.hermes/config.yaml
openshell sandbox exec -n <hermes-sb> -- printenv NEMOCLAW_LOCAL_INFERENCE_TOKEN
```

The two `v<number>_` revisions must be identical. If they differ, chat fails
with `HTTP 500 … unresolved credential placeholder in request`. Re-run the
same `inference set`, which rewrites the config with the current revision.
Test:

```bash
openshell sandbox exec -n <hermes-sb> -- sh -lc 'cd /sandbox && hermes chat -Q -q "What is 17 + 25? Reply with just the number."'
```

**Never attach a local provider by hand** with `openshell sandbox provider
attach`. The second provider clashes with NemoClaw's own
(`credential key 'NEMOCLAW_LOCAL_INFERENCE_TOKEN' is provided by both
provider …`). If you did, `openshell sandbox provider detach <sb> <provider>`
and re-run `inference set`.

## 4. OpenClaw — recreate (the live switch does not complete)

What happens if you run `inference set` on a running OpenClaw sandbox:
`openclaw.json` gets `baseUrl http://host.openshell.internal:11435/v1` and an
**unscoped** `apiKey: openshell:resolve:env:NEMOCLAW_LOCAL_INFERENCE_TOKEN`.
The "gateway restart" happens inside the running process (same pid), so the
gateway keeps the environment it started with, which holds only
`NVIDIA_INFERENCE_API_KEY`. OpenShell's credential binding then rejects every
model call (`DENIED … engine:credential-binding reason:credential_unavailable`),
and OpenClaw shows `inference/lfm3:latest request failed (provider internal
error, HTTP 500)`. `nemoclaw <sb> gateway restart` keeps the same pid and
does not fix it.

A freshly onboarded OpenClaw sandbox gets a **scoped** handle
(`v<rev>_NEMOCLAW_LOCAL_INFERENCE_TOKEN`) and works. So for OpenClaw:

1. Back up anything in the agent worth keeping (memory, skills,
   workspace). Controller backup/restore is the normal path.
2. Point the controller at Ollama for new creates and recovers (§5).
3. Delete the sandbox and recreate it from the dashboard (OpenClaw blueprint,
   default inference). Onboarding picks up `NEMOCLAW_PROVIDER=ollama`. On the
   test box this took 86 s and the first turn answered correctly.

`nemoclaw <sb> rebuild --yes` would preserve the workspace in theory. It
needs the sandbox Ready (it backs up through `sandbox exec`) and was not
tested on a healthy OpenClaw sandbox. Try it before deleting if the
workspace matters, and record the result here.

### Do not

- **`nemoclaw <sb> stop`** on v0.0.140: it stops the in-sandbox gateway, then
  fails to stop the container (`OpenShell is unavailable (Error, code
  ERR_MODULE_NOT_FOUND)`). With its gateway gone the entrypoint exits, the
  container exits with 143, and OpenShell marks the sandbox **`Error`
  permanently**. After that `recover`, `rebuild` and `docker start` all
  fail, and only delete + recreate clears it (CLAUDE.md §9).
- `docker exec … openclaw agent` as a test: `docker exec` does not enter the
  sandbox network namespace, so it gets `ECONNREFUSED 127.0.0.1:18789`
  whatever the inference state. Use `nemoclaw <sb> agent --session-id <id> -m "…"`.

## 5. Make it durable — controller `.env.local`

Without this, the controller onboards new sandboxes on NVIDIA, and every
`nemoclaw <sb> recover` it runs (UI restart) inherits the NVIDIA settings
(see the inference-provider-switch memory, 2026-08-14). In
`/opt/openshell-controller/.env.local` (back it up first):

```
NEMOCLAW_PROVIDER=ollama
NEMOCLAW_MODEL=lfm3:latest
OLLAMA_BASE_URL=http://localhost:11434
OLLAMA_MODEL=lfm3:latest
```

Keep `NVIDIA_API_KEY` for rollback. Then `systemctl restart
openshell-controller`. Creating through the API needs
`"createInference":{"mode":"auto"}` in the body. Without it the route
defaults to `vllm` and onboarding exits 1 within seconds. The dashboard
sends `auto`.

## 6. Untested: fixing a live OpenClaw sandbox without recreating

Evidence from the test: Hermes worked with a scoped handle written into its
config while its gateway process had no `NEMOCLAW_LOCAL_INFERENCE_TOKEN` in
its environment. That suggests rewriting OpenClaw's `apiKey` to the sandbox's
scoped handle (`openshell sandbox exec -n <sb> -- printenv
NEMOCLAW_LOCAL_INFERENCE_TOKEN`) followed by `nemoclaw <sb> gateway restart`
might be enough. Not tried. If you try it, back up `openclaw.json` first,
record the result here, and report the unscoped handle to NemoClaw.

## Verify

```bash
openshell sandbox provider list <sb>      # only nemoclaw-local-v1-<hash>
nemoclaw <openclaw-sb> agent --session-id t1 -m "What is 17 + 25? Reply with just the number." --json
docker logs --since 10m $C 2>&1 | grep -E '11435|DENIED'   # ALLOWED, no credential-binding denials
curl -s localhost:11434/api/ps            # context_length = OLLAMA_CONTEXT_LENGTH
```

## Rollback to NVIDIA

```bash
nemoclaw inference set --provider nvidia-prod --model nvidia/nemotron-3.5-super-vl-120b-a12b --sandbox <sb>
```

Restore `.env.local` from the backup and restart the controller. OpenClaw
probably has the same in-process-restart problem in this direction, which
is untested. If turns fail, recreate it as in §4.

## 7. Older sandboxes on the shared route (Oracle BYOVPS, 2026-10-31)

Sandboxes created before NemoClaw v0.0.132 (Oracle's `ivos-openclaw` and
`ivos-hermes` were created on v0.0.130) have no attached native provider.
They call `https://inference.local/v1`, and the gateway injects the
credential. One switch of the shared route moves **all** of them at once,
OpenClaw included, with no restart or config edit. `nemoclaw inference
set` warns about exactly this ("will re-point the one shared inference
route").

Procedure that worked on NemoClaw v0.0.135:

1. §1 (Ollama on loopback) and §2 (auth proxy).
2. Register the gateway provider the way onboarding does. Without it,
   `inference set` fails with `provider 'ollama-local' not found`:
   ```bash
   cd /opt/nemoclaw-src && node -e '
   const prov=require("./dist/lib/onboard/providers.js"), local=require("./dist/lib/inference/local.js"),
         proxy=require("./dist/lib/inference/ollama/proxy.js");
   (async()=>console.log(await prov.upsertProvider("ollama-local","openai","NEMOCLAW_OLLAMA_PROXY_TOKEN",
     local.getLocalProviderBaseUrl("ollama-local"),{NEMOCLAW_OLLAMA_PROXY_TOKEN:proxy.getOllamaProxyToken()})))()'
   ```
3. `nemoclaw inference set --provider ollama-local --model <m> --sandbox <any-sb>`.
   On Hermes the in-sandbox config write may be refused ("integrity metadata is
   not ready"). That does not matter on the shared route, because the gateway
   forces the model.
4. **Raise the route timeout.** `inference set` resets it to the 60 s default:
   `openshell inference set --provider ollama-local --model <m> --timeout 1800 --no-verify`.

### Why it was rolled back: CPU-only speed with real agents

Live agents carry far bigger prompts than fresh sandboxes: 27k tokens
(OpenClaw) and 37.5k tokens (Hermes), against about 11k on a fresh
sandbox. On 4 ARM Neoverse-N1 cores:

| Model | Prompt read rate | Result |
|---|---|---|
| lfm3:latest (1.7B hybrid) | 45–75 tok/s, falling as the prompt grows | OpenClaw 9 min 50 s per turn, Hermes ~15 min. **Every** turn re-reads the whole prompt: llama.cpp can't reuse the prefix of hybrid/recurrent models (`forcing full prompt re-processing`). |
| llama3.2:1b (standard attention) | 29 tok/s on a 7.6k synthetic prompt | Prefix cache works (follow-up 9 s in the synthetic test). With the real agent, turn 1 exceeded OpenClaw's **600 s `agents.defaults.timeoutSeconds`** and timed out. Turn 2 landed on the *other* `OLLAMA_NUM_PARALLEL` slot and started from scratch. |

Conclusion: local CPU inference is not usable for these agents. It needs
a GPU, or agents with much smaller prompts. Trap: loading several models
with large contexts at once OOM-killed `llama-server` on a 24 GB box. Set
`OLLAMA_MAX_LOADED_MODELS=1`.

### Rolling back (the trap is requests already in flight)

1. `openshell inference set --provider nvidia-prod --model <model> --timeout 180`
   (this validates the endpoint). `nemoclaw inference set --provider nvidia-prod`
   **failed** on the old sandboxes ("host credential required to create
   provider nemoclaw-nvidia-prod-v1"), so NemoClaw's registry kept
   `ollama-local`. Restore `~/.nemoclaw/sandboxes.json` from the pre-switch
   backup, otherwise a later `recover` can re-apply Ollama.
2. Restore `.env.local` and restart the controller.
3. **`systemctl restart ollama`**. A request that reached the old route
   just before the switch keeps running in Ollama at 400% CPU and starves
   the box. OpenClaw then *looks* as if it's still on Ollama even though
   new requests go to NVIDIA.
4. `nemoclaw <openclaw-sb> gateway restart` to clear runs stuck in
   `processing`.
