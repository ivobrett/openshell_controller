import { toast } from "sonner"
import { queryClient } from "@/app/lib/queryClient"
import { apiFetch, ApiError } from "@/app/lib/apiFetch"
import type { SandboxInventoryItem } from "@/app/hooks/inventoryModel"

// §12.4 — restart is recovery-first server-side. POST /api/sandbox/[id]/restart
// tries `nemoclaw <sandbox> recover` (90 s) then falls back to restarting the
// in-sandbox OpenClaw runtime (45 s). It never deletes the pod. When the
// sandbox isn't Ready it returns 409 with restarted:false + a note — that is a
// warning, NOT a success.

export type RestartResult = {
  restarted: boolean
  restartMode?: "nemoclaw-recover" | "openclaw-runtime"
  note?: string
}

/**
 * Restart a sandbox runtime with the §12.4 loading→result toast lifecycle.
 * Shared by the SandboxTable row menu and the sandbox detail header.
 */
export async function restartRuntime(sandbox: SandboxInventoryItem): Promise<void> {
  const toastId = toast.loading(
    `Restarting runtime for ${sandbox.name}… (can take up to 2 minutes)`,
  )
  try {
    const data = await apiFetch<RestartResult>(
      `/api/sandbox/${encodeURIComponent(sandbox.id)}/restart`,
      { method: "POST", signal: AbortSignal.timeout(180_000) },
    )
    // A 2xx response always means restarted:true (the not-Ready case is 409).
    const title =
      data.restartMode === "nemoclaw-recover"
        ? `Recovered ${sandbox.name} via NemoClaw`
        : `Restarted OpenClaw runtime in ${sandbox.name}`
    toast.success(title, { id: toastId, description: data.note })
    queryClient.invalidateQueries({ queryKey: ["inventory"] })
  } catch (error) {
    if (error instanceof ApiError && error.status === 409) {
      const body = error.body as RestartResult | null
      toast.warning(body?.note || `Restart skipped for ${sandbox.name}.`, { id: toastId })
      return
    }
    toast.error(error instanceof Error ? error.message : "Failed to restart runtime", {
      id: toastId,
    })
    throw error
  }
}
