"use client"
import { keepPreviousData, useQuery } from "@tanstack/react-query"
import { apiFetch } from "@/app/lib/apiFetch"
import { normalizeFromResponse, type InventoryResponse, type SandboxInventoryItem } from "./inventoryModel"
import type { ActivityEntry, PermissionFeed, McpServerAccess, TelemetryData } from "./models"

export function useInventory() {
  const query = useQuery({
    queryKey: ["inventory"],
    queryFn: () => apiFetch<InventoryResponse>("/api/telemetry/real"),
    refetchInterval: 15_000,
    placeholderData: keepPreviousData,
    select: (data) => ({
      sandboxes: normalizeFromResponse(data),
      nemoclaw: data?.nemoclaw ?? null,
    }),
  })
  return {
    sandboxes: query.data?.sandboxes ?? [],
    nemoclaw: query.data?.nemoclaw ?? null,
    isLoading: query.isLoading,
    isReconnecting: query.isError && !!query.data,
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
      const entries = await Promise.all(
        sandboxes.map(async (sandbox) => {
          try {
            const data = await apiFetch<{ feed: PermissionFeed }>(
              `/api/sandbox/${encodeURIComponent(sandbox.id)}/permissions`,
            )
            return [sandbox.id, data.feed] as const
          } catch (error) {
            return [
              sandbox.id,
              {
                rejectedCount: 1,
                latest: {
                  status: "Unavailable",
                  error: error instanceof Error ? error.message : "unavailable",
                },
              },
            ] as const
          }
        }),
      )
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
