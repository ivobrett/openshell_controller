import { queryClient } from "@/app/lib/queryClient"
import { apiFetch } from "@/app/lib/apiFetch"
import type { SandboxInventoryItem } from "@/app/hooks/inventoryModel"

export async function resolvePermissionRequest(
  sandbox: SandboxInventoryItem,
  action: "approve" | "reject",
  chunkId: string,
): Promise<void> {
  if (!chunkId) return
  await apiFetch(`/api/sandbox/${encodeURIComponent(sandbox.id)}/permissions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action, chunkId }),
  })
  queryClient.invalidateQueries({ queryKey: ["permissions"] })
}
