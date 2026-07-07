# 06 — Data layer: TanStack Query, resilient polling, session handling

Fixes P2 (idle errors). Replaces ad-hoc `fetch`+`setInterval` loops with one
query client and typed hooks. Rules baked in: **never discard previously
rendered data because one poll failed**, retry with backoff, pause polling in
hidden tabs, and turn 401s into a login redirect instead of JSON parse
errors.

## 6.1 `app/lib/apiFetch.ts`

```ts
export class ApiError extends Error {
  status: number
  body: unknown
  constructor(status: number, message: string, body?: unknown) {
    super(message)
    this.status = status
    this.body = body
  }
}

export async function apiFetch<T>(input: string, init?: RequestInit): Promise<T> {
  const response = await fetch(input, { cache: "no-store", ...init })

  if (response.status === 401) {
    // Session expired. Bounce through login and come back to where we were.
    if (typeof window !== "undefined" && !window.location.pathname.startsWith("/login")) {
      const next = encodeURIComponent(
        window.location.pathname + window.location.search,
      )
      window.location.href = `/login?next=${next}`
    }
    throw new ApiError(401, "Session expired")
  }

  let body: any = null
  try {
    body = await response.json()
  } catch {
    // Non-JSON response (proxy error page, gateway hiccup). Surface status.
    if (!response.ok) throw new ApiError(response.status, `Request failed (${response.status})`)
    throw new ApiError(500, "Unexpected non-JSON response")
  }

  if (!response.ok) {
    throw new ApiError(response.status, body?.error || `Request failed (${response.status})`, body)
  }
  return body as T
}
```

All new hooks use `apiFetch`. Legacy panels keep their own `fetch` calls
until Phase 6 (they already handle their own errors inline).

## 6.2 `app/lib/queryClient.ts`

```ts
import { QueryClient } from "@tanstack/react-query"
import { ApiError } from "./apiFetch"

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 5_000,
      // Retry transient failures, never auth failures.
      retry: (failureCount, error) => {
        if (error instanceof ApiError && (error.status === 401 || error.status === 403)) return false
        return failureCount < 2
      },
      retryDelay: (attempt) => Math.min(1_000 * 2 ** attempt, 8_000),
      refetchOnWindowFocus: true,     // returning from idle refreshes silently
      refetchIntervalInBackground: false, // hidden tabs stop polling
    },
  },
})
```

`refetchOnWindowFocus: true` + `refetchIntervalInBackground: false` is the
core idle fix: an idle/locked machine stops hammering the controller (and
stops accumulating failures), and the first focus refetches immediately.

## 6.3 Hooks — `app/hooks/queries.ts`

Port the normalization functions (`normalizeStatus`, `mapSandboxSummary`,
`mapPodItem`, `normalizeFromResponse`) and the `SandboxInventoryItem` /
`NemoClawSummary` types VERBATIM from `app/hooks/useSandboxInventory.ts`
into `app/hooks/inventoryModel.ts` (pure, no React), then:

```ts
"use client"
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query"
import { apiFetch } from "@/app/lib/apiFetch"
import { normalizeFromResponse, type InventoryResponse, type SandboxInventoryItem } from "./inventoryModel"

export function useInventory() {
  const query = useQuery({
    queryKey: ["inventory"],
    queryFn: () => apiFetch<InventoryResponse>("/api/telemetry/real"),
    refetchInterval: 15_000,
    placeholderData: keepPreviousData,   // ← the P2 fix: stale data beats no data
    select: (data) => ({
      sandboxes: normalizeFromResponse(data),
      nemoclaw: data?.nemoclaw ?? null,
    }),
  })
  return {
    sandboxes: query.data?.sandboxes ?? [],
    nemoclaw: query.data?.nemoclaw ?? null,
    isLoading: query.isLoading,                 // true only with no data at all
    isReconnecting: query.isError && !!query.data, // has data, poll failing
    error: query.isError && !query.data ? (query.error as Error).message : null,
    refetch: query.refetch,
  }
}

export function useActivity(limit = 100) {
  return useQuery({
    queryKey: ["activity", limit],
    queryFn: () => apiFetch<{ entries: ActivityEntry[] }>(`/api/activity?limit=${limit}`),
    refetchInterval: 30_000,
    placeholderData: keepPreviousData,
    select: (d) => d.entries ?? [],
  })
}

export function useSandboxTelemetry(enabled: boolean) {
  return useQuery({
    queryKey: ["telemetry", "combined"],
    queryFn: () => apiFetch<TelemetryData>("/api/telemetry/combined"),
    refetchInterval: 5_000,
    enabled,
    placeholderData: keepPreviousData,
  })
}

export function usePermissionFeeds(sandboxes: SandboxInventoryItem[]) {
  return useQuery({
    queryKey: ["permissions", sandboxes.map((s) => s.id).sort().join(",")],
    enabled: sandboxes.length > 0,
    refetchInterval: 15_000,
    placeholderData: keepPreviousData,
    queryFn: async () => {
      const entries = await Promise.all(sandboxes.map(async (sandbox) => {
        try {
          const data = await apiFetch<{ feed: PermissionFeed }>(
            `/api/sandbox/${encodeURIComponent(sandbox.id)}/permissions`)
          return [sandbox.id, data.feed] as const
        } catch (error) {
          return [sandbox.id, { rejectedCount: 1, latest: { status: "Unavailable",
            error: error instanceof Error ? error.message : "unavailable" } }] as const
        }
      }))
      return Object.fromEntries(entries) as Record<string, PermissionFeed>
    },
  })
}

export function useMcpServers() {
  return useQuery({
    queryKey: ["mcp", "servers"],
    queryFn: () => apiFetch<{ servers: McpServerAccess[] }>("/api/mcp"),
    refetchInterval: 30_000,
    placeholderData: keepPreviousData,
    select: (d) => (Array.isArray(d.servers) ? d.servers : []),
  })
}
```

Type imports for `PermissionFeed`, `McpServerAccess`, `ActivityEntry`,
`TelemetryData`: move these type declarations out of `SandboxList.tsx` /
`ActivityPanel.tsx` into `app/hooks/models.ts` and import from there
(they are currently private to the components).

Interval decisions (deliberate, don't tune further): inventory 15 s (was
10 s — with focus-refetch this is plenty), permissions 15 s (was 12), MCP
30 s (was 12 — access lists change rarely), activity 30 s, telemetry 5 s
(unchanged, only while a detail page is open). Net effect: fewer concurrent
timers, no polling from hidden tabs.

**Note for IdP users:** `usePermissionFeeds` calls per-sandbox GETs, which
middleware 403s for non-authorized sandboxes — but the inventory is already
server-filtered (§3.3) so users only poll their own sandboxes; per-sandbox
permissions GET is allowed (read-only) for authorized ones. Guard the hook
call with `can('approvePermissions') ? sandboxes : []` anyway so user
sessions don't poll feeds they can't act on.

After any mutation (delete/create/restart), invalidate:
`queryClient.invalidateQueries({ queryKey: ["inventory"] })` and
`["activity"]`.

## 6.4 Connection health badge

`app/hooks/useConnectionHealth.ts`:

```ts
export function useConnectionHealth() {
  const { isReconnecting } = useInventory() // shares the cached query, no extra fetch
  return { reconnecting: isReconnecting }
}
```

TopBar renders (per §4.3): spinning `RefreshCw` + `Reconnecting…` when true.
That replaces today's full-page "Inventory Unavailable" during transient
failures. The destructive full error panel appears ONLY when
`useInventory().error` is non-null (no data ever loaded).

## 6.5 Deleting `useSandboxInventory.ts`

Phase 3 removes the last consumer (`app/page.tsx`). `WizardPanel` receives
`sandboxes` + `onInventoryRefresh` as props — pass the new hook's values with
a compatibility shim: `onInventoryRefresh={async () => { const r = await
refetch(); return r.data?.sandboxes ?? [] }}` (WizardPanel expects the
refreshed array back — check its prop type
`onInventoryRefresh: () => Promise<SandboxInventoryItem[]>` and keep it
satisfied). Then delete `app/hooks/useSandboxInventory.ts` and verify
`grep -rn "useSandboxInventory" app/` returns nothing.
