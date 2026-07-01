# Gateway Dashboard — Security Review & Remediation Plan

**Review date:** 2026-07-01
**Branch reviewed:** `gatewaydashboard` (fork `ivobrett/openshell_controller`)
**Scope:** Fork-local reverse-proxy wiring and sandbox exposure surfaces — the
Hermes/OpenClaw remote exposure, the dashboard/terminal proxies, and the WS
upgrade auth in `server.mjs`. **Not** in scope: OpenShell/NemoClaw/Hermes
themselves (upstream third-party), and the "use strong token credentials"
basics (already understood).

**Prior review:** `docs/upstream-divergence-audit.md` (2026-06-22) catalogs the
divergence and risk tiers. This document is the follow-up *code-level* pass over
the wiring that audit flagged 🔴 HIGH, plus a concrete task list for another
agent. Read that audit first for the architecture; read this for the specific
defects and fixes.

---

## What was verified as sound (so the next agent doesn't re-plough it)

These were checked line-by-line and are correct. Do not "fix" them blindly —
they encode deliberate invariants.

1. **WS upgrade gate vs. routing keys the same identifier.** For every proxied
   WS path in `server.mjs`, the OAuth per-sandbox gate
   (`isOAuthSandboxUpgradeAuthorized` → `extractSandboxIdFromUrl`) and the
   upstream-target resolver read the sandbox id from the *same* place:
   - Hermes `/api/sandbox/<id>/hermes/dashboard/proxy` → both use path segment 3.
   - Dashboard instances path → both use the `sandbox-<port>-<name>` path segment.
   - Legacy dashboard proxy / terminal → both use `?sandboxId`.
   There is no gate/route mismatch, so an OAuth user authorized for sandbox A
   cannot pivot to sandbox B by desyncing a second parameter. This is the thing
   that would most easily break in a refactor — see Task 5 (regression test).

2. **`x-forwarded-user` is stripped everywhere it matters.** `middleware.ts`
   `stripIdentityHeaders` removes any client-supplied value before setting its
   own; `server.mjs` `copyHeaders()` refuses to forward it upstream. Impersonation
   via that header is closed. Keep it that way.

3. **Operator-only endpoints are truly operator-only.** `isOperator()`
   (`app/lib/auth/context.ts`) validates *only* the HMAC operator-session cookie;
   the OAuth `oauth_session` cookie can never satisfy it. `/api/security/sandbox-access`
   POST (the access-map writer — the crown jewel for privilege escalation) is
   gated by `isOperator` **and** blocked for OAuth by the middleware write-allowlist.
   Double-gated. Good.

4. **Shell-injection via sandbox name is closed.** `expose.sh` (both hermes and
   openclaw) validate `^[a-z0-9][a-z0-9-]{0,62}$` *before* the name reaches
   systemd unit names, Traefik rule files, or UFW, and the Node layer uses
   `execFile` (argv, no shell). The terminal server validates
   `^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$` and `shellEscape`s before building the
   attach command. No command-injection path found.

5. **Terminal session resumption is sandbox-scoped.** `getOrCreateSession`
   refuses to hand back an existing session unless `existing.sandboxId`
   matches the (gated) requested sandbox, and session ids are UUIDs.

---

## Findings

Ranked by exploitability. None are unauthenticated-RCE; the fork's auth is
tight. The real surface is (a) a confused-deputy proxy that attaches sandbox
credentials, (b) an authenticated internal-network SSRF inherited from upstream,
and (c) two exposure-config traps.

### F1 — Authenticated internal-network SSRF via `?bootstrapUrl=` (MEDIUM, confidence high)

- **Where:** `app/api/openshell/dashboard/proxy/shared.ts`, `buildTargetUrl()`
  lines ~82–91:
  ```ts
  const bootstrapUrl = requestUrl.searchParams.get('bootstrapUrl')
  const target = bootstrapUrl ? new URL(bootstrapUrl) : new URL(normalizedPath, targetBaseUrl)
  ```
  Sink reached via `GET /api/openshell/dashboard/proxy` (and the
  `/instances/.../dashboard/proxy` variant), both of which call
  `proxyOpenClawDashboard`.
- **Attack path:** Any *authenticated* caller — an operator, **or any logged-in
  OAuth/IDP user, including one with zero sandbox grants** — requests
  `GET /api/openshell/dashboard/proxy?bootstrapUrl=http://169.254.169.254/latest/meta-data/`.
  Middleware only applies the per-sandbox gate when
  `extractSandboxIdFromUrl` finds an id; this URL carries none (no `?sandboxId`,
  not an instances path), so the request passes straight through. The controller
  then `fetch()`es the attacker-chosen URL — **host and protocol both
  attacker-controlled** — and streams the response body back to the caller. If
  the caller holds an `openclaw_dashboard_token` cookie it is also injected as
  `Authorization: Bearer …` toward that URL.
- **Impact:** Read-SSRF from the controller host into the internal network it
  can reach: the OpenShell gateway admin ports (8080/18789), the NemoClaw egress
  proxy (`10.200.0.1:3128`), sibling sandbox bridge IPs, cloud instance-metadata,
  and any other host-local service. This is exactly the "nuanced attack surface
  into sandboxes" the review targeted: a semi-trusted federated user pivoting off
  the controller.
- **Origin:** Inherited from upstream `mmckeen-nv` controller (`bootstrapUrl`
  exists on `origin/main`), **but it is live on the fork's publicly-exposed
  controller**, so it is in scope for this deployment.
- **Fix:** Allowlist `bootstrapUrl` to the resolved dashboard origin(s) before
  fetching. Reuse `resolveProxyTarget(requestUrl)` to compute the legitimate
  `targetBaseUrl`/`controlUiOrigin`, then reject any `bootstrapUrl` whose origin
  isn't in that allowlist (and drop it entirely for non-operator callers). The WS
  path already strips `bootstrapUrl` (`server.mjs` `resolveDashboardUpstream`
  line ~413) — mirror that intent on the HTTP side.

### F2 — Hermes `web` mode publishes the session token in public HTML while bypassing SSO (MEDIUM, config-gated)

- **Where:** `scripts/hermes-remote/expose.sh` lines ~150–181 (Traefik rule) and
  the mode banner comment "This route bypasses Pangolin by design."
- **Issue:** The Traefik router is identical for `desktop` and `web` mode and
  **bypasses Pangolin/SSO in both**. In `desktop` mode only `/hermes/<sb>/api/*`
  is served and `expose.sh` hard-fails if the token-bearing SPA shell is
  reachable (lines ~216–223) — good. In `web` mode the SPA shell *is* served,
  its HTML embeds `HERMES_DASHBOARD_SESSION_TOKEN`, and **nothing behind the
  route enforces the "only use behind a Pangolin-gated resource" guidance from
  the docs.** So flipping `HERMES_REMOTE_MODE=web` on a host where Pangolin
  isn't actually in front of this path publishes a working sandbox credential to
  anyone who can guess `https://<host>/hermes/<sandbox>`.
- **Impact:** Full Hermes dashboard/API access to the sandbox, no SSO, no
  operator auth — token lifted straight from HTML.
- **Origin:** Fork-local (Hermes Remote Desktop is fork feature #7).
- **Fix:** Make the safety contradiction impossible rather than documented:
  in `web` mode, either (a) refuse to write the route unless a Pangolin/SSO
  middleware is attached to it (assert the middleware chain includes the auth
  forwardAuth), or (b) add the same `curl … | grep __HERMES_SESSION_TOKEN__`
  verification and *fail* if the shell is publicly reachable without an auth
  challenge. At minimum, gate `web` mode behind an explicit
  `HERMES_REMOTE_WEB_TRUSTED=1` acknowledgement so it can't be enabled by the
  single `MODE` flag alone.

### F3 — Confused-deputy proxies rely solely on middleware for per-sandbox authz (LOW→MEDIUM, defense-in-depth)

- **Where:** `app/api/sandbox/[sandboxId]/hermes/dashboard/proxy/[[...path]]/route.ts`.
- **Issue:** This route injects the sandbox's real credential server-side
  (`headers.set('x-hermes-session-token', access.token)`) for *any* request that
  reaches it, and — unlike its siblings `hermes-remote/route.ts` and
  `openclaw-remote/route.ts`, which both call `forbiddenForIdpUser()` — it
  performs **no per-sandbox check of its own**. All authorization for this
  token-attaching proxy lives in one place: `middleware.ts` +
  `extractSandboxIdFromUrl`. The entire security of the credential injection
  therefore rests on middleware recognising the sandbox id for this exact path
  shape. It does today (path segment 3). But this is a single point of failure:
  any future proxied path prefix that `extractSandboxIdFromUrl` doesn't parse, or
  any change to the middleware `matcher`, silently turns this into an open
  token-injecting relay.
- **Fix:** Add belt-and-suspenders `forbiddenForIdpUser(request, sandboxName)`
  inside the route handler (mirror `hermes-remote/route.ts`), so the
  credential-injecting proxy is self-defending regardless of middleware. Do the
  same audit for any other route that injects a sandbox token server-side.

### F4 — UFW allow rule uses `172.0.0.0/8` (LOW, hardening)

- **Where:** `scripts/hermes-remote/expose.sh` line ~94 and
  `scripts/openclaw-remote/expose.sh` line ~136:
  `ufw allow from 172.0.0.0/8 to any port "$PORT" proto tcp`.
- **Issue:** `172.0.0.0/8` is far broader than the RFC1918 docker range
  `172.16.0.0/12` — it also spans ~15M *public* addresses (172.0–172.15,
  172.32–172.255). In practice the forward binds to the docker bridge IP so
  external hosts can't route to the port, which is why this is LOW and not
  higher. But the rule defeats the point of a bridge-scoped allow and would
  become load-bearing the moment the bind address changes.
- **Fix:** Narrow to `172.16.0.0/12` (or, better, the specific
  `traefik_bridge_ip`/docker subnet computed in `lib.sh`).

---

## Remediation plan (task list for the implementing agent)

Work on branch `claude/gateway-dashboard-security-review-orqvr5` (or a fresh
branch off `gatewaydashboard`). Run `npm run build` and the named tests after
each task. Do not touch OpenShell/NemoClaw upstream files.

**Task 1 — Fix F1 (bootstrapUrl SSRF).**
- File: `app/api/openshell/dashboard/proxy/shared.ts`.
- In `buildTargetUrl` (and/or `proxyOpenClawDashboard`), validate `bootstrapUrl`:
  parse it, compare `.origin` against the allowlist derived from
  `resolveProxyTarget(requestUrl)` (`controlUiOrigin` + `new URL(targetBaseUrl).origin`).
  If it doesn't match, ignore `bootstrapUrl` and fall back to the normal path
  join. Consider restricting `bootstrapUrl` acceptance to operator callers only.
- Add a test `tests/dashboard-proxy-bootstrapurl-ssrf-check.mjs`: assert that a
  `?bootstrapUrl=http://169.254.169.254/` (and a `file://`/other-host case) does
  **not** cause a fetch to that origin (mock `fetch`, assert the target origin).

**Task 2 — Fix F2 (Hermes web-mode SSO bypass).**
- File: `scripts/hermes-remote/expose.sh` (+ `lib.sh` if adding an assertion).
- Require an explicit trust acknowledgement env var for `web` mode, and/or add a
  post-write verification that the SPA shell is not reachable *without* an auth
  challenge on the public URL. Fail closed.
- Update `HERMES_REMOTE_DESKTOP.md` to match whatever guard you add.
- Extend `tests/hermes-recovery-guards-check.mjs` or add a new check asserting
  web mode without the ack flag refuses to expose.

**Task 3 — Fix F3 (self-defending token proxies).**
- File: `app/api/sandbox/[sandboxId]/hermes/dashboard/proxy/[[...path]]/route.ts`.
- Add an in-handler per-sandbox authz check mirroring
  `app/api/sandbox/[sandboxId]/hermes-remote/route.ts::forbiddenForIdpUser`
  (resolve the sandbox name, 403 for an IDP user without access) before the
  token is injected.
- Grep for every route that sets a `x-hermes-session-token` / dashboard bearer
  server-side and confirm each has its own check.

**Task 4 — Fix F4 (UFW scope).**
- Files: `scripts/hermes-remote/expose.sh`, `scripts/openclaw-remote/expose.sh`.
- Replace `172.0.0.0/8` with `172.16.0.0/12` (or the computed bridge subnet).

**Task 5 — Lock in the gate/route invariant (regression guard).**
- The strongest property of this codebase is that the WS/HTTP per-sandbox
  authorization gate and the upstream-target selection read the sandbox id from
  the same source. Add a test that, for each proxied path shape
  (`/api/sandbox/<id>/hermes/dashboard/proxy`, the instances path, the legacy
  `?sandboxId` path, the terminal path), the id used by
  `extractSandboxIdFromUrl` equals the id used to resolve the upstream target.
  This is the mechanical guard against a future refactor introducing the
  cross-sandbox desync that was checked-for and *not* present today.

**Task 6 — Resolve the open questions from the prior audit.**
`docs/upstream-divergence-audit.md` "Open security questions" §1–2 (file
permissions on `/etc/openshell/hermes-access/*.json` and
`data/sandbox-access.json` — both contain sandbox credentials / the access map).
Confirm on the live VPS they are `0600` and operator-owned. `sandboxAccessStore.ts`
already writes `0600`; verify the hermes/openclaw access files (written by
`expose.sh` under `umask 077`) land the same and that the containing dirs aren't
world-readable.

---

## One-line summary for the PR / hand-off

The fork's auth wiring is sound (gate and routing key the same sandbox id
everywhere, identity headers are stripped, operator endpoints are truly
operator-only). Four items to fix, in priority order: (F1) an authenticated
internal-network read-SSRF via `?bootstrapUrl=` on the dashboard proxy;
(F2) Hermes `web` mode publishes the sandbox session token in public HTML while
bypassing SSO; (F3) the token-injecting Hermes HTTP proxy has no per-sandbox
check of its own; (F4) the exposure UFW rule opens `172.0.0.0/8`. Plus a
regression test (Task 5) to freeze the gate/route invariant that currently makes
cross-sandbox pivots impossible.
