"use client"

import { useState } from "react"
import { toast } from "sonner"
import { resolvePermissionRequest } from "@/app/lib/permissionActions"
import {
  loadDismissedPermissionAlerts,
  saveDismissedPermissionAlerts,
  visiblePendingRequests,
} from "@/app/lib/permissionAlerts"
import type { SandboxInventoryItem } from "@/app/hooks/inventoryModel"
import type { PermissionFeed } from "@/app/hooks/models"

// Extracted from SandboxList.tsx:1063-1123. Renders the pending network
// permission request cards with Grant / Reject / Do Nothing. Uses the shared
// resolvePermissionRequest helper (§5.8) and the dismissal store.

interface SandboxPolicyRequestsProps {
  sandbox: SandboxInventoryItem
  feed: PermissionFeed | undefined
}

export function SandboxPolicyRequests({ sandbox, feed }: SandboxPolicyRequestsProps) {
  const [dismissed, setDismissed] = useState(() => loadDismissedPermissionAlerts())
  const [busyChunkId, setBusyChunkId] = useState<string | null>(null)

  const pending = visiblePendingRequests(feed, sandbox, dismissed)

  const resolve = async (action: "approve" | "reject", chunkId: string) => {
    if (!chunkId || busyChunkId) return
    setBusyChunkId(chunkId)
    try {
      await resolvePermissionRequest(sandbox, action, chunkId)
      toast.success(
        action === "approve"
          ? `Network request approved for ${sandbox.name}`
          : `Network request rejected for ${sandbox.name}`,
      )
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to resolve permission request")
    } finally {
      setBusyChunkId(null)
    }
  }

  const dismiss = (chunkId: string) => {
    setDismissed((current) => {
      const existing = new Set(current[sandbox.id] || [])
      existing.add(chunkId)
      const next = { ...current, [sandbox.id]: Array.from(existing) }
      saveDismissedPermissionAlerts(next)
      return next
    })
  }

  if (pending.length === 0) {
    return (
      <div className="rounded-sm border border-[var(--border-subtle)] bg-[var(--background-tertiary)] p-4 text-xs text-[var(--foreground-dim)]">
        No pending network permission requests for this sandbox.
      </div>
    )
  }

  return (
    <div className="space-y-4">
      {pending.map((request) => (
        <div key={request.chunkId} className="rounded-sm border border-amber-400/60 bg-amber-400/10 p-4">
          <div className="flex items-start justify-between gap-4 max-md:flex-col">
            <div className="min-w-0 space-y-2">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-xs font-mono font-semibold text-[var(--foreground-hex)]">
                  {request.endpoints.join(", ") || request.rule}
                </span>
                {request.confidence ? (
                  <span className="rounded-sm border border-[var(--border-subtle)] px-1.5 py-0.5 text-[10px] text-[var(--foreground-dim)]">
                    {request.confidence}
                  </span>
                ) : null}
              </div>
              <p className="text-xs text-[var(--foreground-dim)]">{request.rationale || "Sandbox requested a network policy rule."}</p>
              <p className="text-[10px] font-mono text-[var(--foreground-dim)]">
                {request.binary || request.binaries.join(", ") || "unknown binary"} / {request.chunkId}
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-2 max-md:w-full max-md:[&>button]:flex-1">
              <button
                type="button"
                disabled={busyChunkId !== null}
                onClick={() => resolve("approve", request.chunkId)}
                className="rounded-sm border border-[var(--nvidia-green)] bg-[var(--nvidia-green)] px-3 py-2 text-xs font-mono uppercase tracking-wider text-black disabled:opacity-50"
              >
                Grant
              </button>
              <button
                type="button"
                disabled={busyChunkId !== null}
                onClick={() => resolve("reject", request.chunkId)}
                className="rounded-sm border border-[var(--border-subtle)] bg-[var(--background-tertiary)] px-3 py-2 text-xs font-mono uppercase tracking-wider text-[var(--foreground-hex)] disabled:opacity-50"
              >
                Reject
              </button>
              <button
                type="button"
                disabled={busyChunkId !== null}
                onClick={() => dismiss(request.chunkId)}
                className="rounded-sm border border-[var(--border-subtle)] bg-[var(--background-tertiary)] px-3 py-2 text-xs font-mono uppercase tracking-wider text-[var(--foreground-dim)] disabled:opacity-50"
              >
                Do Nothing
              </button>
            </div>
          </div>
        </div>
      ))}
    </div>
  )
}
