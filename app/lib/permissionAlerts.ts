import type { PermissionFeed, NetworkRuleRequest } from "@/app/hooks/models"

type DismissedPermissionAlerts = Record<string, string[]>

const DISMISSED_PERMISSION_ALERTS_STORAGE_KEY = "openshell-control-dismissed-permission-alerts"

function normalizeDismissedPermissionAlerts(value: unknown): DismissedPermissionAlerts {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {}
  return Object.entries(value as Record<string, unknown>).reduce<DismissedPermissionAlerts>(
    (normalized, [sandboxId, chunks]) => {
      if (Array.isArray(chunks)) {
        const ids = chunks.filter((chunk): chunk is string => typeof chunk === "string" && chunk.length > 0)
        if (ids.length > 0) normalized[sandboxId] = Array.from(new Set(ids))
      }
      return normalized
    },
    {},
  )
}

export function loadDismissedPermissionAlerts(): DismissedPermissionAlerts {
  if (typeof window === "undefined") return {}
  try {
    return normalizeDismissedPermissionAlerts(
      JSON.parse(window.localStorage.getItem(DISMISSED_PERMISSION_ALERTS_STORAGE_KEY) || "{}"),
    )
  } catch {
    return {}
  }
}

export function saveDismissedPermissionAlerts(alerts: DismissedPermissionAlerts) {
  if (typeof window === "undefined") return
  window.localStorage.setItem(DISMISSED_PERMISSION_ALERTS_STORAGE_KEY, JSON.stringify(alerts))
}

export function dismissedPermissionSet(
  alerts: DismissedPermissionAlerts,
  sandbox: { id: string; name: string },
): Set<string> {
  return new Set([...(alerts[sandbox.id] || []), ...(alerts[sandbox.name] || [])])
}

export function visiblePendingRequests(
  feed: PermissionFeed | undefined,
  sandbox: { id: string; name: string },
  alerts: DismissedPermissionAlerts,
): NetworkRuleRequest[] {
  const dismissed = dismissedPermissionSet(alerts, sandbox)
  return (feed?.pending || []).filter((request) => !request.chunkId || !dismissed.has(request.chunkId))
}

export function permissionFeedNeedsAttention(
  feed: PermissionFeed | undefined,
  sandbox: { id: string; name: string },
  alerts: DismissedPermissionAlerts,
): boolean {
  const latestStatus = feed?.latest?.status || ""
  const latestChunkId = feed?.latest?.chunkId || ""
  const dismissed = dismissedPermissionSet(alerts, sandbox)
  return Boolean(
    visiblePendingRequests(feed, sandbox, alerts).length > 0 ||
      (/pending|fail|error|unavailable/i.test(latestStatus) &&
        (!latestChunkId || !dismissed.has(latestChunkId))),
  )
}
