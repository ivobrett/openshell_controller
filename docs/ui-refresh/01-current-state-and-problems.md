# 01 — Current state, file inventory, and root-cause analysis

## 1. Current architecture (verified 2026-07-07)

- Next.js 15 App Router, React 18, Tailwind 3.4, TypeScript. Custom server
  (`server.mjs`) owns WebSocket upgrades — do not touch.
- The whole UI is effectively **one client page** (`app/page.tsx`, 487 lines)
  that switches between "views" (`sandboxes | settings | help | wizards |
  mcp`) plus two modal "modes" (create / destroy) via `useState`. There is no
  URL for anything except `/login`, `/setup-account`, `/forgot-password`,
  `/operator-terminal`, `/launch/dashboard`, `/swagger`.
- Styling: CSS custom properties in `app/globals.css` (NVIDIA industrial
  theme, `--nvidia-green: #76B900`), utility classes `panel`,
  `action-button`, `status-chip`, `metric`, `field-control`; dark theme is
  default, light theme via `html[data-theme="light"]`, toggled by page state
  (not persisted — theme resets to dark on reload).
- Data fetching: bare `fetch` in `useEffect` + `setInterval` in each
  component. At least 5 independent polling loops run concurrently on the
  main page (inventory 10 s, permissions-per-sandbox 12 s, MCP access 12 s,
  telemetry 5 s, controller nodes on-event).

## 2. Component inventory and current line counts

| File | Lines | What it is | Fate in refresh |
|---|---|---|---|
| `app/page.tsx` | 487 | View-switch mega page | **Replaced** by route-per-page (§04, §05) |
| `app/components/Sidebar.tsx` | 344 | Fixed sidebar + bottom bar <lg; contains controller-node registry UI | **Replaced** by `AppSidebar` + `MobileTabBar`; node-registry UI moves to a topbar node switcher (§04) |
| `app/components/SandboxList.tsx` | 1142 | Sandbox cards grid + PermissionMenu + 8 collapsible DrawerSections hosting all per-sandbox panels | **Split**: table → `SandboxTable`; drawers → sandbox detail page tabs (§05) |
| `app/components/ConfigurationPanel.tsx` | 382 | Create-sandbox form + per-sandbox policy editor (`mode="create" \| "existing"`) | Kept as-is through Phase 5; restyled Phase 6 |
| `app/components/WizardPanel.tsx` | 745 | Quick Deploy / controller-node wizards | Kept; hosted at `/wizards`; restyled Phase 6 |
| `app/components/McpConfigurationPanel.tsx` | 1304 | MCP registry/server management | Kept; hosted at `/mcp`; restyled Phase 6 |
| `app/components/InferenceEndpointPanel.tsx` | 776 | Global inference endpoint config (the current "settings" view) | Kept; hosted at `/inference`; restyled Phase 6 |
| `app/components/SandboxInferencePanel.tsx` | 491 | Per-sandbox inference routes | Kept; detail-page "Inference" tab |
| `app/components/SandboxFilesPanel.tsx` | 362 | Upload/download | Kept; detail-page "Files" tab |
| `app/components/SandboxArchivePanel.tsx` | 314 | Backup/restore | Kept; detail-page "Backup" tab |
| `app/components/OpenClawRemotePanel.tsx` | 320 | Mobile-app gateway pairing + QR | Kept; detail-page "Access" tab |
| `app/components/HermesRemotePanel.tsx` | 174 | Hermes remote desktop expose | Kept; detail-page "Access" tab |
| `app/components/ShieldsPanel.tsx` | 237 | NemoClaw shields up/down (already role-checks via `/api/auth/me`) | Kept; detail-page "Shields" tab |
| `app/components/ActivityPanel.tsx` | 126 | Paginated activity log + Support Bundle link | Reused: compact variant on dashboard, full page at `/activity` |
| `app/components/HelpPanel.tsx` | 363 | Help + telemetry-bar toggle | Kept; `/help` |
| `app/components/SandboxHealthPanel.tsx` | 98 | Health card | Detail-page Overview tab |
| `app/components/SandboxDetails.tsx` | 202 | (legacy detail card) | Check usages; if unused after refactor, delete |
| `app/components/LiveTelemetryBar.tsx` / `CompactTelemetryDisplay` / `TelemetryDisplay` / `SpeedometerGauge` / `CompactGauge` | ~680 | Telemetry displays | Kept; LiveTelemetryBar stays an opt-in top strip |
| `app/components/AuthShell.tsx` | 25 | Centered auth card | Replaced by redesigned `AuthShell` (§07) |
| `app/hooks/useSandboxInventory.ts` | 170 | Inventory poll hook | **Replaced** by `useInventory` TanStack Query hook (§06) |
| `app/login/page.tsx` | 105 | Password-first login | **Redesigned** (§07) |
| `app/setup-account/page.tsx` | 330 | Password mgmt + sandbox-access admin | Moves to `/security` with redirect from `/setup-account` (§07) |
| `app/forgot-password/page.tsx` | 93 | Recovery | Restyled only |
| `app/operator-terminal/page.tsx` | 430 | xterm terminal page | **Untouched** except header restyle in Phase 7 |
| `app/launch/dashboard/page.tsx` | 62 | Async dashboard launcher (already exists!) | **Upgraded** — becomes the primary launch path (§05) |

## 3. Root causes (verified in code)

### P1 — 30 s dead button on "Start OpenClaw Gateway Dashboard"
`SandboxList.tsx:819-837`: the click handler `await fetch('/api/openshell/
dashboard/open?...')` and only calls `window.open(...)` after the response.
That server route runs `probeOpenClawDashboard()` which spins the lazy SSH
tunnel (127.0.0.1:20049 → sandbox 18789), probes the gateway, and can poll
for token liveness — legitimately slow (5–30 s) on cold start. Because
`window.open` happens long after the user gesture, some browsers also
popup-block it. Meanwhile the button shows no busy state.

**Fix direction (no server change):** `window.open('/launch/dashboard?...')`
synchronously in the click handler (still inside the user gesture → never
popup-blocked, instant feedback), and make that page show staged progress
while it calls the same API, then `location.replace(launchUrl)`. §05.6.

### P2 — idle "communication issues"
`app/hooks/useSandboxInventory.ts:112-118`: on ANY rejected poll the hook does
`setSandboxes([])`, `setNemoclaw(null)`, `setError(message)` → the whole
dashboard collapses into the red "Inventory Unavailable" panel until the next
successful poll (or manual REFRESH). Transient causes observed: a single slow
`openshell sandbox list` CLI run, laptop sleep/resume racing the interval,
gateway restart. Additionally `response.json()` on a 401/redirect after
session expiry produces confusing parse errors instead of a login redirect.

**Fix:** §06 — TanStack Query, `placeholderData: keepPreviousData`, retries,
error shown as a non-destructive "reconnecting" badge when cached data
exists, and a central 401 handler that redirects to `/login?next=…`.

### P3 — IdP users see operator controls that 403
`middleware.ts:159-178`: OAuth users get GETs (all sandboxes' data!) and may
POST only to `/api/openshell/terminal/live`, gated per-sandbox by
`isUserAuthorizedForSandbox`. But `/api/auth/me` returns only
`{ operator, configured }` — no email, no role, no allowed-sandbox list — so
the client renders everything. Also note: **inventory is currently NOT
filtered server-side** — an IdP user's browser receives every sandbox's
name/IP/status from `/api/telemetry/real`.

**Fix:** §03 — `/api/auth/me` v2 with role + capabilities + allowedSandboxes;
server-side inventory and activity filtering for OAuth users; UI renders from
capabilities.

### P4/P5/P6 — IA problems (destroy mode, huge cards, activity at top)
All structural consequences of the single-page/view-mode design. Fixed by the
route map in §04 and page specs in §05.

### P7 — login page
`app/login/page.tsx`: password field is primary and autofocused; the IdP link
is a small secondary button that appears only after a client fetch. For the
common user (IdP), this is backwards. §07.

## 4. Server/API surface the new UI consumes (unchanged unless listed in §03)

Read (GET): `/api/telemetry/real` (inventory — gets filtering added in §03),
`/api/telemetry/combined`, `/api/telemetry/live`, `/api/activity` (gets
filtering), `/api/auth/me` (v2 in §03), `/api/auth/login` (oauthLoginUrl
discovery), `/api/sandbox/[id]/permissions`, `/api/sandbox/[id]/health`,
`/api/mcp`, `/api/controller-node/registry`,
`/api/openshell/dashboard/open`, `/api/openshell/terminal/readiness`.

Write (POST, operator-only unless noted): `/api/sandbox/create`,
`/api/sandbox/delete`, `/api/sandbox/[id]/restart`, `…/permissions`,
`…/mcp`, `…/shields`, `…/files/*`, `…/backup`, `…/restore`,
`/api/mcp` (actions), `/api/auth/login|logout|setup|recover` (public),
`/api/openshell/terminal/live` (OAuth-allowed, per-sandbox gated),
`/api/controller-node/registry`.

**Do not add any new OAuth-writable path** to
`OAUTH_WRITE_ALLOWED_PATHS` in `middleware.ts` as part of this refresh.
