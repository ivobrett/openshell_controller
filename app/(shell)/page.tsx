"use client"

import { useEffect, useMemo, useState, Suspense } from "react"
import { useSearchParams, useRouter } from "next/navigation"
import { toast } from "sonner"
import SandboxList from "@/app/components/SandboxList"
import ActivityPanel from "@/app/components/ActivityPanel"
import LiveTelemetryBar from "@/app/components/LiveTelemetryBar"
import { useSandboxInventory } from "@/app/hooks/useSandboxInventory"
import {
  createHydrationSafeDashboardSessionState,
  buildOperatorTerminalRoute,
  loadDashboardSessionState,
  persistDashboardSessionState,
  updateDashboardSessionSelection,
} from "@/app/lib/dashboardSession"

const TELEMETRY_BAR_ENABLED_KEY = "openshell-control.telemetry-bar-enabled"

function DeniedToast() {
  const searchParams = useSearchParams()
  const router = useRouter()
  useEffect(() => {
    const denied = searchParams.get("denied")
    if (denied) {
      toast.error(`You don't have access to sandbox ${denied}`)
      router.replace("/")
    }
  }, [searchParams, router])
  return null
}

export default function DashboardPage() {
  const [dashboardSession, setDashboardSession] = useState(() =>
    createHydrationSafeDashboardSessionState(),
  )
  const [isDestroyMode, setIsDestroyMode] = useState(false)
  const [deletingSandboxId, setDeletingSandboxId] = useState<string | null>(null)
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)
  const [lifecycleMessage, setLifecycleMessage] = useState<string | null>(null)
  const [deleteInProgress, setDeleteInProgress] = useState(false)
  const [telemetryBarEnabled, setTelemetryBarEnabled] = useState(false)

  const { sandboxes, nemoclaw, loading, error, refresh } = useSandboxInventory({ enabled: true })

  useEffect(() => {
    setDashboardSession(loadDashboardSessionState())
    setTelemetryBarEnabled(window.localStorage.getItem(TELEMETRY_BAR_ENABLED_KEY) === "true")
  }, [])

  useEffect(() => {
    persistDashboardSessionState(dashboardSession)
  }, [dashboardSession])

  useEffect(() => {
    if (loading) return
    if (sandboxes.length === 0) {
      if (dashboardSession.selectedSandboxId)
        setDashboardSession((s) => updateDashboardSessionSelection(s, null))
      return
    }
    const stillExists = sandboxes.some((s) => s.id === dashboardSession.selectedSandboxId)
    if (stillExists) return
    const next = sandboxes.find((s) => s.isDefault)?.id || sandboxes[0]?.id || null
    setDashboardSession((s) => updateDashboardSessionSelection(s, next))
  }, [dashboardSession.selectedSandboxId, loading, sandboxes])

  const selectedSandbox = useMemo(
    () => sandboxes.find((s) => s.id === dashboardSession.selectedSandboxId) ?? null,
    [sandboxes, dashboardSession.selectedSandboxId],
  )
  const deletingSandbox = useMemo(
    () => sandboxes.find((s) => s.id === deletingSandboxId) ?? null,
    [sandboxes, deletingSandboxId],
  )

  const handleSandboxSelect = (id: string | null) => {
    if (isDestroyMode && id) {
      setDeletingSandboxId(id)
      setShowDeleteConfirm(true)
    } else {
      setDashboardSession((s) => updateDashboardSessionSelection(s, id))
    }
  }

  const sleep = (ms: number) => new Promise<void>((r) => window.setTimeout(r, ms))

  const refreshUntilSandboxGone = async (sandboxId: string, sandboxName: string) => {
    for (let i = 0; i < 10; i++) {
      const latest = await refresh({ force: true })
      if (!latest.find((s) => s.id === sandboxId || s.name === sandboxName))
        return { latest, gone: true }
      await sleep(1500)
    }
    return { latest: await refresh({ force: true }), gone: false }
  }

  const confirmDelete = async () => {
    if (!deletingSandboxId || deleteInProgress) return
    const sandbox = sandboxes.find((s) => s.id === deletingSandboxId)
    const sandboxName = sandbox?.name ?? deletingSandboxId
    try {
      setDeleteInProgress(true)
      setLifecycleMessage(`Destroying sandbox ${sandboxName}…`)
      const r = await fetch("/api/sandbox/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sandboxName, agent: sandbox?.agent || "openclaw" }),
      })
      const data = await r.json()
      if (!r.ok) throw new Error([data.error, data.stdout, data.stderr].filter(Boolean).join("\n\n") || "Failed to destroy sandbox")
      const { gone } = await refreshUntilSandboxGone(deletingSandboxId, sandboxName)
      setDashboardSession((s) =>
        updateDashboardSessionSelection(s, s.selectedSandboxId === deletingSandboxId ? null : s.selectedSandboxId),
      )
      toast[gone ? "success" : "warning"](
        gone ? `Sandbox ${sandboxName} destroyed.` : `Delete started for ${sandboxName}. Inventory still reports it while cleanup finishes.`,
      )
      setLifecycleMessage(null)
      setShowDeleteConfirm(false)
      setDeletingSandboxId(null)
      setIsDestroyMode(false)
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to destroy sandbox"
      setLifecycleMessage(msg)
      toast.error(msg)
    } finally {
      setDeleteInProgress(false)
    }
  }

  return (
    <>
      <Suspense>
        <DeniedToast />
      </Suspense>

      {telemetryBarEnabled && <LiveTelemetryBar />}

      {/* Destroy mode banner */}
      {isDestroyMode && (
        <div className="mb-4 flex items-center gap-3 rounded-md border-2 border-[var(--status-stopped)] bg-[var(--status-stopped-bg)] px-4 py-3">
          <p className="flex-1 text-sm font-mono uppercase tracking-wider text-[var(--status-stopped)]">
            Destroy mode — select a sandbox to delete it
          </p>
          <button
            onClick={() => { setIsDestroyMode(false); setDeletingSandboxId(null) }}
            className="action-button px-3 py-1.5 text-xs"
          >
            Cancel
          </button>
        </div>
      )}

      {lifecycleMessage && (
        <div className="mb-4 panel p-3 text-xs text-[var(--foreground-dim)] whitespace-pre-wrap" data-testid="sandbox-lifecycle-message">
          {lifecycleMessage}
        </div>
      )}

      {/* Activity panel */}
      <div className="mb-6">
        <ActivityPanel />
      </div>

      {/* Sandbox inventory */}
      {loading ? (
        <div className="flex items-center justify-center h-48" data-testid="inventory-loading-state">
          <p className="text-xs font-mono uppercase tracking-wider text-muted-foreground">Initializing…</p>
        </div>
      ) : error ? (
        <div className="panel p-8 text-center" data-testid="inventory-error-state">
          <h3 className="text-sm font-semibold text-[var(--status-stopped)] uppercase tracking-wider">Inventory Unavailable</h3>
          <p className="mt-2 text-xs font-mono text-muted-foreground">{error}</p>
        </div>
      ) : sandboxes.length === 0 ? (
        <div className="panel p-8 text-center" data-testid="inventory-empty-state">
          <svg className="w-12 h-12 mx-auto mb-4 text-muted-foreground" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="square" strokeLinejoin="miter" strokeWidth={1.5} d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4" />
          </svg>
          <h3 className="text-sm font-semibold uppercase tracking-wider">No Sandboxes Detected</h3>
          <p className="mt-2 text-xs text-muted-foreground">No live OpenShell sandboxes reported yet</p>
        </div>
      ) : (
        <SandboxList
          sandboxes={sandboxes}
          nemoclaw={nemoclaw}
          selectedSandboxId={dashboardSession.selectedSandboxId}
          selectedSandbox={selectedSandbox}
          onSandboxSelect={handleSandboxSelect}
          isDestroyMode={isDestroyMode}
          onInventoryRefresh={refresh}
          dashboardSessionId={dashboardSession.dashboardSessionId}
        />
      )}

      {/* Destroy confirm modal */}
      {showDeleteConfirm && (
        <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50">
          <div className="panel w-[min(92vw,28rem)] p-8 border-2 border-[var(--status-stopped)]">
            <div className="flex items-center gap-4 mb-4">
              <svg className="w-12 h-12 text-[var(--status-stopped)]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="square" strokeLinejoin="miter" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
              </svg>
              <h2 className="text-lg font-semibold text-[var(--status-stopped)] uppercase tracking-wider">
                Warning: Destructive Action
              </h2>
            </div>
            <p className="text-sm mb-6">
              Destroying <strong>{deletingSandbox?.name ?? "this sandbox"}</strong> will permanently delete it and it will not be recoverable. Are you sure?
            </p>
            {lifecycleMessage && (
              <div className="mb-4 panel p-3 text-xs text-muted-foreground whitespace-pre-wrap">
                {lifecycleMessage}
              </div>
            )}
            <div className="flex gap-4">
              <button
                onClick={confirmDelete}
                disabled={deleteInProgress}
                className="flex-1 px-4 py-2 rounded-sm bg-[var(--status-stopped)] text-white text-xs font-mono uppercase tracking-wider hover:bg-red-700 transition-colors disabled:opacity-50"
              >
                {deleteInProgress ? "Destroying…" : "Yes — Destroy"}
              </button>
              <button
                onClick={() => { setShowDeleteConfirm(false); setDeletingSandboxId(null) }}
                className="flex-1 px-4 py-2 rounded-sm action-button"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
