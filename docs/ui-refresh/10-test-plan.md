# 10 — Test plan

Three layers: (1) automated `tests/*.mjs` additions run by `npm test`,
(2) manual BYOVPS matrix per phase, (3) security regression checks. The
existing suite's style is source-text + behavioural assertions in plain
node scripts exiting non-zero on failure — match it exactly (look at
`tests/dashboard-token-cookie-wins-check.mjs` for the pattern).

## 10.1 Automated additions

| Test file | Phase | Asserts |
|---|---|---|
| `tests/auth-me-capabilities-check.mjs` | 1 | `app/api/auth/me/route.ts` source contains `role`, `allowedSandboxes`, legacy `operator:`; OAUTH_CAPS has `createSandbox: false`, `deleteSandbox: false`, `manageShields: false`, `approvePermissions: false`; OPERATOR_CAPS all-true (parse the object literals with a regex or `Function` eval of the extracted block) |
| `tests/inventory-filter-check.mjs` | 1 | behavioural: import `filterInventory.mjs`; fixture with sandboxes `alpha/beta/gamma` in both `sandboxes[]` and `pods.items[]` shapes + nemoclaw block; allowed=`{alpha}` → result JSON contains `alpha`, contains NO `beta`/`gamma` substrings, `serviceLines`/`summaryLines` empty |
| `tests/sandbox-page-gating-check.mjs` | 1 | behavioural: `extractSandboxIdFromUrl('/sandboxes/alpha')==='alpha'`, `('/sandboxes/alpha/anything')==='alpha'`, `('/sandboxes/new')===null`, `('/sandboxes/')===null`; regression: `/api/sandbox/foo/...`→`foo`, `/api/openshell/instances/sandbox-3-bar/...`→`bar`, `?sandboxId=baz`→`baz` |
| `tests/inventory-hook-resilience-check.mjs` | 3 | source-text on `app/hooks/queries.ts`: contains `keepPreviousData` in the inventory query; does NOT contain `setSandboxes([])`; `app/hooks/useSandboxInventory.ts` no longer exists |
| `tests/launch-page-sync-open-check.mjs` | 4 | source-text: `app/lib/launchDashboard.ts` calls `window.open` with `/launch/dashboard`; NO component under `app/components/` awaits `/api/openshell/dashboard/open` before a `window.open` (grep components dir for `dashboard/open` → only allowed in `app/launch/dashboard/page.tsx`) |
| `tests/role-gating-source-check.mjs` | 3–4 | source-text: `SandboxTable.tsx` and `sandboxes/[name]/page.tsx` reference `useCan`/`capabilities` before rendering `Delete`, `Restart`, `New sandbox` strings; `DeleteSandboxDialog.tsx` contains the typed-name confirmation (`===` comparison against sandbox name) |
| `tests/approvals-bell-check.mjs` | 3 | source-text: `ApprovalsBell.tsx` gates on `approvePermissions`; Allow/Deny go through `app/lib/permissionActions.ts`; `permissionActions.ts` invalidates the permissions query; the bell renders no operator data for `role !== "operator"` (component early-returns before any list render) |
| `tests/gateway-repair-button-check.mjs` | 3 | source-text: `GatewayRepairButton.tsx` POSTs `/api/openshell/gateway/repair` via `apiFetch`, has an `AbortSignal.timeout`, renders stdout/stderr on failure; it appears ONLY inside the no-cached-data error state (grep `app/(shell)/page.tsx`) |
| `tests/restart-ux-check.mjs` | 3–4 | source: restart action uses `AbortSignal.timeout(180_000)`, branches on `restartMode`, treats `restarted:false` as a warning not success (§12.4) |
| `tests/delete-dialog-backup-check.mjs` | 3 | source: `DeleteSandboxDialog.tsx` contains the backup-download row gated on running status (§12.5.1) |
| `tests/terminal-reconnect-check.mjs` | 4b | source of `useTerminalConnection.ts`: backoff `[1000,2000,4000,8000,15000]`; `visibilitychange` + `online` listeners; sessionId preserved on reconnect; `{type:"ping"}` at 25 000 ms with `document.hidden` guard (§12.3) |
| `tests/terminal-server-ping-tolerance-check.mjs` | 4b | source of `terminal-server.mjs`: message handler neither throws nor closes on unknown message types — locks in the behaviour the keepalive relies on (§12.1) |
| `tests/skills-route-check.mjs` | 4c | skills routes are GET-only, id-regex + path-traversal guard present, list skips malformed files (§13.2) |
| `tests/skills-no-secrets-check.mjs` | 4c | no secret-shaped strings in `skills/*.md` (patterns in §13.2 — tripwire, not guarantee) |
| `tests/totp-login-check.mjs` | 8 (optional) | see §7.3 |

Rules: never weaken existing tests to make new code pass; if the vm-extract
regex in `dashboard-token-runtime-check.mjs` breaks, you touched something
you shouldn't have (this plan requires no `server.mjs` changes).

## 10.2 Manual BYOVPS matrix (run in full before the final merge; per-phase
subsets listed in §09)

Setup: deploy branch; two browser profiles — A) operator (password login),
B) IdP user with access granted to exactly one sandbox (grant via
Security page). Have ≥2 sandboxes: one OpenClaw, one Hermes.

| # | As | Steps | Pass criteria |
|---|---|---|---|
| M1 | A | Login (password) | Lands on `/` dashboard; operator badge in sidebar footer |
| M2 | B | Login (IdP via Pangolin) | Lands on `/`; sees ONLY granted sandbox; nav shows no Inference/MCP/Wizards/New sandbox |
| M3 | A | Dashboard with 7+ sandboxes (create temps via CLI if needed) | Table fits one screen at 1440×900; LEDs correct |
| M4 | A | Row menu → Delete → type wrong name | Button disabled |
| M5 | A | Delete with correct name | Toast, row disappears ≤20 s, activity entry appears |
| M6 | A | `+ New sandbox` → create OpenClaw blueprint | Redirects to detail page when inventory reports it |
| M7 | A | Detail: every tab on OpenClaw sandbox | All function; Policy badge counts match pending requests |
| M8 | A | Detail on Hermes sandbox | Access tab = HermesRemotePanel; no Shields tab; Hermes dashboard button opens proxy |
| M9 | A | Open dashboard (warm) | Tab opens instantly, progress shows, Control UI loads |
| M10 | A | `systemctl restart openshell-controller`, first Open dashboard after | Progress runs long, still lands in Control UI ≤45 s, no popup block |
| M11 | A | Delete sandbox, recreate SAME name, Open dashboard | NO "Auth did not match" (CLAUDE.md §10) |
| M12 | A | Leave tab idle 30+ min (laptop lid closed ok), return | No error panel; data refreshes on focus; at worst brief "Reconnecting…" |
| M13 | B | Open granted sandbox detail | Overview only + Terminal/dashboard buttons; terminal connects |
| M14 | B | Manually visit `/sandboxes/<ungranted-name>` | Redirect to `/` + denied toast (API: `curl` the inventory as B → filtered) |
| M15 | B | Attempt POST (devtools fetch `/api/sandbox/<granted>/restart`) | 403 from middleware (server enforcement independent of UI) |
| M16 | A | Theme toggle → reload | Theme persists, no flash of wrong theme |
| M17 | A | 390 px viewport (devtools) full walkthrough | Bottom tabs, sheet nav, cards list, detail tabs scrollable, dialogs usable |
| M18 | A | Logout / login `next=` deep link | Returns to deep-linked tab |
| M19 | A | CLAUDE.md §7 smoke tests (login curl, /api/auth/me, password rotation) | All pass, `willRestart:false` |
| M20 | A | Copy dashboard + terminal links, open in profile B | Access enforced (granted sandbox works, other 403/redirects) |
| M21 | A | Type in table search + toggle status chips | Rows filter live; "Clear filters" restores; counts on chips correct |
| M22 | A | Trigger an agent network-permission request; check bell from a NON-dashboard page (e.g. /activity) | Badge count appears; Allow from popover succeeds; Policy tab reflects it; toast shown |
| M23 | B | Same pending request state | No bell rendered for IdP user |
| M24 | A | Kill the gateway on the VPS (`nemoclaw` gateway process — coordinate with operator; or test right after a controller cold state where inventory errors with no cache) | Error panel shows "Attempt gateway repair"; clicking runs it (≤120 s) and inventory recovers, or stdout/stderr + runbook hint shown on failure |
| M25 | A | Open a shell, run `openclaw --help` in it, then `systemctl restart openshell-controller` on the VPS | Reconnecting overlay; shell auto-reattaches with scrollback intact ≤60 s |
| M26 | A | Leave a connected terminal idle 10+ min through Pangolin | Still live (keepalive); typing works immediately |
| M27 | A | 390 px + touch emulation on `/operator-terminal` | Key bar sends Esc/Tab/Ctrl-C/arrows; prompt visible with soft keyboard open; font-size buttons work |
| M28 | A | `Restart runtime` on a Ready sandbox while a terminal to it is open in another tab | Toast names the mode (`Recovered via NemoClaw` or `Restarted OpenClaw runtime`); the terminal tab reconnects by itself |
| M29 | A | Delete dialog → `Download backup` → then delete | A valid `.tar` archive downloads; deletion proceeds independently |
| M30 | A | `/skills`: Copy + View on the template skill | Clipboard gets the body only (no frontmatter); dialog renders mono with newlines |
| M31 | A | Terminal → Skills sheet → copy → paste into shell | Content intact incl. newlines; sheet stays open |
| M32 | A+B | Check `MEM`/`CHAT` chips on table + detail; as A, Enable `memory` from the Overview card | Chips flip after enable + manifest-sync toast; B sees chips read-only and can read `/skills` |

For visual checks you MAY use the chrome-devtools MCP against the BYOVPS
(pangolin `admin@mcpgateway.online` / `Password123q!`, controller operator
password `Password123q!`) — but note the recorded caveat that these MCP
calls have hung in past sessions; if a call hangs, fall back to asking the
operator for screenshots or `curl` checks. Never let a hung MCP call stall
a phase.

## 10.3 Security regression checklist (before final merge)

- [ ] `middleware.ts` diff is ONLY: policy.mjs import usage unchanged,
      denied-redirect in oauth branch, `/manifest.webmanifest` public path.
      The switch structure, header stripping (`x-forwarded-user`), CSRF
      origin check, and security headers are byte-identical otherwise.
- [ ] `OAUTH_WRITE_ALLOWED_PATHS` unchanged (exactly one entry).
- [ ] No new route handler trusts client-supplied identity; new/changed
      routes (`auth/me`, `telemetry/real`, `activity`, `totp/*`) derive
      identity via `resolveAuthContext`/`isOperator`/`oauthEmail` only.
- [ ] `server.mjs` and `app/api/openshell/dashboard/proxy/shared.ts`
      untouched (`git diff gatewaydashboard...ui-refresh -- server.mjs
      app/api/openshell/dashboard/proxy/shared.ts` is empty).
- [ ] `npm test`: dashboard-token cookie-wins + runtime checks green.
- [ ] Delete dialog cannot fire without exact name match (M4).
- [ ] IdP inventory filtering verified with curl as B (M14).
- [ ] No secrets/tokens rendered in new UI (grep new components for
      `token` — pairing QR and copy-link flows only, matching current
      behaviour).
- [ ] `X-Frame-Options: DENY` etc. still on responses (curl -I `/`).
- [ ] TOTP file (if Phase 8) is 0600 and gitignored (`data/` — verify
      `.gitignore` covers `data/operator-totp.json`; add if not).

## 10.4 Rollback

Every phase is a normal commit on `ui-refresh`; production stays on
`gatewaydashboard` until the final `--no-ff` merge, which reverts as one
unit (`git revert -m 1 <merge-sha>`). On the BYOVPS, rollback = checkout the
recorded pre-deploy SHA + rebuild + restart (CLAUDE.md §2).
