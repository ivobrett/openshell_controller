# 05 — Page specs: dashboard, sandbox table, sandbox detail, delete, launch

## 5.1 Fleet dashboard (`/`)

Wireframe (≥xl; below xl the activity column stacks under the table):

```
┌ PageHeader: "Sandboxes"  [availability line]      [+ New sandbox] ┐
├────────────────────────────────────────────────────────────────────┤
│ ┌stat──────┐ ┌stat──────┐ ┌stat──────┐ ┌stat──────────┐           │
│ │ Total  7 │ │ ● Running│ │ ⚠ Needs  │ │ Gateway      │           │
│ │          │ │        5 │ │ action 2 │ │ ● available  │           │
│ └──────────┘ └──────────┘ └──────────┘ └──────────────┘           │
├───────────────────────────────────────────────┬────────────────────┤
│ SandboxTable (Card, flush)                    │ Recent activity    │
│ ┌───────────────────────────────────────────┐ │ ┌───────────────┐  │
│ │ ▓ name        LED     agent   alerts  ⋮  │ │ │ 5 latest      │  │
│ │ …one 44px row per sandbox…                │ │ │ entries       │  │
│ └───────────────────────────────────────────┘ │ │ [View all →]  │  │
│                                               │ └───────────────┘  │
└───────────────────────────────────────────────┴────────────────────┘
```

- **PageHeader**: title "Sandboxes", description `"{running} running · {total}
  total · gateway {available|not detected}"` (from inventory). Action button
  `+ New sandbox` (`Button` default variant = green) — rendered only with
  `can('createSandbox')`.
- **Stat cards** (`grid grid-cols-2 gap-3 lg:grid-cols-4`, each a `Card` with
  `p-4`): Total, Running (green LED), Needs action (count of pending
  permission requests — amber; clicking it opens the Approvals popover,
  §5.8), Gateway (LED from `nemoclaw.available`; hidden for
  role="user" since nemoclaw detail is filtered — render only when
  `me.role === "operator"`, and let the grid be 3-up for users).
- **Recent activity** (right column, `xl:w-80`): compact list of 5 latest
  entries — mono message truncated, relative time (`"3m ago"` — write a
  20-line `relativeTime()` util in `app/lib/format.ts`, no dep), status dot.
  Footer link `View all` → `/activity`. Uses the same `["activity"]` query as
  the activity page (§06). Rendered for `can('viewActivity')`.
- The **Support Bundle** button moves to `/activity`'s PageHeader (it's an
  operator diagnostic, `can('manageSecurity')` guard is wrong — use
  `me.role === "operator"`).
- `LiveTelemetryBar` (when enabled) renders above the stat cards, unchanged.

**Empty state** (no sandboxes): centered `Box` icon, "No sandboxes yet",
sub-line "Create your first sandbox to get started", and for operators a
`+ New sandbox` button; for users "Ask your operator to grant you access to a
sandbox."

**Error state**: only when there is NO cached inventory (first load fails):
`Alert variant="destructive"` with the error text and a Retry button. When
cached data exists, the table stays and the TopBar shows "Reconnecting…"
(§06). This is the P2 fix — never blank a populated table.

**Gateway repair (operator only, in the error state):** the known
catastrophic failure is the Docker-driver gateway dying (`transport error /
connection refused`; all sandboxes exit — see CLAUDE.md §3). The full error
panel gains a second button for operators: `Attempt gateway repair` →
`POST /api/openshell/gateway/repair` (empty JSON body) via `apiFetch`, with
a 120 s `AbortSignal.timeout` (the repair CLI can run ~90 s). Busy label
`Repairing gateway…`. On success: toast `Gateway repair completed`,
invalidate `["inventory"]`. On failure: render the response's
`stdout`/`stderr`/`error` fields in a mono `<pre>` inside the panel plus the
line "If repair fails repeatedly, see the gateway recovery runbook." The
endpoint is real, currently unused by any UI, and already operator-only
(POST + not on the OAuth allowlist). Component:
`app/components/GatewayRepairButton.tsx`.

## 5.2 SandboxTable (`app/components/sandbox/SandboxTable.tsx`)

**Filter row** (above the table, `flex gap-2 items-center mb-3`; Docker
Desktop paradigm):
- `Input` with a `Search` icon prefix, placeholder `Search sandboxes`
  (`w-64`, full-width on `<md`). Client-side filter on
  `name.includes(q) || agent.includes(q)`, case-insensitive. Plain
  `useState`, no persistence, no debounce needed at this scale.
- Status chips (toggle group of `Badge`-styled buttons):
  `All (n) / Running (n) / Stopped (n) / Attention (n)` — Attention =
  sandboxes with visible pending permission requests. Exactly one active at
  a time; default `All`. Filtered-to-empty state: "No sandboxes match" +
  a `Clear filters` text button.

Desktop (`hidden md:block`): shadcn `Table` inside a flush Card.

| Column | Content | Width |
|---|---|---|
| Name | `SandboxTypeLogo` (h-6 w-6 version) + mono name + `default` outline badge if `isDefault` | flexible, truncate |
| Status | `StatusLed` (dot + label) | 120px |
| Agent | "OpenClaw" / "Hermes" / "Custom" (`displaySandboxAgent`) | 100px |
| Capabilities | `CapabilityChips` — `MEM`/`CHAT` LED chips for the baseline MCP servers + `+n` for others, links to `?tab=mcp` (§13.1) | 140px, hidden lg- |
| Alerts | pending-permission badge: amber `Badge` "{n} pending" that opens the row's Policy tab (link to `/sandboxes/<name>?tab=policy`); green dot when none; `title` from `feed.latest.status` | 110px |
| Attach | mono `sshHostAlias ?? ip`, `text-muted-foreground` | 160px, hidden lg- |
| Actions | see below | 96px right-aligned |

Row click (anywhere non-interactive) → `router.push('/sandboxes/' +
encodeURIComponent(name))`. Row hover `hover:bg-accent`. Namespace and
Sandbox ID move to the detail page Overview tab (info not dropped).

**Actions cell**: two inline icon buttons + overflow menu.
- `PanelsTopLeft` icon button "Open dashboard" — OpenClaw sandboxes only,
  `can('openDashboard')`; runs the §5.6 launch flow.
  For Hermes sandboxes the slot instead shows `MonitorSmartphone`
  "Open Hermes dashboard" opening
  `/api/sandbox/<name>/hermes/dashboard/proxy/` in a new tab.
- `SquareTerminal` icon button "Terminal" — `can('openTerminal')`; opens
  `buildOperatorTerminalRoute({ sandboxId: name, dashboardSessionId })` in a
  new tab (identical to today's behaviour).
- `MoreHorizontal` → `DropdownMenu` (operator-only items auto-hidden):
  - `Restart runtime` (`can('restartSandbox')`) — recovery-first semantics,
    long-running toast, `restartMode`-aware result: full spec in §12.4.
  - `Copy terminal link` / `Copy dashboard link` — same URLs as today's
    `copyShareableLink` (`/operator-terminal?sandboxId=…`,
    `/launch/dashboard?sandboxId=…`, hermes proxy path). Visible to users
    too (links are access-controlled server-side).
  - separator
  - `Delete…` (`can('deleteSandbox')`), red text → §5.4 dialog.

Mobile (`md:hidden`): stacked compact cards (`p-3`): row 1 logo + mono name +
StatusLed(dot only); row 2 agent + `CapabilityChips` + alerts badge; whole
card tappable → detail;
a trailing `MoreHorizontal` button with the same menu. NO per-card action
button row — actions live in the menu and detail page. Cards are `space-y-2`,
~64px each: 10 sandboxes fit one phone screen (P5 fixed).

Data: the table consumes `useInventory()` + `usePermissionFeeds(names)`
(§06). The per-sandbox `PermissionMenu` popover from the old cards is
retired; pending requests are approved on the detail page Policy tab (the
Alerts badge deep-links there).

## 5.3 Sandbox detail (`/sandboxes/[name]`)

The page is a client component reading `params.name` (decode it). Find the
sandbox in `useInventory()` data. States: loading → skeleton; not found after
a successful fetch → "Sandbox not found or you don't have access" empty state
with a back link (this also covers unauthorized names that middleware let
through for operators only — users get redirected by middleware first).

```
┌ ← Sandboxes (breadcrumb link)                                      ┐
│ [logo] sandbox-name   ● RUNNING   OpenClaw   [default]             │
│ mono: id · namespace · attach target                               │
│ [Open dashboard] [Terminal] [Restart] [⋮ menu: copy links, delete] │
├─────────────────────────────────────────────────────────────────────┤
│ Tabs: Overview | Access | Files | Inference | MCP | Policy(●n) |   │
│       Backup | Shields                                             │
│ ┌─────────────────────────────────────────────────────────────────┐│
│ │ active tab content                                              ││
│ └─────────────────────────────────────────────────────────────────┘│
```

Header buttons follow the same capability + agent rules as table actions.
`Restart runtime` shows inline spinner state while in flight (`disabled` +
`RotateCcw` spinning, up to ~2 min) and toasts the `restartMode`-aware
result per §12.4.

Tabs (shadcn `Tabs`, controlled by `?tab=` search param via
`useSearchParams` + `router.replace` so deep links work; default `overview`).
Tab visibility matrix — a tab renders only if ALL its conditions hold:

| Tab | Content (existing component, embedded) | Conditions |
|---|---|---|
| Overview | Telemetry stat cards titled **`Host CPU` / `Host MEM` / `Host DISK` / `Updated`** (the data is `/api/telemetry/combined` = host-level, not per-sandbox; the current UI mislabels this — fix the labels, and add a one-line caption "Controller host resources". Do NOT use `/api/telemetry/sandbox` — it returns synthesized data). Port from `SandboxList` operations drawer, 5 s poll via `useSandboxTelemetry`. Plus the **"Agent capabilities" card** (allowed MCP servers with summaries; operator gets one-click `Enable` for `memory` / `inter-sandbox-chat` + `Manage MCP access →` and `Setup skills →` links — full spec §13.1.2), `SandboxHealthPanel`, and a "Details" card listing id, namespace, host alias, agent, default flag | always |
| Access | OpenClaw: `OpenClawRemotePanel` (mobile-app pairing/QR). Hermes: `HermesRemotePanel` (remote desktop). Plus a "Share links" card with the copy-link buttons | OpenClaw or Hermes agent; panels themselves are operator-managed → tab visible to all, mutating buttons inside stay capability-gated in Phase 6 restyle; until then gate the whole tab `me.role === "operator"` |
| Files | `SandboxFilesPanel sandbox={sandbox} embedded showHeader={false}` | `can('manageFiles')` |
| Inference | `SandboxInferencePanel sandbox={sandbox} embedded showHeader={false}` | `can('manageInference')` |
| MCP | The per-sandbox MCP access UI currently inlined in `SandboxList.tsx:981-1054` — extract verbatim into `app/components/sandbox/SandboxMcpAccess.tsx` (props: `sandbox`) including `syncMcpManifest`, enable/disable/revoke and the `/api/mcp` 12 s query | `can('manageMcp')` |
| Policy | Pending network-permission request cards (Grant / Reject / Dismiss — port from `SandboxList.tsx:1063-1123` into `app/components/sandbox/SandboxPolicyRequests.tsx`) + `ConfigurationPanel sandboxId={id} mode="existing" embedded showHeader={false}`. Tab label shows amber count badge when pending > 0 | `can('approvePermissions')` |
| Backup | `SandboxArchivePanel sandbox={sandbox} onRestoreComplete={refetch}` | `can('backupRestore')` |
| Shields | `ShieldsPanel sandboxName={name}` — OpenClaw only (Hermes exclusion comment in `SandboxList.tsx:939-945` MUST be preserved verbatim next to the condition) | OpenClaw agent && `can('manageShields')` |

For `role === "user"` the visible set is exactly: **Overview** (+ header
Terminal/Open dashboard buttons). That is the honest IdP experience.

The dismissed-permission-alerts localStorage mechanism
(`openshell-control-dismissed-permission-alerts`, helpers in
`SandboxList.tsx:255-297`) moves to `app/lib/permissionAlerts.ts` unchanged
and is used by both the table Alerts column and the Policy tab.

## 5.4 Delete flow (P4 fix)

`app/components/sandbox/DeleteSandboxDialog.tsx` — shadcn `AlertDialog`:

- Title: `Delete sandbox <name>?` Body: "This permanently destroys the
  sandbox and its data. This cannot be undone."
- **Backup nudge** (only while the sandbox is running): a bordered row
  `Download a backup of /sandbox first` with a `Download backup` outline
  button → the existing `GET /api/sandbox/<id>/backup?path=/sandbox`
  download. Non-blocking; see §12.5.1.
- Below: an `Input` labelled
  `Type the sandbox name to confirm` — the destructive button stays disabled
  until the input equals the name exactly. (Typed confirmation replaces the
  old two-step destroy-mode; it is the only guard, so it must be exact-match,
  case-sensitive.)
- Confirm button: `Button variant="destructive"`, label `Delete sandbox`,
  in-flight label `Deleting…`.
- On confirm: POST `/api/sandbox/delete` body
  `{ sandboxName, agent: sandbox.agent || 'openclaw' }` (identical to
  today's `confirmDelete`, `app/page.tsx:139-166`). Then poll
  `refetchUntilGone` (port `refreshUntilSandboxGone` logic onto the
  TanStack refetch, 10 × 1.5 s), toast success/timeout message, and if the
  user is on that sandbox's detail page `router.push('/')`.
- Errors render INSIDE the dialog (mono, destructive alert) — do not close on
  failure; also keep the raw stdout/stderr join exactly as today (it carries
  CLI diagnostics).

## 5.5 Create flow

`/sandboxes/new` renders `PageHeader "Create sandbox"` +
`ConfigurationPanel sandboxId="new-sandbox" mode="create"
onCreateSuccess={handle}`. `handle` ports `handleCreateSuccess`
(`app/page.tsx:129-137`): toast "Creating <id>…", poll
`refetchUntilVisible` (8 × 1.5 s), then `router.push('/sandboxes/' + name)`
with a success toast, or a warning toast if inventory hasn't reported it.
The old inline `<ActivityPanel />` under the create form is dropped (activity
has its own page; creation progress is toast + the panel's own output).

## 5.6 Launch flow — the 30-second fix (P1)

**Client-only change. Do not touch `/api/openshell/dashboard/open`.**

New helper `app/lib/launchDashboard.ts`:

```ts
export function launchOpenClawDashboard(sandboxName: string) {
  // Synchronous window.open inside the click gesture: instant feedback and
  // never popup-blocked. The launch page does the slow probe itself.
  window.open(
    `/launch/dashboard?sandboxId=${encodeURIComponent(sandboxName)}`,
    "_blank",
    "noopener,noreferrer",
  )
}
```

Every "Open dashboard" control calls this. The old await-then-open handler in
`SandboxList.tsx:819-837` is deleted with the component.

**Upgrade `app/launch/dashboard/page.tsx`** (keep the Suspense wrapper and
query-param contract — `sandboxId`, `instanceId` — the page is also a shared
copy-link target):

1. Visual: centered Card, sandbox name in mono, a staged progress list where
   each stage is a row with LED-style bullet (pending = muted, active =
   spinning `RefreshCw`, done = green check):
   - `Contacting controller`
   - `Starting gateway tunnel` (activated 1.5 s after fetch starts)
   - `Verifying dashboard token` (activated 8 s in, if still waiting)
   - `Opening dashboard`
   The stages are timer-driven theatre over one long fetch — that is fine;
   their purpose is showing liveness. Below: mono hint
   `First open after idle can take up to 30 seconds.`
2. Logic: same single `fetch('/api/openshell/dashboard/open?…', { cache:
   'no-store' })`, but wrapped with `AbortSignal.timeout(45_000)`. On
   success `window.location.replace(launchUrl || proxiedUrl || dashboardUrl)`
   (exact fallback order preserved from the current page). On `!ok`/timeout:
   show the error (`data.error` or "Timed out after 45 s") in a destructive
   Alert + two buttons: `Retry` (re-runs the fetch, resets stages) and
   `Close tab` (`window.close()`).
3. On 401 (session expired in the new tab): redirect to
   `/login?next=` + current URL — `apiFetch` (§06) does this automatically;
   use it here.

Result: click → tab opens in <100 ms with live progress → tab becomes the
dashboard when ready. Same server work, honest UX.

## 5.7 `/activity` page

`PageHeader "Activity"` (+ `Support Bundle` button, operator only, href
`/api/support-bundle`) + the existing `ActivityPanel` list/pagination
restyled with ui primitives (Card + Table optional — keep the current
row-card markup if simpler, just swap classes to token colors). Add a
`sandboxName` filter `Select` (options from inventory names + "All") that
filters client-side. IdP users see server-filtered entries (§3.3).

## 5.8 ApprovalsBell (`app/components/ApprovalsBell.tsx`)

The global human-in-the-loop surface for the agent fleet (see §11.1-A).
Rendered in the TopBar for `can('approvePermissions')` only.

- **Trigger:** icon `Bell` (lucide), `h-10 w-10` ghost button. When total
  visible pending requests > 0: amber count badge (`absolute -top-0.5
  -right-0.5`, `min-w-4 h-4 rounded-full bg-warning text-black text-[10px]
  font-mono`) and `aria-label="{n} pending approvals"`. Zero pending: no
  badge, popover still opens.
- **Data:** `usePermissionFeeds(sandboxes)` (§6.3 — the same shared query
  the table uses; no extra polling) + `permissionAlerts.ts` dismissal
  filtering, aggregated across sandboxes.
- **Popover** (`w-96`, `max-h-[70vh]` scroll-area): one row per pending
  request — sandbox name (mono, bold), endpoint/rule (mono, truncated,
  `title` full), confidence badge if present, and inline `Allow` (primary
  xs) / `Deny` (outline xs) buttons calling the same
  `resolvePermissionRequest` POST as the Policy tab (extract that helper
  into `app/lib/permissionActions.ts` so bell + Policy tab share it; it must
  invalidate the `["permissions"…]` query on success). Row footer link
  `Review in <sandbox> policy →` → `/sandboxes/<name>?tab=policy`.
- Empty state: `ShieldQuestion` icon + "No pending approvals. Agent network
  requests will appear here."
- In-flight: disable that row's buttons, spinner on the clicked one. Result
  toast (`Approved <endpoint> for <sandbox>` / error passthrough).
- The dashboard "Needs action" stat card is a button that opens this same
  popover (lift open-state to a tiny zustand store or React context in the
  shell — decision: React context `ApprovalsUiContext` in `AppShell`, no new
  dep).

## 5.9 Copy: exact strings

- Buttons: `New sandbox`, `Open dashboard`, `Terminal`, `Restart`,
  `Delete sandbox`, `Retry`, `View all`.
- Toasts: success `Sandbox <name> deleted`, `Restart requested for <name>`,
  `Dashboard link copied`, error passthrough of server `error` field.
- Reconnecting badge: `Reconnecting…` (exactly, with ellipsis char).
- Empty inventory: `No sandboxes yet`.
- Denied redirect toast: `You don't have access to sandbox <name>`.
No exclamation marks anywhere. Sentence case for all UI copy; mono uppercase
reserved for machine states (RUNNING, PENDING…).
