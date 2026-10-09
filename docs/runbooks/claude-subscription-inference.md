# Runbook — running an OpenClaw sandbox on a Claude subscription (setup token)

> Indexed from CLAUDE.md §4. Written 2026-10-09 after doing this end to end
> on the Oracle BYOVPS (`ivos-openclaw`, OpenShell 0.0.116, NemoClaw v0.0.130,
> OpenClaw 2026.9.2). Everything under "Procedure" was run for real; what was
> not tested is listed at the end.

## What this does, and what it does not

An OpenClaw sandbox normally gets its model through the gateway's system
inference route (`https://inference.local`, e.g. NVIDIA). This procedure lets
one OpenClaw sandbox use the operator's **Claude Pro/Max subscription**
instead, via a token from `claude setup-token`.

It works by **bypassing** `inference.local`: OpenClaw calls
`api.anthropic.com` directly with its own saved credential. The system
inference route is untouched and keeps serving every other sandbox.

It cannot go through `inference.local`. OpenShell's Anthropic route attaches
the stored credential as `x-api-key` (`crates/openshell-core/src/inference.rs`,
`ANTHROPIC_PROFILE`), and Anthropic rejects a setup token sent that way
(`401 invalid x-api-key`). A setup token is only accepted as
`Authorization: Bearer`, and for Sonnet/Opus 5.5 only on Claude-Code-shaped
requests. NemoClaw's Anthropic provider is API-key only. OpenClaw implements
the setup-token request shape itself, which is why the credential has to live
with OpenClaw.

## Before you start

- **The token lives inside the sandbox**, in OpenClaw's auth store, where the
  agent can read it. It is a credential for the whole Claude account. Use this
  for your own agent, not as a shared or multi-tenant default.
- **Every turn draws on the subscription's usage limits**, including cron jobs
  and heartbeats. There is no automatic fallback unless you configure one.
- OpenClaw's docs say setup-token use is supported and that Anthropic staff
  told them OpenClaw-style use is allowed; they also recommend an API key for
  shared production automation. Anthropic can change this without notice.
- Get a token: on any machine with Claude Code, run `claude setup-token` and
  copy the `sk-ant-oat01-…` value. Never paste it into chat, tickets or files.

## Procedure

`<sb>` is the sandbox name. Host commands need the environment from
`. /opt/openshell-controller/scripts/upgrade/env.sh`.

1. **Host — allow the sandbox to reach Anthropic.** Sandbox egress is denied by
   default; without this the request fails with `endpoint api.anthropic.com:443
   is not allowed by any policy`.

   ```bash
   nemoclaw <sb> policy add \
     --from-file /opt/openshell-controller/scripts/claude-subscription/network-policy.yaml --yes
   ```

2. **Sandbox — save the token.** Open the sandbox terminal in the controller
   (or `openshell sandbox exec -n <sb> --tty -- bash -l` on the host) and run:

   ```bash
   openclaw models auth paste-token --provider anthropic
   ```

   Paste the token at the prompt. Expect `Auth profile: anthropic:manual
   (anthropic/token)`.

3. **Sandbox — prove it with a one-off turn** (default model unchanged):

   ```bash
   openclaw agent --agent main --model anthropic/claude-sonnet-4-6 \
     -m "Reply with exactly the single word KIWI"
   ```

4. **Sandbox — make it the default:**

   ```bash
   openclaw models set anthropic/claude-sonnet-4-6
   ```

5. **Host — restart the agent gateway.** Config hot-reload is off in NemoClaw
   sandboxes (`gateway.reload.mode=off`), so the running gateway keeps the old
   default until restarted. The agent is unreachable for ~30 s.

   ```bash
   nemoclaw <sb> gateway restart
   ```

   Running `openclaw gateway restart` **inside** the sandbox does nothing
   ("service management skipped: non-default state dir or config path").

6. **Verify.** In the sandbox, `openclaw models status` shows
   `Default: anthropic/claude-sonnet-4-6`, and a turn with no `--model` flag
   replies. On the host the gateway log confirms the route:

   ```bash
   docker exec <container> grep 'model-fetch] response' /tmp/gateway.log | tail -2
   # … provider=anthropic api=anthropic-messages model=claude-sonnet-4-6 status=200
   ```

   Then test the real channels (dashboard chat, Telegram). A conversation that
   started on another model may stay on it — start a new session (`/new`).

## Models

| Model | Result on OpenClaw 2026.9.2 |
|---|---|
| `anthropic/claude-sonnet-4-6` | Works |
| `anthropic/claude-haiku-5-5` | Works |
| `anthropic/claude-opus-5-5` | 400 when run with `--thinking off` (`thinking.type.disabled is not supported for this model`); not retried with defaults |
| `anthropic/claude-sonnet-5-5` | 400 `invalid_request_error`, cause not established |

## Undo

```bash
# sandbox
openclaw models set inference/<the-previous-model>      # see `openclaw models list`
openclaw models auth logout anthropic:manual --yes
# host
nemoclaw <sb> gateway restart
nemoclaw <sb> policy remove claude-subscription --yes
```

After `logout`, the token string can remain in
`/sandbox/.openclaw/state/openclaw.sqlite-wal` until SQLite checkpoints. If the
token may have been exposed, regenerate it with `claude setup-token`.

## What breaks it

- **Recreating the sandbox** drops both the network rule and the token; repeat
  the procedure. Whether a NemoClaw `rebuild` carries them is untested.
- **NemoClaw ≥ v0.0.131 backups refuse sandbox state that contains a token**
  ("credential-bearing or uninspectable content"), so a sandbox configured
  this way will block `backup-all` / installer upgrades on that version. Log
  the profile out before upgrading and re-add it afterwards.
- **Subscription limit reached or token revoked** → turns fail; add a fallback
  with `openclaw models fallbacks` if that matters.

## Troubleshooting

| Symptom | Cause |
|---|---|
| `CONNECT tunnel failed, response 403` / "not allowed by any policy" | Step 1 not applied, or applied to another sandbox |
| `401` from Anthropic | Token mistyped, expired or regenerated |
| `429` on a 5.5 model from a hand-rolled request | Missing Claude Code identity; OpenClaw adds it itself, `curl` does not |
| Default changed but replies still come from the old model | Gateway not restarted from the host (step 5), or the session is pinned |
| Terminal shows a log stream instead of a prompt | Controller older than the `sandbox exec --tty` terminal fix |

## Keeping the token out of the sandbox (investigated, not built)

OpenShell can hold the token and substitute it at the proxy. A custom provider
profile (credential env `CLAUDE_CODE_OAUTH_TOKEN`, `auth_style: bearer`,
`header_name: authorization`, endpoint `api.anthropic.com`) attached to the
sandbox gives processes a placeholder, and a request sent with
`Authorization: Bearer $CLAUDE_CODE_OAUTH_TOKEN` reached Anthropic with the
real token (verified with `curl`). `providers_v2_enabled` is unset on our
gateways, so the network rule above is still needed.

It does not work with OpenClaw as shipped: OpenClaw only switches to its
setup-token request shape when the key contains `sk-ant-oat`, and the
placeholder does not. OpenShell refuses the workarounds by design — a
token-shaped alias (`sk-ant-oat01-OPENSHELL-RESOLVE-ENV-…`) is rejected for
endpoint-bound credentials, and a placeholder embedded after a prefix in the
header is not rewritten. The remaining routes are a small patch to OpenClaw's
detection in the sandbox image, or baking the Claude Code CLI into the image
and using OpenClaw's `claude-cli` runtime (the npm package installs but its
native binary download is blocked by policy). OpenShell's header-injecting
token grants need a SPIFFE Workload API, which the Docker driver lacks.

## Not tested

- Hermes on a subscription token.
- The controller's **Restart runtime** action as the step-5 restart.
- Survival across a NemoClaw `rebuild`.
- Long-running use: rate-limit behaviour, token expiry (`--expires-in`).
