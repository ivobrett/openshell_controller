# 03 — Role-aware UI: capabilities API, server-side filtering, middleware

Server enforcement already exists (middleware blocks OAuth writes; per-sandbox
gating on URL-identifiable resources). What's missing: (a) the client has no
way to know who it is, (b) OAuth users still *receive* the full inventory and
activity feed. This section fixes both. **This is Phase 1 and must land
before any UI phase**, so the UI phases can be built against the real
contract.

## 3.1 `/api/auth/me` v2 — the capability contract

Rewrite `app/api/auth/me/route.ts`:

```ts
import { NextRequest, NextResponse } from "next/server"
import { resolveAuthContext, isAuthConfigured } from "@/app/lib/auth/context"
import { getSandboxAccessMap } from "@/app/lib/auth/sandboxAccessStore"

export type Capabilities = {
  createSandbox: boolean
  deleteSandbox: boolean
  restartSandbox: boolean
  openTerminal: boolean
  openDashboard: boolean
  manageFiles: boolean
  manageInference: boolean
  manageMcp: boolean
  approvePermissions: boolean
  manageShields: boolean
  backupRestore: boolean
  manageSecurity: boolean
  manageNodes: boolean
  viewActivity: boolean
  viewWizards: boolean
  viewSkills: boolean
}

const OPERATOR_CAPS: Capabilities = {
  createSandbox: true, deleteSandbox: true, restartSandbox: true,
  openTerminal: true, openDashboard: true, manageFiles: true,
  manageInference: true, manageMcp: true, approvePermissions: true,
  manageShields: true, backupRestore: true, manageSecurity: true,
  manageNodes: true, viewActivity: true, viewWizards: true,
  viewSkills: true,
}

// OAuth/IdP users: read + terminal + dashboard on THEIR sandboxes only.
// Mirrors middleware.ts: writes are 403 except OAUTH_WRITE_ALLOWED_PATHS
// (/api/openshell/terminal/live); dashboard/open is a GET gated per-sandbox.
const OAUTH_CAPS: Capabilities = {
  createSandbox: false, deleteSandbox: false, restartSandbox: false,
  openTerminal: true, openDashboard: true, manageFiles: false,
  manageInference: false, manageMcp: false, approvePermissions: false,
  manageShields: false, backupRestore: false, manageSecurity: false,
  manageNodes: false, viewActivity: true, viewWizards: false,
  viewSkills: true,   // setup prompts are read-only and secret-free (§13.2)
}

function allowedSandboxesForEmail(email: string): string[] {
  const map = getSandboxAccessMap() // Map<sandboxName, Set<email>>
  const allowed: string[] = []
  for (const [sandboxName, emails] of map.entries()) {
    if (emails.has(email.toLowerCase())) allowed.push(sandboxName)
  }
  return allowed.sort()
}

export async function GET(request: NextRequest) {
  const configured = isAuthConfigured()
  const ctx = await resolveAuthContext(request)

  if (ctx.kind === "operator" || ctx.kind === "disabled") {
    return NextResponse.json({
      role: "operator",
      operator: true,               // legacy field — keep, ShieldsPanel + setup-account read it
      configured,
      email: null,
      capabilities: OPERATOR_CAPS,
      allowedSandboxes: "all",
    })
  }

  if (ctx.kind === "oauth") {
    return NextResponse.json({
      role: "user",
      operator: false,
      configured,
      email: ctx.email,
      capabilities: OAUTH_CAPS,
      allowedSandboxes: allowedSandboxesForEmail(ctx.email),
    })
  }

  return NextResponse.json({
    role: "anonymous",
    operator: false,
    configured,
    email: null,
    capabilities: null,
    allowedSandboxes: [],
  })
}
```

Notes:
- `/api/auth/me` is already in `PUBLIC_PATHS` — anonymous callers get
  `role:"anonymous"` and nothing sensitive (no sandbox names).
- Keep `operator` boolean for backward compatibility;
  `app/components/ShieldsPanel.tsx:82` and `app/setup-account/page.tsx`
  read it. The old callers keep working unchanged.
- `resolveAuthContext` expects a `NextRequest` — this route already receives
  one. Do NOT import from `controlAuth.ts` here; use `@/app/lib/auth/context`.

## 3.2 Client: `AuthProvider` + `useAuth()`

Create `app/components/providers/AuthProvider.tsx`:

```tsx
"use client"
import { createContext, useContext } from "react"
import { useQuery } from "@tanstack/react-query"
import { apiFetch } from "@/app/lib/apiFetch"
import type { Capabilities } from "@/app/api/auth/me/route"

export type AuthMe = {
  role: "operator" | "user" | "anonymous"
  operator: boolean
  configured: boolean
  email: string | null
  capabilities: Capabilities | null
  allowedSandboxes: "all" | string[]
}

const FALLBACK: AuthMe = {
  role: "anonymous", operator: false, configured: true,
  email: null, capabilities: null, allowedSandboxes: [],
}

const AuthContext = createContext<{ me: AuthMe; isLoading: boolean }>({ me: FALLBACK, isLoading: true })

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const { data, isLoading } = useQuery({
    queryKey: ["auth", "me"],
    queryFn: () => apiFetch<AuthMe>("/api/auth/me"),
    staleTime: 60_000,
    refetchOnWindowFocus: true,
  })
  return (
    <AuthContext.Provider value={{ me: data ?? FALLBACK, isLoading }}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth() {
  return useContext(AuthContext)
}

/** Convenience: `can('deleteSandbox')` — false while loading or anonymous. */
export function useCan() {
  const { me } = useAuth()
  return (cap: keyof Capabilities) => Boolean(me.capabilities?.[cap])
}
```

Rendering rule for every gated control (apply consistently):
- **Capability false → element is NOT rendered.** No disabled ghost buttons
  for things a user can never do (that's the current bad experience).
- **Capability true but precondition unmet** (e.g. no sandbox selected) →
  render disabled with a tooltip explaining the precondition.
- While `isLoading`, render skeletons, not the operator layout.

## 3.3 Server-side inventory filtering (OAuth users)

`/api/telemetry/real` currently returns every sandbox to any authenticated
user. Add filtering so IdP users only receive sandboxes they're authorized
for (defense in depth + stops name/IP disclosure).

Create `app/lib/auth/filterInventory.mjs` (plain .mjs so a test can import it
without TS tooling, matching the repo's `policy.mjs` pattern):

```js
// Filters an inventory payload for an OAuth user. `allowed` is a Set of
// sandbox names. Matches on sandbox name OR id (the UI and access store key
// by name; ids can equal names for docker-driver sandboxes).
export function filterInventoryForUser(payload, allowed) {
  const out = { ...payload }
  if (Array.isArray(out.sandboxes)) {
    out.sandboxes = out.sandboxes.filter(
      (s) => allowed.has(s?.name) || allowed.has(s?.id),
    )
  }
  if (out.pods?.items) {
    out.pods = {
      ...out.pods,
      items: out.pods.items.filter((pod) => {
        const labels = pod?.metadata?.labels || {}
        return (
          allowed.has(labels["nemoclaw.ai/sandbox-name"]) ||
          allowed.has(labels["nemoclaw.ai/sandbox-id"]) ||
          allowed.has(pod?.metadata?.name)
        )
      }),
    }
  }
  if (out.nemoclaw) {
    // Reduce host-level gateway detail for non-operators: keep availability,
    // drop service/summary lines and default names not in the allowed set.
    out.nemoclaw = {
      ...out.nemoclaw,
      defaultSandboxNames: (out.nemoclaw.defaultSandboxNames || []).filter((n) => allowed.has(n)),
      serviceLines: [],
      summaryLines: [],
    }
  }
  return out
}
```

In `app/api/telemetry/real/route.ts`, at the point where the final JSON
payload is assembled (locate the `NextResponse.json(...)` that returns
`sandboxes`/`pods`/`nemoclaw` — read the file first; do not blind-patch):

```ts
import { isOperator, oauthEmail } from "@/app/lib/auth/context"
import { getSandboxAccessMap } from "@/app/lib/auth/sandboxAccessStore"
import { filterInventoryForUser } from "@/app/lib/auth/filterInventory.mjs"

// ...after building `payload`, before returning:
if (!(await isOperator(request))) {
  const email = await oauthEmail(request)
  const allowed = new Set<string>()
  if (email) {
    const map = getSandboxAccessMap()
    for (const [name, emails] of map.entries()) {
      if (emails.has(email.toLowerCase())) allowed.add(name)
    }
  }
  payload = filterInventoryForUser(payload, allowed)
}
```

The route handler must therefore receive the `NextRequest` (check its current
signature; add the parameter if it's a zero-arg `GET()`).

Apply the same pattern to **`/api/activity`** (`app/api/activity/route.ts`):
operator sees all entries; OAuth users see only entries whose `sandboxName`
is in their allowed set (entries with no `sandboxName` are operator-only).
The route currently takes `Request` — switch to `NextRequest` so cookies are
readable via the same helpers.

And to **`/api/telemetry/combined`** if it leaks per-host data: read that
route; if it returns host-level CPU/mem only (no sandbox names), leave it —
IdP users seeing host CPU % is acceptable and it powers the detail page.

## 3.4 Middleware: gate the new page routes

The refresh introduces `/sandboxes/<name>` **page** URLs. Extend
`extractSandboxIdFromUrl` in `app/lib/auth/policy.mjs` (add BEFORE the
searchParams fallback):

```js
// UI detail pages: /sandboxes/<name>[/...]. `new` is the create page, not a
// sandbox name.
if (typeof pathname === 'string' && pathname.startsWith('/sandboxes/')) {
  const id = pathname.split('/')[2]
  if (id && id !== 'new') return decodeURIComponent(id)
}
```

Because middleware already calls `extractSandboxIdFromUrl` for OAuth users
and 403s unauthorized page routes with a plain-text response
(`middleware.ts:170-175`), no middleware change is needed beyond this policy
function — but improve the page-route rejection to redirect to `/` with a
flash instead of a bare 403 body: in `middleware.ts`, in the oauth branch,
replace the non-API 403 with:

```ts
const deniedUrl = new URL("/", baseUrl)
deniedUrl.searchParams.set("denied", sandboxId)
return withSecurityHeaders(NextResponse.redirect(deniedUrl))
```

The dashboard page reads `?denied=` once and shows
`toast.error("You don't have access to sandbox <name>")`, then strips the
query param via `router.replace('/')`.

Operator-only PAGES (`/sandboxes/new`, `/mcp`, `/inference`, `/wizards`,
`/security` write sections): GETs are allowed through middleware for OAuth
users (harmless — pages render from capabilities and show a "not available
for your role" empty state; all mutating APIs behind them are already 403).
Do NOT try to block these GETs in middleware; keep the middleware diff
minimal.

## 3.5 Login redirect propagation

`apiFetch` (§06) redirects to `/login?next=<current-path>` on 401. Verify the
login page still honors `next` (it does — `app/login/page.tsx:14`), and that
middleware still bounces authenticated users off `/login` (it does).

## 3.6 Tests for this phase (details in §10)

- `tests/auth-me-capabilities-check.mjs` — source-text assertions: route file
  contains `allowedSandboxes`, `role`, keeps legacy `operator:` field; OAUTH
  caps object has `createSandbox: false`, `deleteSandbox: false`,
  `manageShields: false`.
- `tests/inventory-filter-check.mjs` — imports `filterInventory.mjs`
  directly, feeds a fixture payload with 3 sandboxes (sandbox summary shape
  AND pods shape), asserts a user allowed `["alpha"]` receives exactly alpha,
  empty `serviceLines`, and no `beta`/`gamma` strings anywhere in
  `JSON.stringify` of the result.
- `tests/sandbox-page-gating-check.mjs` — imports `policy.mjs`, asserts
  `extractSandboxIdFromUrl('/sandboxes/alpha', new URLSearchParams())`
  returns `alpha`, `/sandboxes/new` returns `null`, and existing API
  patterns still return their previous values (regression guard for the
  three existing branches).
