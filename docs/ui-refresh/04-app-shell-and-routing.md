# 04 — App shell and routing

## 4.1 Route map (final)

| Route | Page | Access (UI) | Notes |
|---|---|---|---|
| `/` | Fleet dashboard | operator + user | Stats, sandbox table, recent activity |
| `/sandboxes/[name]` | Sandbox detail (tabs) | operator + user (own sandboxes) | Gated in middleware via §3.4 |
| `/sandboxes/new` | Create sandbox | operator | Hosts `ConfigurationPanel mode="create"` |
| `/activity` | Full activity log | operator + user (filtered) | Reuses `ActivityPanel` |
| `/skills` | Skills library (read-only setup prompts) | operator + user | §13.2; served from the repo's `skills/` dir |
| `/inference` | Global inference settings | operator | Was the "settings" view; hosts `InferenceEndpointPanel` |
| `/mcp` | MCP configuration | operator | Hosts `McpConfigurationPanel` |
| `/wizards` | Quick Deploy wizards | operator | Hosts `WizardPanel` |
| `/security` | Password + sandbox access + (2FA) | operator (users see password-locked notice) | Content of current `/setup-account` |
| `/help` | Help | all authed | Hosts `HelpPanel` |
| `/login` | Redesigned login | public | §07 |
| `/forgot-password` | Recovery | public | restyle only |
| `/setup-account` | → permanent redirect to `/security` | — | `redirect()` in a server component; URL is linked from older docs |
| `/operator-terminal` | Terminal (unchanged) | existing behaviour | untouched until Phase 7 header restyle |
| `/launch/dashboard` | Dashboard launcher | existing behaviour | upgraded in §5.6 |
| `/swagger` | API docs | unchanged | leave alone |

Sandbox URLs use the **sandbox name** (`sandbox.name`), not the internal id
— names are what the access store keys on and what all per-sandbox APIs
accept. Encode with `encodeURIComponent` when building links.

## 4.2 `app/layout.tsx`

Wrap children in providers and mount the toaster (server component stays a
server component; providers are a client subtree):

```tsx
import "./globals.css"
import { Providers } from "./components/providers/Providers"

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html:
          `try{var t=localStorage.getItem('openshell-control.theme');if(t)document.documentElement.dataset.theme=t}catch(e){}` }} />
        <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
      </head>
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  )
}
```

(Preserve whatever metadata export the current layout has.)

`app/components/providers/Providers.tsx`:

```tsx
"use client"
import { QueryClientProvider } from "@tanstack/react-query"
import { Toaster } from "sonner"
import { queryClient } from "@/app/lib/queryClient"
import { AuthProvider } from "./AuthProvider"

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        {children}
        <Toaster richColors position="bottom-right" />
      </AuthProvider>
    </QueryClientProvider>
  )
}
```

## 4.3 Shell layout

Create a **route group** `app/(shell)/` and move all authenticated pages into
it so they share one layout, while `/login`, `/forgot-password`,
`/operator-terminal`, `/launch/dashboard` stay bare:

```
app/(shell)/layout.tsx        ← AppShell (sidebar + topbar + content)
app/(shell)/page.tsx          ← dashboard (moved from app/page.tsx)
app/(shell)/sandboxes/[name]/page.tsx
app/(shell)/sandboxes/new/page.tsx
app/(shell)/activity/page.tsx
app/(shell)/inference/page.tsx
app/(shell)/mcp/page.tsx
app/(shell)/wizards/page.tsx
app/(shell)/security/page.tsx
app/(shell)/help/page.tsx
```

`app/(shell)/layout.tsx`:

```tsx
import { AppShell } from "@/app/components/shell/AppShell"
export default function ShellLayout({ children }: { children: React.ReactNode }) {
  return <AppShell>{children}</AppShell>
}
```

### AppShell structure (`app/components/shell/AppShell.tsx`, client)

```
┌──────────────────────────────────────────────────────────┐
│ ≥lg: sidebar 240px fixed left │ TopBar (h-14, sticky)    │
│                               │──────────────────────────│
│  AppSidebar                   │  <main> max-w-7xl mx-auto│
│                               │   p-4 md:p-6             │
│                               │   {children}             │
├──────────────────────────────────────────────────────────┤
│ <lg: no sidebar; MobileTabBar fixed bottom (h-16 +       │
│ safe-area-inset-bottom); TopBar keeps hamburger → Sheet  │
│ with the full nav for secondary items                    │
└──────────────────────────────────────────────────────────┘
```

Main content: `lg:pl-60` (sidebar width), `pb-20 lg:pb-6` (tab bar
clearance), `pt-14` under sticky topbar.

### Nav config — single source of truth

`app/components/shell/nav.ts`:

```ts
import type { Capabilities } from "@/app/api/auth/me/route"
import {
  LayoutDashboard, Plus, ScrollText, BookOpen, Cpu, Plug, Sparkles, KeyRound, CircleHelp,
} from "lucide-react"

export type NavItem = {
  href: string
  label: string
  icon: React.ComponentType<{ className?: string }>
  cap?: keyof Capabilities   // undefined = visible to all authed roles
  mobileTab?: boolean        // appears in the bottom tab bar
}

export const NAV_ITEMS: NavItem[] = [
  { href: "/",          label: "Dashboard",      icon: LayoutDashboard, mobileTab: true },
  { href: "/sandboxes/new", label: "New sandbox", icon: Plus, cap: "createSandbox" },
  { href: "/activity",  label: "Activity",       icon: ScrollText, cap: "viewActivity", mobileTab: true },
  { href: "/skills",    label: "Skills",         icon: BookOpen, cap: "viewSkills" },
  { href: "/inference", label: "Inference",      icon: Cpu,    cap: "manageInference" },
  { href: "/mcp",       label: "MCP",            icon: Plug,   cap: "manageMcp" },
  { href: "/wizards",   label: "Wizards",        icon: Sparkles, cap: "viewWizards" },
  { href: "/security",  label: "Security",       icon: KeyRound },
  { href: "/help",      label: "Help",           icon: CircleHelp, mobileTab: true },
]

export function visibleNavItems(caps: Capabilities | null): NavItem[] {
  return NAV_ITEMS.filter((item) => !item.cap || Boolean(caps?.[item.cap]))
}
```

Mobile tab bar shows `mobileTab: true` items + a "More" tab (`Menu` icon)
opening the `Sheet` with the remaining visible items and Sign out.

### AppSidebar (`app/components/shell/AppSidebar.tsx`, client)

- Header: product mark (existing green cube SVG from `Sidebar.tsx:145-148`)
  + "OpenShell Control" + a **node switcher** underneath (see below).
- Nav list from `visibleNavItems(me.capabilities)`; active state =
  `usePathname()` exact match for `/`, prefix match otherwise; active style
  `bg-primary text-primary-foreground`, inactive
  `text-muted-foreground hover:bg-secondary hover:text-foreground`. Items are
  Next `<Link>` (no more onClick view switching).
- Footer: user identity block — mono email for IdP users or an
  `OPERATOR` badge (`Badge variant="outline"` with green text) — plus
  theme toggle button (Sun/Moon) and Sign out button. Sign out: `POST
  /api/auth/logout` then `window.location.href = "/login"` (same as today).

The old sidebar's **Create/Destroy/Terminal buttons are gone**: create is a
nav item (operator only), destroy lives on sandbox rows/detail (§05), and the
operator terminal button moves to the sandbox row/detail actions (it always
required a selected sandbox anyway).

### Node switcher

Port the controller-node registry UI out of `Sidebar.tsx:53-215` unchanged in
behaviour: a compact `Select` under the sidebar header showing
`node.name — node.host`, persisting to
`localStorage["openshell-control-selected-node"]`, refreshing on the
`controller-nodes-changed` window event, with the rename input inside a small
`Collapsible`. Render it ONLY when `me.capabilities?.manageNodes` (operator);
IdP users don't see node infrastructure. Component:
`app/components/shell/NodeSwitcher.tsx`.

### TopBar (`app/components/shell/TopBar.tsx`, client)

Left: hamburger (`<lg` only, opens nav Sheet) + page breadcrumb (derived from
pathname: `Dashboard`, `Sandboxes / <name>`, etc. — a simple switch, no
library). Right, in order:
1. **Approvals bell** — `ApprovalsBell` (§5.8), operator only
   (`can('approvePermissions')`). Badge = total pending permission requests
   across all sandboxes; popover with inline Allow/Deny. This is the
   human-in-the-loop surface for the agent fleet — it must be visible on
   every page, not just the dashboard.
2. **Connection badge** — the §06 `useConnectionHealth()` state: hidden when
   healthy, `RefreshCw` spinning + "Reconnecting…" (amber, mono, text-xs)
   when the inventory query is erroring but cached data exists.
3. `LiveTelemetryBar` toggle state stays as-is (the bar itself renders under
   the TopBar when enabled — preserve the
   `openshell-control.telemetry-bar-enabled` localStorage key and the
   HelpPanel toggle that controls it).
4. Theme toggle (duplicated from sidebar footer on `<lg` where the sidebar is
   hidden).

## 4.4 Migration of `app/page.tsx` state

| Old state (app/page.tsx) | New home |
|---|---|
| `activeView` | URL (route per view) |
| `isCreateMode` | `/sandboxes/new` route |
| `isDestroyMode` + `deletingSandboxId` + `showDeleteConfirm` | `DeleteSandboxDialog` on table row / detail page (§5.4) |
| `dashboardSession.selectedSandboxId` | URL param `/sandboxes/[name]`. Keep writing `updateDashboardSessionSelection` when navigating to a detail page so `buildOperatorTerminalRoute` and terminal deep-links keep working (read `app/lib/dashboardSession.ts` before wiring — its sessionId must continue to flow to terminal links) |
| `theme` | `ThemeProvider`-less: small `useTheme()` hook (`app/lib/useTheme.ts`) reading/writing `document.documentElement.dataset.theme` + localStorage |
| `telemetryBarEnabled` | unchanged key, read in `AppShell` |
| `lifecycleMessage` | sonner toasts + per-flow inline status (§05) |

Delete `app/components/Sidebar.tsx` and `app/page.tsx`'s view-switch code
once the new shell renders all routes (Phase 2 acceptance criteria include
`grep -rn "isDestroyMode" app/ | wc -l` → only `SandboxList` remnants slated
for Phase 3 deletion).
