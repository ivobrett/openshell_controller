# 02 — Design system (shadcn/ui, NVIDIA industrial theme)

The look is modelled on `hhftechnology/crowdsec_manager` (shadcn/ui: Radix
primitives + class-variance-authority + Tailwind tokens, lucide icons,
sonner toasts, TanStack Query) but keeps this product's identity: **dark-first
NVIDIA industrial** — near-black surfaces, `#76B900` green as the single
accent, monospace for machine data, LED-style status indicators. The signature
element of the refresh is the **status LED language**: every sandbox, gateway,
and connection state is a small glowing dot + mono label, consistent
everywhere (table rows, detail header, topbar connection state).

## 2.1 Dependencies (Phase 0)

Run exactly:

```bash
npm install class-variance-authority clsx tailwind-merge tailwindcss-animate \
  lucide-react @radix-ui/react-dialog @radix-ui/react-alert-dialog \
  @radix-ui/react-dropdown-menu @radix-ui/react-tabs @radix-ui/react-tooltip \
  @radix-ui/react-select @radix-ui/react-switch @radix-ui/react-label \
  @radix-ui/react-separator @radix-ui/react-scroll-area \
  @radix-ui/react-collapsible @radix-ui/react-slot \
  @tanstack/react-query sonner
```

No react-router (Next routes), no axios (keep `fetch`), no recharts (existing
gauges suffice), no new fonts (system stack — avoids build-time font
downloads on the VPS). `zustand` stays (already a dep) but new code should
not need it.

## 2.2 shadcn/ui vendoring

Do NOT run `npx shadcn init` (it will fight the existing Tailwind 3 config
and Next 15 setup). Instead vendor components manually into
`app/components/ui/` using the shadcn v2 "default" style sources with the
import path `@/app/lib/utils`. Create these files (standard shadcn contents,
Tailwind-3-compatible — copy from the crowdsec_manager repo's
`web/src/components/ui/` versions, which are already Tailwind 3 + CVA and
proven, adjusting only the `@/lib/utils` import to `@/app/lib/utils` and
removing any `react-router` imports):

```
app/components/ui/button.tsx        app/components/ui/badge.tsx
app/components/ui/card.tsx          app/components/ui/dialog.tsx
app/components/ui/alert-dialog.tsx  app/components/ui/dropdown-menu.tsx
app/components/ui/tabs.tsx          app/components/ui/tooltip.tsx
app/components/ui/select.tsx        app/components/ui/switch.tsx
app/components/ui/input.tsx         app/components/ui/label.tsx
app/components/ui/textarea.tsx      app/components/ui/separator.tsx
app/components/ui/table.tsx         app/components/ui/scroll-area.tsx
app/components/ui/collapsible.tsx   app/components/ui/skeleton.tsx
app/components/ui/alert.tsx         app/components/ui/sheet.tsx
```

(`sheet.tsx` is the Radix-dialog side drawer — used for mobile nav.)

Also add `app/components/ui/popover.tsx` (`npm install
@radix-ui/react-popover` alongside the §2.1 deps) — required by the
Approvals bell (§5.9).

**Vendoring source:** copy from `crowdsec_manager/web/src/components/ui/`
(standard shadcn tokens). Do NOT copy from their `mobile/src/components/ui/`
— the mobile app uses a different token dialect (`bg-canvas`, `text-ink`,
`border-hairline`) that won't resolve against our theme.

Create `app/lib/utils.ts`:

```ts
import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}
```

## 2.3 Theme tokens

Replace the `:root` /`html[data-theme="light"]` blocks in `app/globals.css`
with the following. **Keep every existing legacy variable and utility class
below the new block unchanged** (legacy panels still use them until Phase 6);
the legacy vars are re-expressed in terms of the new tokens so both systems
stay in sync.

```css
@tailwind base;
@tailwind components;
@tailwind utilities;

@layer base {
  :root {
    color-scheme: dark;
    /* shadcn tokens — NVIDIA industrial dark (default) */
    --background: 0 0% 4%;            /* #0a0a0a */
    --foreground: 0 0% 90%;           /* #e5e5e5 */
    --card: 0 0% 8%;                  /* #141414 */
    --card-foreground: 0 0% 90%;
    --popover: 0 0% 9%;
    --popover-foreground: 0 0% 90%;
    --primary: 82 100% 36%;           /* #76B900 NVIDIA green */
    --primary-foreground: 0 0% 4%;    /* black text on green */
    --secondary: 0 0% 12%;            /* #1e1e1e */
    --secondary-foreground: 0 0% 90%;
    --muted: 0 0% 10%;                /* #1a1a1a */
    --muted-foreground: 220 9% 65%;   /* #9ca3af */
    --accent: 82 40% 12%;             /* deep green-tinted hover surface */
    --accent-foreground: 82 100% 60%;
    --destructive: 0 72% 51%;         /* #dc2626 */
    --destructive-foreground: 0 0% 100%;
    --border: 0 0% 16%;               /* #2a2a2a */
    --input: 0 0% 16%;
    --ring: 82 100% 36%;
    --radius: 0.375rem;
    --success: 82 100% 36%;
    --warning: 43 96% 56%;            /* amber-400 */
    --info: 217 91% 60%;
    --sidebar: 0 0% 7%;               /* #121212 */
    --sidebar-foreground: 0 0% 90%;
    --sidebar-border: 0 0% 16%;
  }

  html[data-theme="light"] {
    color-scheme: light;
    --background: 0 0% 96%;
    --foreground: 0 0% 9%;
    --card: 0 0% 100%;
    --card-foreground: 0 0% 9%;
    --popover: 0 0% 100%;
    --popover-foreground: 0 0% 9%;
    --primary: 82 100% 28%;           /* #5A8D00 darker green for contrast */
    --primary-foreground: 0 0% 100%;
    --secondary: 0 0% 90%;
    --secondary-foreground: 0 0% 9%;
    --muted: 0 0% 90%;
    --muted-foreground: 0 0% 32%;
    --accent: 82 40% 90%;
    --accent-foreground: 82 100% 22%;
    --destructive: 0 72% 45%;
    --destructive-foreground: 0 0% 100%;
    --border: 0 0% 83%;
    --input: 0 0% 83%;
    --ring: 82 100% 28%;
    --sidebar: 0 0% 93%;
    --sidebar-foreground: 0 0% 9%;
    --sidebar-border: 0 0% 83%;
  }
}
```

Then immediately after, keep a **legacy bridge block** so old classes keep
rendering (values identical to today's):

```css
:root {
  --nvidia-green: #76B900;
  --nvidia-green-hover: #5d9600;
  --nvidia-green-dark: #5A8D00;
  --nvidia-green-dim: rgba(118, 185, 0, 0.2);
  --background-secondary: #121212;
  --background-tertiary: #1a1a1a;
  --background-panel: #1e1e1e;
  --foreground-dim: #9ca3af;
  --border-subtle: #2a2a2a;
  --border-medium: #3a3a3a;
  --status-running: #76B900;
  --status-running-bg: rgba(118, 185, 0, 0.15);
  --status-pending: #9ca3af;
  --status-pending-bg: rgba(156, 163, 175, 0.15);
  --status-stopped: #dc2626;
  --status-stopped-bg: rgba(220, 38, 38, 0.15);
  --metric-bg: #161616;
  --metric-border: #2a2a2a;
  --surface-raised: rgba(30, 30, 30, 0.86);
  --surface-hover: rgba(118, 185, 0, 0.08);
  --shadow-soft: 0 18px 60px rgba(0, 0, 0, 0.34);
  --shadow-glow: 0 0 0 1px rgba(118, 185, 0, 0.22), 0 18px 60px rgba(118, 185, 0, 0.12);
}
html[data-theme="light"] { /* keep today's light overrides verbatim */ }
```

**Pitfall:** legacy code uses `--background`/`--foreground` as HEX inside
`var()` (e.g. `bg-[var(--background)]`). The new tokens are HSL triples
(`0 0% 4%`) which will NOT work in `var()`-as-color positions. Therefore the
legacy bridge MUST also define hex fallbacks under DIFFERENT names is not
possible — instead: define the shadcn tokens under the names above, and set
the legacy `--background`/`--foreground` HEX values on `body` scope via two
extra vars:

```css
body {
  --background-hex: #0a0a0a;
  --foreground-hex: #e5e5e5;
}
html[data-theme="light"] body {
  --background-hex: #f5f5f5;
  --foreground-hex: #171717;
}
```

and in Phase 0 run a project-wide replace of `var(--background)` →
`var(--background-hex)` and `var(--foreground)` → `var(--foreground-hex)` in
all `.tsx` files under `app/` (mechanical, ~40 occurrences; do NOT touch
`app/api/**` server files — the bootstrap script in
`app/api/openshell/dashboard/proxy/shared.ts` contains no such vars, verify
with grep). The body background grid stays:

```css
body {
  margin: 0;
  color: hsl(var(--foreground));
  background:
    linear-gradient(rgba(118, 185, 0, 0.045) 1px, transparent 1px),
    linear-gradient(90deg, rgba(118, 185, 0, 0.035) 1px, transparent 1px),
    linear-gradient(180deg, var(--background-secondary), var(--background-hex) 20rem);
  background-size: 56px 56px, 56px 56px, auto;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto,
    "Helvetica Neue", Arial, sans-serif;
  -webkit-font-smoothing: antialiased;
}
```

## 2.4 tailwind.config.ts (replace `theme.extend` entirely)

```ts
import type { Config } from "tailwindcss"

const config: Config = {
  darkMode: ["selector", 'html:not([data-theme="light"])'],
  content: [
    "./pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        border: "hsl(var(--border))",
        input: "hsl(var(--input))",
        ring: "hsl(var(--ring))",
        background: "hsl(var(--background))",
        foreground: "hsl(var(--foreground))",
        primary: { DEFAULT: "hsl(var(--primary))", foreground: "hsl(var(--primary-foreground))" },
        secondary: { DEFAULT: "hsl(var(--secondary))", foreground: "hsl(var(--secondary-foreground))" },
        destructive: { DEFAULT: "hsl(var(--destructive))", foreground: "hsl(var(--destructive-foreground))" },
        muted: { DEFAULT: "hsl(var(--muted))", foreground: "hsl(var(--muted-foreground))" },
        accent: { DEFAULT: "hsl(var(--accent))", foreground: "hsl(var(--accent-foreground))" },
        popover: { DEFAULT: "hsl(var(--popover))", foreground: "hsl(var(--popover-foreground))" },
        card: { DEFAULT: "hsl(var(--card))", foreground: "hsl(var(--card-foreground))" },
        success: "hsl(var(--success))",
        warning: "hsl(var(--warning))",
        info: "hsl(var(--info))",
        sidebar: { DEFAULT: "hsl(var(--sidebar))", foreground: "hsl(var(--sidebar-foreground))", border: "hsl(var(--sidebar-border))" },
      },
      borderRadius: {
        lg: "var(--radius)",
        md: "calc(var(--radius) - 2px)",
        sm: "calc(var(--radius) - 4px)",
      },
      fontFamily: {
        mono: ["ui-monospace", "SFMono-Regular", "Menlo", "Monaco", "Consolas", "monospace"],
      },
    },
  },
  plugins: [require("tailwindcss-animate")],
}
export default config
```

Note `darkMode` uses a selector so shadcn's `dark:` utilities line up with
the existing `data-theme` mechanism. The theme toggle (Phase 2) writes
`document.documentElement.dataset.theme` AND persists to
`localStorage['openshell-control.theme']`, restoring it in a tiny inline
script in `app/layout.tsx` `<head>` to avoid a flash:

```html
<script dangerouslySetInnerHTML={{ __html:
  `try{var t=localStorage.getItem('openshell-control.theme');if(t)document.documentElement.dataset.theme=t}catch(e){}`
}} />
```

## 2.5 Typography & density rules

- Body/UI: system sans, `text-sm` (14 px) default; page titles `text-lg
  font-semibold tracking-tight` — **sentence case, not uppercase**. The
  current all-caps-everywhere treatment is retired except for:
- Machine data (sandbox names, IDs, IPs, tokens, statuses): `font-mono
  text-xs` or `text-sm`. Status labels stay uppercase mono (`RUNNING`) — this
  is the industrial identity.
- Section eyebrows: `text-[11px] uppercase tracking-wider
  text-muted-foreground` — used sparingly (one per card max).
- Table rows: 44 px height desktop (`h-11`), 48 px touch targets on mobile.
- Cards: `p-4` (not `p-8`); page gutter `p-4 md:p-6`; max content width
  `max-w-7xl mx-auto`.

## 2.6 Iconography

lucide-react, 16 px (`className="h-4 w-4"`) in buttons/nav, 20 px in empty
states. Fixed assignments (do not improvise):

| Concept | Icon |
|---|---|
| Dashboard/fleet | `LayoutDashboard` |
| Sandbox | `Box` |
| Create | `Plus` |
| Delete | `Trash2` |
| Terminal | `SquareTerminal` |
| OpenClaw gateway dashboard | `PanelsTopLeft` |
| Hermes dashboard | `MonitorSmartphone` |
| Restart | `RotateCcw` |
| Files | `FolderUp` |
| Inference | `Cpu` |
| MCP | `Plug` |
| Policy/permissions | `ShieldQuestion` |
| Shields | `Shield` |
| Backup/restore | `Archive` |
| Activity | `ScrollText` |
| Wizards | `Sparkles` |
| Skills library | `BookOpen` |
| Security | `KeyRound` |
| Help | `CircleHelp` |
| Sign out | `LogOut` |
| More/row menu | `MoreHorizontal` |
| External link | `ExternalLink` |
| Copy link | `Link` / `Check` when copied |
| Reconnecting | `RefreshCw` (spinning) |
| Node/host | `Server` |

Agent logos stay: `/sandbox-logos/openclaw.svg`, `/sandbox-logos/hermes.png`
(reuse `SandboxTypeLogo`, extracted to `app/components/sandbox/SandboxTypeLogo.tsx`).

## 2.7 New shared primitives (exact specs)

Create `app/components/StatusLed.tsx` — THE signature component:

```tsx
import { cn } from "@/app/lib/utils"

export type LedStatus = "running" | "pending" | "stopped" | "error" | "unknown"

const LED: Record<LedStatus, { dot: string; text: string; label: string }> = {
  running: { dot: "bg-primary shadow-[0_0_6px_2px_rgba(118,185,0,0.55)]", text: "text-primary", label: "RUNNING" },
  pending: { dot: "bg-warning shadow-[0_0_6px_2px_rgba(251,191,36,0.45)] animate-pulse", text: "text-warning", label: "PENDING" },
  stopped: { dot: "bg-destructive", text: "text-destructive", label: "STOPPED" },
  error:   { dot: "bg-destructive animate-pulse", text: "text-destructive", label: "ERROR" },
  unknown: { dot: "bg-muted-foreground", text: "text-muted-foreground", label: "UNKNOWN" },
}

export function StatusLed({ status, showLabel = true, className }: {
  status: LedStatus; showLabel?: boolean; className?: string
}) {
  const s = LED[status] ?? LED.unknown
  return (
    <span className={cn("inline-flex items-center gap-1.5", className)}>
      <span aria-hidden className={cn("h-2 w-2 rounded-full", s.dot)} />
      {showLabel && <span className={cn("font-mono text-[11px] uppercase tracking-wider", s.text)}>{s.label}</span>}
    </span>
  )
}
```

Create `app/components/PageHeader.tsx`:

```tsx
export function PageHeader({ title, description, actions }: {
  title: string; description?: string; actions?: React.ReactNode
}) {
  return (
    <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
      <div>
        <h1 className="text-lg font-semibold tracking-tight">{title}</h1>
        {description && <p className="mt-1 text-sm text-muted-foreground">{description}</p>}
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  )
}
```

Toasts: mount `<Toaster richColors position="bottom-right" theme="dark" />`
from `sonner` in `app/layout.tsx` (theme wired to the theme state in Phase 2);
all transient action feedback (`dashboardMessage`, `permissionMessage`,
`mcpMessage`, `lifecycleMessage` strings that today render as inline gray
boxes) becomes `toast.success(...)` / `toast.error(...)`. Persistent states
(pending permission requests, error panels with retry) stay inline.

## 2.8 Motion & a11y floor

- Transitions: `transition-colors duration-150` only. No translate-on-hover
  (remove `hover:-translate-y-0.5`). One exception: the LED pulse.
- `prefers-reduced-motion`: add `motion-reduce:animate-none` wherever
  `animate-pulse`/`animate-spin` is used.
- Every interactive element keeps a visible focus ring
  (`focus-visible:ring-2 focus-visible:ring-ring` — shadcn defaults do this).
- All icon-only buttons get `aria-label`. Dialogs get `DialogTitle`.
- Color contrast: muted-foreground on background is ≥ 4.5:1 in both themes
  (values above chosen for that; do not lighten further).
