# 09 — Implementation phases

One phase = one deployable commit series on branch `ui-refresh` (created off
an up-to-date `gatewaydashboard`). After EVERY phase: `npm run build` &&
`npm test` (baseline: only the pre-existing failures recorded in Phase 0),
deploy the branch to the BYOVPS per CLAUDE.md §2, run that phase's manual
checks from §10, THEN start the next phase. Do not batch phases into one
deploy — a regression must be attributable to one phase.

Commit message prefix per phase: `feat(ui-refresh): P<n> — <summary>`.

## Execution protocol: sessions and model assignment

Run **one phase per agent session, with fresh context each time.** Start
every session with: "Read `docs/ui-refresh/README.md`, then execute Phase
<n> from `docs/ui-refresh/09-implementation-phases.md` exactly as specified,
including its referenced sections." Do not let one session run multiple
phases — context degrades and regressions become unattributable.

Model assignment (operator selects the model when launching each session):

| Phase | Model | Why | Extra gate |
|---|---|---|---|
| 0 — Foundations | **Sonnet** | Mechanical vendoring + token setup against exact specs | — |
| 1 — Capabilities + filtering | **Opus** | Touches `middleware.ts` / `policy.mjs` — auth enforcement; a subtle mistake is a security hole | **`/code-review ultra` on the branch before deploying** |
| 2 — App shell + routes | **Sonnet** | Structural but fully specified | — |
| 3 — Dashboard page | **Sonnet** | Table/dialog/hooks from exact specs | — |
| 4 — Sandbox detail + launch | **Opus** | Deletes `SandboxList.tsx`, works adjacent to the CLAUDE.md §10 token chain; delete/recreate invariant | **`/code-review ultra` before deploying** |
| 4b — Terminal hardening | **Opus** | Reconnection state machine with real concurrency (socket lifecycle, backoff, visibility events) | — |
| 4c — Skills + capability chips | **Sonnet** | Small read-only routes + presentational components; traversal guard is fully specified | — |
| 5 — Login + security | **Sonnet** | Restyle with preserved logic | — |
| 6 — Heavy-panel restyle | **Sonnet** | Explicitly classes-only; diffs must show no logic churn | — |
| 7 — Mobile polish + PWA | **Sonnet** | Additive, low risk | — |
| 8 — TOTP (optional) | **Opus** | Auth-path change (login route, rate limiting, secret storage) | **`/code-review ultra` before deploying** |
| Final merge | **Opus** | Runs the full §10 regression matrix + security checklist and the `--no-ff` merge | — |

Rules for whichever model is running:
- The plan overrides model preference — no substitutions, no
  "improvements" beyond the spec. If the spec conflicts with repo reality,
  stop and report; do not improvise (README ground rules apply).
- `/code-review ultra` is launched by the **operator** (it is
  user-triggered and billed); the agent should finish the phase, push the
  branch, and explicitly ask the operator to run it before the deploy step
  on the gated phases.
- If a Sonnet session gets stuck or produces a failing `npm test` it cannot
  fix within the phase's scope, stop and hand the phase to an Opus session
  rather than widening the change.

---

## Phase 0 — Foundations (no visual change)

**Model: Sonnet.**

**Create:** `app/lib/utils.ts` (cn), `app/lib/apiFetch.ts`,
`app/lib/queryClient.ts`, `app/components/providers/Providers.tsx`,
`app/components/providers/AuthProvider.tsx`, all `app/components/ui/*`
(§2.2), `app/components/StatusLed.tsx`, `app/components/PageHeader.tsx`.
**Modify:** `package.json` (deps §2.1), `tailwind.config.ts` (§2.4),
`app/globals.css` (§2.3 tokens + legacy bridge), `app/layout.tsx` (§4.2),
project-wide `var(--background)`→`var(--background-hex)` /
`var(--foreground)`→`var(--foreground-hex)` replacement in `app/**/*.tsx`
client files (§2.3 pitfall).

Before starting: run `npm test` on clean checkout, record the exact failing
baseline in the commit message of P0.

**Accept:** build passes; UI renders pixel-identical (spot-check dashboard,
login, a sandbox drawer on the BYOVPS); `npm test` at baseline; no console
errors about unknown CSS vars.

## Phase 1 — Capabilities + filtering (server, §03)

**Model: Opus. Operator runs `/code-review ultra` on the pushed branch
before the deploy step.**

**Modify:** `app/api/auth/me/route.ts` (v2), `app/api/telemetry/real/route.ts`
(filter), `app/api/activity/route.ts` (filter), `app/lib/auth/policy.mjs`
(`/sandboxes/` extraction), `middleware.ts` (denied-redirect only).
**Create:** `app/lib/auth/filterInventory.mjs`,
`tests/auth-me-capabilities-check.mjs`, `tests/inventory-filter-check.mjs`,
`tests/sandbox-page-gating-check.mjs`.

**Accept:** new tests pass; on BYOVPS as operator `/api/auth/me` returns
`role:"operator"`, `allowedSandboxes:"all"`; as an IdP user (grant one
sandbox via /setup-account first) `/api/telemetry/real` returns only that
sandbox and `/api/auth/me` lists it; legacy `operator` field still present
(ShieldsPanel admin check works); dashboard-token tests still green.

## Phase 2 — App shell + routes (§04)

**Model: Sonnet.**

**Create:** `app/(shell)/layout.tsx`, `app/components/shell/{AppShell,
AppSidebar,TopBar,MobileTabBar,NodeSwitcher,nav.ts}`, `app/lib/useTheme.ts`,
route stubs `app/(shell)/{activity,inference,mcp,wizards,security,help}/page.tsx`
hosting the existing panels, `app/(shell)/page.tsx` (dashboard host —
temporarily renders the existing `SandboxList` + `ActivityPanel` inside the
new shell so nothing breaks mid-refresh), `app/(shell)/sandboxes/new/page.tsx`.
**Delete:** `app/page.tsx` (old), `app/components/Sidebar.tsx`.
**Modify:** `app/setup-account/page.tsx` (redirect split per §7.2).

Keep the old create/destroy behaviour reachable during this phase:
`/sandboxes/new` hosts create; destroy stays via the legacy SandboxList
selection UI until Phase 3. Wire `?denied=` toast on the dashboard.

**Accept:** every route in §4.1 renders inside the shell with correct
active-nav state; IdP user sees only Dashboard/Activity/Security/Help nav;
theme toggle persists across reload; mobile (390 px) shows bottom tabs +
sheet; logout works; `npm test` baseline; smoke: create + delete a sandbox
end-to-end through the temporary UI.

## Phase 3 — Dashboard page (§5.1–5.4, 5.7)

**Model: Sonnet.**

**Create:** `app/components/sandbox/{SandboxTable,DeleteSandboxDialog,
SandboxTypeLogo}.tsx`, `app/components/{ApprovalsBell,GatewayRepairButton}.tsx`,
`app/hooks/{queries.ts,inventoryModel.ts,models.ts,useConnectionHealth.ts}`,
`app/lib/{format.ts,permissionAlerts.ts,permissionActions.ts}`,
`app/(shell)/activity/page.tsx` (full version).
**Modify:** `app/(shell)/page.tsx` (real dashboard incl. §5.2 search/filter
row and the §5.1 gateway-repair error state), TopBar (reconnect badge +
ApprovalsBell §5.8).
**Delete:** `app/hooks/useSandboxInventory.ts` (after WizardPanel shim, §6.5).

**Accept:** ≥7 sandboxes fit without scrolling at 1440×900; search narrows
the table as you type and status chips filter correctly; delete works
from the row menu with typed confirmation; recent-activity panel matches
`/activity` head; simulate a failing poll via devtools offline toggle:
table keeps data + "Reconnecting…" appears, recovers on focus;
ApprovalsBell shows pending permission requests and Allow/Deny works from
the popover (trigger a request from inside a sandbox agent, or verify
against a seeded feed); IdP user sees no New sandbox/Restart/Delete controls
and no bell, and their table lists only granted sandboxes.

## Phase 4 — Sandbox detail + launch flow (§5.3, 5.5, 5.6)

**Model: Opus. Operator runs `/code-review ultra` on the pushed branch
before the deploy step.**

**Create:** `app/(shell)/sandboxes/[name]/page.tsx`,
`app/components/sandbox/{SandboxMcpAccess,SandboxPolicyRequests}.tsx`,
`app/lib/launchDashboard.ts`.
**Modify:** `app/launch/dashboard/page.tsx` (staged progress + retry),
create-flow success handler → detail page redirect.
**Delete:** `app/components/SandboxList.tsx`, and `app/components/
SandboxDetails.tsx` if `grep -rn "SandboxDetails" app/` shows no consumers.

**Accept:** detail Overview metric cards are labelled `Host CPU/MEM/DISK`
with the "Controller host resources" caption; all 8 tabs function for
operator on an OpenClaw sandbox (files
upload/download, inference apply, MCP enable/revoke+manifest, policy
grant/reject, backup list, shields status); Hermes sandbox shows Access tab
with HermesRemotePanel and NO Shields tab; `?tab=policy` deep link works;
**launch flow:** click Open dashboard → tab opens instantly with progress →
OpenClaw Control UI loads (test BOTH warm and cold: `ssh` to VPS,
`systemctl restart openshell-controller`, wait for /login 200, then first
click must survive the ~30 s cold probe); delete + recreate same sandbox
name, then Open dashboard again — must NOT show "Auth did not match"
(CLAUDE.md §10 invariant); `npm test` including both dashboard-token tests.

## Phase 4b — Terminal hardening (§12.3, client-only)

**Model: Opus.**

**Create:** `app/hooks/useTerminalConnection.ts` (xterm + socket machinery
extracted from the page), `app/components/terminal/TerminalKeyBar.tsx`,
`tests/terminal-reconnect-check.mjs`,
`tests/terminal-server-ping-tolerance-check.mjs`.
**Modify:** `app/operator-terminal/page.tsx` (auto-reconnect state machine,
keepalive ping, session-ended UX, visualViewport handling, font-size
control, §02-token restyle — the restyle previously slated for Phase 7
happens here). **No changes** to `server.mjs`, `terminal-server.mjs`, or
the terminal API routes.

**Accept:** with a shell open, `systemctl restart openshell-controller` on
the VPS → overlay + auto-reconnect with scrollback intact within 60 s;
devtools offline→online → reconnects on `online` event; tab hidden 5 min →
reconnects on focus; idle shell behind Pangolin stays alive ≥10 min
(keepalive); `exit` shows the green ended state with `Start new session`;
390 px touch emulation: key bar sends Esc/Tab/Ctrl-combos/arrows/^C, prompt
stays visible with soft keyboard open; `npm test` incl. the two new checks;
IdP user terminal path (their one allowlisted write) still works end-to-end.

## Phase 4c — Skills library + capability prominence (§13)

**Model: Sonnet.**

**Create:** `skills/README.md` + `skills/skill-template.md` (seed files —
format rules, no-secrets rule; do NOT invent real recipe content),
`app/api/skills/route.ts`, `app/api/skills/[skillId]/route.ts` (GET-only,
traversal-guarded), `app/(shell)/skills/page.tsx`,
`app/components/skills/SkillsQuickList.tsx`,
`app/components/sandbox/CapabilityChips.tsx`,
`tests/skills-route-check.mjs`, `tests/skills-no-secrets-check.mjs`.
**Modify:** `nav.ts` (+`/skills`, cap `viewSkills`), `auth/me` caps
(+`viewSkills: true` both roles), `SandboxTable` (Capabilities column +
mobile chips), detail Overview (+"Agent capabilities" card),
`/operator-terminal` header (+Skills sheet).

**Accept:** `/skills` lists the template, Copy puts the body (frontmatter
stripped) on the clipboard, View dialog renders; terminal Skills sheet
copies with newlines intact; `MEM`/`CHAT` chips reflect per-sandbox MCP
access and flip after Enable from the Overview card (manifest-sync toast
appears); IdP user sees chips read-only and can read `/skills`; both new
tests pass; `curl /api/skills/../package.json` (encoded variants too)
returns 400.

## Phase 5 — Login + security pages (§7.1, 7.2)

**Model: Sonnet.**

**Modify:** `app/login/page.tsx`, `app/components/AuthShell.tsx`,
`app/forgot-password/page.tsx`, `app/setup-account/*` (FirstRunSetup split),
`app/(shell)/security/page.tsx` (restyled content).

**Accept:** IdP button primary and renders without layout jump; operator
collapsible works; `next=` deep-link + hash-carry still work (test:
logout, visit `/sandboxes/<name>?tab=files`, login → land back there);
first-run path: on a scratch checkout with no password configured,
`/setup-account` shows setup (don't test on the shared BYOVPS — reason
through the code and test locally with `OPENSHELL_CONTROL_PASSWORD` unset);
password rotation smoke test from CLAUDE.md §7 passes.

## Phase 6 — Heavy-panel restyle (visual only)

**Model: Sonnet.**

Restyle in place (markup/classes only — NO logic, state, or fetch changes;
diffs should show className/JSX-wrapper churn only):
`ConfigurationPanel`, `WizardPanel`, `McpConfigurationPanel`,
`InferenceEndpointPanel`, `SandboxInferencePanel`, `SandboxFilesPanel`,
`SandboxArchivePanel`, `ShieldsPanel`, `OpenClawRemotePanel`,
`HermesRemotePanel`, `HelpPanel`, `ActivityPanel` → ui primitives (Card,
Input, Select, Button, Alert, Badge). While inside these panels, apply the
§12.5/§12.6 lifecycle amendments: replace-mode restore confirmation, backup
catalog table (size + relative date), elapsed-time counters on long
backup/restore operations, XHR upload progress bar + client-side 128 MiB
pre-check + drag-and-drop in `SandboxFilesPanel`, the tmux hint copy in
`HelpPanel`, and the §13.1.3 "Core capabilities" grouping in
`McpConfigurationPanel` + `SandboxMcpAccess` (baseline servers `memory` and
`inter-sandbox-chat` first, their `summary` strings verbatim). Then remove
legacy utility classes
(`panel`, `action-button`, `status-chip`, `metric`, `field-control`) and the
legacy CSS-var bridge from `globals.css` once
`grep -rn "action-button\|panel \|status-chip\|field-control\|--background-hex" app/`
is clean. Also add capability gating INSIDE Access-tab panels and flip the
Access tab visibility rule from operator-only to per-control gating (§5.3
table note).

**Accept:** every panel exercised once on BYOVPS (create sandbox via
ConfigurationPanel, quick-deploy wizard dry run, MCP add/remove registry
entry, inference endpoint edit + revert); zero legacy classes left; visual
consistency pass at 390/768/1440 px.

## Phase 7 — Mobile polish + PWA (§08)

**Model: Sonnet.**

**Create:** `app/manifest.ts`, `public/icon-{192,512}.png`.
**Modify:** safe-area paddings, touch-target audit fixes,
`middleware.ts` PUBLIC_PATHS += `/manifest.webmanifest`.
(The `/operator-terminal` restyle moved to Phase 4b.)

**Accept:** Lighthouse (or manual) installable-PWA check passes; iPhone
Safari add-to-home-screen shows icon + standalone; all §10 mobile matrix
rows pass.

## Phase 8 (OPTIONAL) — Operator TOTP (§7.3)

**Model: Opus. Operator runs `/code-review ultra` on the pushed branch
before the deploy step.**

Skip freely. **Accept:** enable → logout → login requires code; wrong code
rate-limited; disable works; `data/operator-totp.json` mode 0600; deleting
the file on the VPS restores password-only login; `tests/totp-login-check.mjs`
passes.

## Final merge

**Model: Opus.**

1. Full §10 regression matrix on BYOVPS (operator + IdP user + mobile).
2. `git checkout gatewaydashboard && git merge --no-ff ui-refresh` (single
   revertable merge, same property as the auth refactor merge `328370a`).
3. Push, deploy `gatewaydashboard`, re-run CLAUDE.md §7 smoke tests.
4. Follow-up commit: update `CLAUDE.md` (§5 conflict table rows for
   `SandboxList.tsx` → point at `SandboxTable`/detail page; §6 architecture
   pointers; §7 baseline if tests were added), refresh
   `docs/upstream-divergence-audit.md` (the UI area is now heavily
   fork-divergent — add a UI section listing `app/(shell)/`,
   `app/components/ui/`, `app/components/sandbox/`, `app/components/shell/`
   as fork-owned), and update the memory file
   `~/.claude/projects/.../memory/` entries that reference the old UI
   structure.
