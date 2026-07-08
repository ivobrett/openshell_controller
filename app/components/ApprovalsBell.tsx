"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { Bell, ShieldQuestion } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/app/components/ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "@/app/components/ui/popover"
import { ScrollArea } from "@/app/components/ui/scroll-area"
import { Badge } from "@/app/components/ui/badge"
import { useInventory, usePermissionFeeds } from "@/app/hooks/queries"
import { useAuth } from "@/app/components/providers/AuthProvider"
import {
  loadDismissedPermissionAlerts,
  visiblePendingRequests,
} from "@/app/lib/permissionAlerts"
import { resolvePermissionRequest } from "@/app/lib/permissionActions"

export function ApprovalsBell() {
  const { can } = useAuth()
  const { sandboxes } = useInventory()
  const approvalSandboxes = can("approvePermissions") ? sandboxes : []
  const feedQuery = usePermissionFeeds(approvalSandboxes)
  const feeds = feedQuery.data ?? {}
  const dismissedAlerts = loadDismissedPermissionAlerts()
  const [open, setOpen] = useState(false)
  const [inFlight, setInFlight] = useState<string | null>(null)
  const router = useRouter()

  if (!can("approvePermissions")) return null

  const pendingItems = approvalSandboxes.flatMap((sandbox) => {
    const pending = visiblePendingRequests(feeds[sandbox.id], sandbox, dismissedAlerts)
    return pending.map((req) => ({ sandbox, req }))
  })

  const totalPending = pendingItems.length

  const handleAction = async (
    sandboxId: string,
    sandboxName: string,
    action: "approve" | "reject",
    chunkId: string,
  ) => {
    const key = `${sandboxId}:${chunkId}`
    if (inFlight === key) return
    setInFlight(key)
    const sandbox = approvalSandboxes.find((s) => s.id === sandboxId)
    if (!sandbox) return
    try {
      await resolvePermissionRequest(sandbox, action, chunkId)
      toast.success(
        action === "approve"
          ? `Approved for ${sandboxName}`
          : `Denied for ${sandboxName}`,
      )
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed")
    } finally {
      setInFlight(null)
    }
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="h-10 w-10 relative"
          aria-label={totalPending > 0 ? `${totalPending} pending approvals` : "Approvals"}
        >
          <Bell className="h-4 w-4" />
          {totalPending > 0 && (
            <span className="absolute -top-0.5 -right-0.5 min-w-4 h-4 rounded-full bg-warning text-black text-[10px] font-mono flex items-center justify-center px-0.5">
              {totalPending}
            </span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-96 p-0">
        <div className="p-3 border-b border-border">
          <p className="text-sm font-semibold">Pending approvals</p>
        </div>
        <ScrollArea className="max-h-[70vh]">
          {pendingItems.length === 0 ? (
            <div className="flex flex-col items-center gap-3 py-8 px-4 text-center">
              <ShieldQuestion className="h-8 w-8 text-muted-foreground" />
              <p className="text-sm text-muted-foreground">
                No pending approvals. Agent network requests will appear here.
              </p>
            </div>
          ) : (
            <div className="divide-y divide-border">
              {pendingItems.map(({ sandbox, req }) => {
                const label = req.endpoints[0] || req.rule || req.chunkId
                const key = `${sandbox.id}:${req.chunkId}`
                const isInFlight = inFlight === key
                return (
                  <div key={key} className="p-3 space-y-2">
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="font-mono text-xs font-bold truncate">{sandbox.name}</span>
                      {req.confidence && (
                        <Badge variant="outline" className="text-[10px] shrink-0">
                          {req.confidence}
                        </Badge>
                      )}
                    </div>
                    <p className="font-mono text-xs text-foreground truncate" title={label}>
                      {label}
                    </p>
                    <div className="flex items-center gap-2">
                      <Button
                        size="sm"
                        className="h-6 px-2 text-[10px]"
                        disabled={isInFlight}
                        onClick={() => handleAction(sandbox.id, sandbox.name, "approve", req.chunkId)}
                      >
                        {isInFlight ? "…" : "Allow"}
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-6 px-2 text-[10px]"
                        disabled={isInFlight}
                        onClick={() => handleAction(sandbox.id, sandbox.name, "reject", req.chunkId)}
                      >
                        Deny
                      </Button>
                      <button
                        className="ml-auto text-[10px] text-muted-foreground hover:text-foreground underline underline-offset-2"
                        onClick={() => {
                          setOpen(false)
                          router.push(`/sandboxes/${encodeURIComponent(sandbox.name)}?tab=policy`)
                        }}
                      >
                        Review in {sandbox.name} policy →
                      </button>
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </ScrollArea>
      </PopoverContent>
    </Popover>
  )
}
