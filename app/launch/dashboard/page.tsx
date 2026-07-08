"use client"

import { Suspense, useCallback, useEffect, useRef, useState } from "react"
import { useSearchParams } from "next/navigation"
import { Check, RefreshCw } from "lucide-react"

// §5.6 — the launch page is opened synchronously in a new tab by
// launchOpenClawDashboard() so the click never feels dead. It runs one long
// fetch to /api/openshell/dashboard/open (the same endpoint the old button
// called — do NOT touch that route, CLAUDE.md §10) and shows timer-driven
// staged progress "theatre" over it, then redirects itself to the dashboard.

type StageState = "pending" | "active" | "done"

const STAGE_LABELS = [
  "Contacting controller",
  "Starting gateway tunnel",
  "Verifying dashboard token",
  "Opening dashboard",
] as const

function StageRow({ label, state }: { label: string; state: StageState }) {
  return (
    <li className="flex items-center gap-2.5 text-sm">
      <span className="flex h-4 w-4 shrink-0 items-center justify-center">
        {state === "done" ? (
          <Check className="h-4 w-4 text-[var(--nvidia-green)]" />
        ) : state === "active" ? (
          <RefreshCw className="h-4 w-4 animate-spin text-[var(--nvidia-green)]" />
        ) : (
          <span className="h-2 w-2 rounded-full bg-[var(--border-medium)]" />
        )}
      </span>
      <span className={state === "pending" ? "text-[var(--foreground-dim)]" : "text-[var(--foreground-hex)]"}>
        {label}
      </span>
    </li>
  )
}

function LaunchDashboardInner() {
  const params = useSearchParams()
  const sandboxId = params.get("sandboxId") || ""
  const instanceId = params.get("instanceId") || ""

  // stageIndex = index of the currently-active stage; when all done we redirect.
  const [stageIndex, setStageIndex] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const timersRef = useRef<number[]>([])

  const clearTimers = () => {
    for (const t of timersRef.current) window.clearTimeout(t)
    timersRef.current = []
  }

  const run = useCallback(async () => {
    clearTimers()
    setError(null)
    setStageIndex(0)

    if (!sandboxId && !instanceId) {
      setError("Missing sandboxId. Add ?sandboxId=<name> to the URL.")
      return
    }

    // Timer-driven theatre: advance the visible stage over the single long fetch.
    timersRef.current.push(window.setTimeout(() => setStageIndex((i) => Math.max(i, 1)), 1500))
    timersRef.current.push(window.setTimeout(() => setStageIndex((i) => Math.max(i, 2)), 8000))

    try {
      const query = new URLSearchParams()
      if (sandboxId) query.set("sandboxId", sandboxId)
      if (instanceId) query.set("instanceId", instanceId)
      const response = await fetch(`/api/openshell/dashboard/open?${query.toString()}`, {
        cache: "no-store",
        signal: AbortSignal.timeout(45_000),
      })
      if (response.status === 401) {
        const next = encodeURIComponent(window.location.pathname + window.location.search)
        window.location.href = `/login?next=${next}`
        return
      }
      const data = await response.json().catch(() => ({}))
      if (!response.ok || !data.ok) {
        clearTimers()
        setError(data.error || "Failed to resolve the OpenClaw dashboard URL.")
        return
      }
      const target = data.launchUrl || data.proxiedUrl || data.dashboardUrl
      if (!target) {
        clearTimers()
        setError("The dashboard endpoint did not return a launch URL.")
        return
      }
      clearTimers()
      setStageIndex(3)
      window.location.replace(target)
    } catch (err) {
      clearTimers()
      if (err instanceof DOMException && err.name === "TimeoutError") {
        setError("Timed out after 45 s")
      } else {
        setError(err instanceof Error ? err.message : "Failed to open the dashboard.")
      }
    }
  }, [sandboxId, instanceId])

  useEffect(() => {
    run()
    return clearTimers
  }, [run])

  const stageStateFor = (i: number): StageState => {
    if (error) return i < stageIndex ? "done" : "pending"
    if (i < stageIndex) return "done"
    if (i === stageIndex) return "active"
    return "pending"
  }

  return (
    <main className="min-h-screen bg-[var(--background-hex)] text-[var(--foreground-hex)] flex items-center justify-center p-6">
      <section className="panel max-w-md w-full p-8 space-y-5">
        <div className="text-center space-y-1">
          <h1 className="text-sm uppercase tracking-[0.2em] text-[var(--foreground-dim)]">
            OpenClaw Gateway Dashboard
          </h1>
          <p className="font-mono text-base text-[var(--foreground-hex)]">
            {sandboxId || instanceId || "(no sandbox)"}
          </p>
        </div>

        {error ? (
          <div className="space-y-4">
            <div className="rounded-sm border border-[var(--status-stopped)] bg-[var(--status-stopped-bg)] p-3 text-xs text-[var(--foreground-hex)]">
              {error}
            </div>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={run}
                className="action-button flex-1 px-3 py-2"
              >
                Retry
              </button>
              <button
                type="button"
                onClick={() => window.close()}
                className="action-button flex-1 px-3 py-2"
              >
                Close tab
              </button>
            </div>
          </div>
        ) : (
          <>
            <ul className="space-y-3">
              {STAGE_LABELS.map((label, i) => (
                <StageRow key={label} label={label} state={stageStateFor(i)} />
              ))}
            </ul>
            <p className="text-center font-mono text-[11px] text-[var(--foreground-dim)]">
              First open after idle can take up to 30 seconds.
            </p>
          </>
        )}
      </section>
    </main>
  )
}

export default function LaunchDashboardPage() {
  return (
    <Suspense
      fallback={
        <main className="min-h-screen bg-[var(--background-hex)] text-[var(--foreground-hex)] p-8">Loading…</main>
      }
    >
      <LaunchDashboardInner />
    </Suspense>
  )
}
