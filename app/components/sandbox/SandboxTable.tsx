"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { Search, MoreHorizontal, PanelsTopLeft, SquareTerminal, MonitorSmartphone } from "lucide-react"
import { toast } from "sonner"
import { queryClient } from "@/app/lib/queryClient"
import { Input } from "@/app/components/ui/input"
import { Badge } from "@/app/components/ui/badge"
import { Button } from "@/app/components/ui/button"
import { Card } from "@/app/components/ui/card"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/app/components/ui/table"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/app/components/ui/dropdown-menu"
import { StatusLed } from "@/app/components/StatusLed"
import { SandboxTypeLogo } from "./SandboxTypeLogo"
import { DeleteSandboxDialog } from "./DeleteSandboxDialog"
import { buildOperatorTerminalRoute } from "@/app/lib/dashboardSession"
import { launchOpenClawDashboard } from "@/app/lib/launchDashboard"
import { visiblePendingRequests } from "@/app/lib/permissionAlerts"
import { useAuth } from "@/app/components/providers/AuthProvider"
import type { SandboxInventoryItem } from "@/app/hooks/inventoryModel"
import type { PermissionFeed } from "@/app/hooks/models"
import { cn } from "@/app/lib/utils"

type StatusFilter = "all" | "running" | "stopped" | "attention"

function displaySandboxAgent(agent?: string) {
  if (agent === "hermes") return "Hermes"
  if (agent === "custom") return "Custom"
  return "OpenClaw"
}

interface SandboxTableProps {
  sandboxes: SandboxInventoryItem[]
  permissionFeeds: Record<string, PermissionFeed>
  dismissedAlerts: Record<string, string[]>
  dashboardSessionId: string
}

export function SandboxTable({
  sandboxes,
  permissionFeeds,
  dismissedAlerts,
  dashboardSessionId,
}: SandboxTableProps) {
  const router = useRouter()
  const { me, can } = useAuth()
  const [search, setSearch] = useState("")
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all")
  const [deleteTarget, setDeleteTarget] = useState<SandboxInventoryItem | null>(null)
  const [restartingId, setRestartingId] = useState<string | null>(null)

  const hasPending = (sandbox: SandboxInventoryItem) =>
    visiblePendingRequests(permissionFeeds[sandbox.id], sandbox, dismissedAlerts).length > 0

  const filtered = sandboxes.filter((s) => {
    const q = search.toLowerCase()
    const matchSearch = !q || s.name.toLowerCase().includes(q) || (s.agent || "").toLowerCase().includes(q)
    if (!matchSearch) return false
    if (statusFilter === "running") return s.status === "running" && s.ready
    if (statusFilter === "stopped") return s.status === "stopped"
    if (statusFilter === "attention") return hasPending(s)
    return true
  })

  const counts = {
    all: sandboxes.length,
    running: sandboxes.filter((s) => s.status === "running" && s.ready).length,
    stopped: sandboxes.filter((s) => s.status === "stopped").length,
    attention: sandboxes.filter(hasPending).length,
  }

  const chips: { key: StatusFilter; label: string }[] = [
    { key: "all", label: `All (${counts.all})` },
    { key: "running", label: `Running (${counts.running})` },
    { key: "stopped", label: `Stopped (${counts.stopped})` },
    { key: "attention", label: `Attention (${counts.attention})` },
  ]

  const handleRestart = async (sandbox: SandboxInventoryItem) => {
    if (restartingId) return
    setRestartingId(sandbox.id)
    try {
      const r = await fetch("/api/sandbox/restart", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sandboxName: sandbox.name, agent: sandbox.agent || "openclaw" }),
      })
      const data = await r.json()
      if (!r.ok) throw new Error(data.error || "Failed to restart")
      toast.success(`Restart requested for ${sandbox.name}`)
      queryClient.invalidateQueries({ queryKey: ["inventory"] })
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to restart")
    } finally {
      setRestartingId(null)
    }
  }

  const copyLink = async (type: "terminal" | "dashboard", sandbox: SandboxInventoryItem) => {
    const url =
      type === "terminal"
        ? window.location.origin + buildOperatorTerminalRoute({ sandboxId: sandbox.name, dashboardSessionId })
        : window.location.origin + `/launch/dashboard?sandboxId=${encodeURIComponent(sandbox.name)}`
    try {
      await navigator.clipboard.writeText(url)
      toast.success("Dashboard link copied")
    } catch {
      toast.error("Failed to copy link")
    }
  }

  return (
    <>
      {/* Filter row */}
      <div className="flex flex-col gap-2 mb-3 md:flex-row md:items-center">
        <div className="relative w-full md:w-64">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
          <Input
            placeholder="Search sandboxes"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-8 h-8 text-sm"
          />
        </div>
        <div className="flex gap-1.5 flex-wrap">
          {chips.map((chip) => (
            <button
              key={chip.key}
              onClick={() => setStatusFilter(chip.key)}
              className={cn(
                "rounded-full px-2.5 py-0.5 text-xs font-mono transition-colors border",
                statusFilter === chip.key
                  ? "bg-primary text-primary-foreground border-primary"
                  : "border-border text-muted-foreground hover:border-foreground hover:text-foreground",
              )}
            >
              {chip.label}
            </button>
          ))}
        </div>
      </div>

      {filtered.length === 0 && (sandboxes.length > 0) && (
        <div className="py-8 text-center text-sm text-muted-foreground">
          No sandboxes match.{" "}
          <button
            className="underline underline-offset-2 hover:text-foreground"
            onClick={() => { setSearch(""); setStatusFilter("all") }}
          >
            Clear filters
          </button>
        </div>
      )}

      {/* Desktop table */}
      {filtered.length > 0 && (
        <Card className="hidden md:block p-0 overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow className="h-9 hover:bg-transparent">
                <TableHead className="pl-4">Name</TableHead>
                <TableHead className="w-[120px]">Status</TableHead>
                <TableHead className="w-[100px]">Agent</TableHead>
                <TableHead className="w-[110px]">Alerts</TableHead>
                <TableHead className="w-[96px] text-right pr-4">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.map((sandbox) => {
                const pending = visiblePendingRequests(permissionFeeds[sandbox.id], sandbox, dismissedAlerts)
                const isHermes = sandbox.agent === "hermes"
                const isCustom = sandbox.agent === "custom"
                const isRestarting = restartingId === sandbox.id
                return (
                  <TableRow
                    key={sandbox.id}
                    className="h-11 cursor-pointer hover:bg-accent/50"
                    onClick={() => router.push(`/sandboxes/${encodeURIComponent(sandbox.name)}`)}
                  >
                    <TableCell className="pl-4">
                      <div className="flex items-center gap-2 min-w-0">
                        <SandboxTypeLogo agent={sandbox.agent} size="sm" />
                        <span className="truncate font-mono text-sm font-medium">{sandbox.name}</span>
                        {sandbox.isDefault && (
                          <Badge variant="outline" className="text-[10px] px-1.5 py-0 shrink-0">default</Badge>
                        )}
                      </div>
                    </TableCell>
                    <TableCell>
                      <StatusLed status={sandbox.status} ready={sandbox.ready} />
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {displaySandboxAgent(sandbox.agent)}
                    </TableCell>
                    <TableCell>
                      {pending.length > 0 ? (
                        <Badge
                          variant="outline"
                          className="border-warning text-warning text-[10px] cursor-pointer hover:bg-warning/10"
                          onClick={(e) => {
                            e.stopPropagation()
                            router.push(`/sandboxes/${encodeURIComponent(sandbox.name)}?tab=policy`)
                          }}
                        >
                          {pending.length} pending
                        </Badge>
                      ) : (
                        <span className="inline-block h-2 w-2 rounded-full bg-success/70" title="No pending requests" />
                      )}
                    </TableCell>
                    <TableCell className="pr-4" onClick={(e) => e.stopPropagation()}>
                      <div className="flex items-center justify-end gap-1">
                        {!isHermes && !isCustom && can("openDashboard") && (
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-7 w-7"
                            title="Open dashboard"
                            onClick={() => launchOpenClawDashboard(sandbox.name)}
                          >
                            <PanelsTopLeft className="h-3.5 w-3.5" />
                          </Button>
                        )}
                        {isHermes && (
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-7 w-7"
                            title="Open Hermes dashboard"
                            onClick={() =>
                              window.open(
                                `/api/sandbox/${encodeURIComponent(sandbox.name)}/hermes/dashboard/proxy/`,
                                "_blank",
                                "noopener,noreferrer",
                              )
                            }
                          >
                            <MonitorSmartphone className="h-3.5 w-3.5" />
                          </Button>
                        )}
                        {can("openTerminal") && (
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-7 w-7"
                            title="Terminal"
                            onClick={() =>
                              window.open(
                                buildOperatorTerminalRoute({ sandboxId: sandbox.name, dashboardSessionId }),
                                "_blank",
                                "noopener,noreferrer",
                              )
                            }
                          >
                            <SquareTerminal className="h-3.5 w-3.5" />
                          </Button>
                        )}
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button variant="ghost" size="icon" className="h-7 w-7" title="More actions">
                              <MoreHorizontal className="h-3.5 w-3.5" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            {can("restartSandbox") && (
                              <DropdownMenuItem
                                disabled={isRestarting}
                                onClick={() => handleRestart(sandbox)}
                              >
                                {isRestarting ? "Restarting…" : "Restart runtime"}
                              </DropdownMenuItem>
                            )}
                            <DropdownMenuItem onClick={() => copyLink("terminal", sandbox)}>
                              Copy terminal link
                            </DropdownMenuItem>
                            {!isHermes && !isCustom && (
                              <DropdownMenuItem onClick={() => copyLink("dashboard", sandbox)}>
                                Copy dashboard link
                              </DropdownMenuItem>
                            )}
                            {can("deleteSandbox") && (
                              <>
                                <DropdownMenuSeparator />
                                <DropdownMenuItem
                                  className="text-destructive focus:text-destructive"
                                  onClick={() => setDeleteTarget(sandbox)}
                                >
                                  Delete…
                                </DropdownMenuItem>
                              </>
                            )}
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </div>
                    </TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        </Card>
      )}

      {/* Mobile cards */}
      {filtered.length > 0 && (
        <div className="md:hidden space-y-2">
          {filtered.map((sandbox) => {
            const pending = visiblePendingRequests(permissionFeeds[sandbox.id], sandbox, dismissedAlerts)
            const isHermes = sandbox.agent === "hermes"
            const isCustom = sandbox.agent === "custom"
            return (
              <div
                key={sandbox.id}
                className="rounded-lg border border-border bg-card p-3 cursor-pointer hover:bg-accent/30 transition-colors relative"
                onClick={() => router.push(`/sandboxes/${encodeURIComponent(sandbox.name)}`)}
              >
                <div className="flex items-center gap-2 min-w-0">
                  <SandboxTypeLogo agent={sandbox.agent} size="sm" />
                  <span className="truncate font-mono text-sm font-medium">{sandbox.name}</span>
                  <StatusLed status={sandbox.status} ready={sandbox.ready} dotOnly />
                  {pending.length > 0 && (
                    <Badge variant="outline" className="border-warning text-warning text-[10px] ml-auto shrink-0">
                      {pending.length}
                    </Badge>
                  )}
                </div>
                <div className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
                  <span>{displaySandboxAgent(sandbox.agent)}</span>
                </div>
                <div
                  className="absolute right-2 top-2"
                  onClick={(e) => e.stopPropagation()}
                >
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="ghost" size="icon" className="h-7 w-7">
                        <MoreHorizontal className="h-3.5 w-3.5" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      {!isHermes && !isCustom && can("openDashboard") && (
                        <DropdownMenuItem onClick={() => launchOpenClawDashboard(sandbox.name)}>
                          Open dashboard
                        </DropdownMenuItem>
                      )}
                      {can("openTerminal") && (
                        <DropdownMenuItem
                          onClick={() =>
                            window.open(
                              buildOperatorTerminalRoute({ sandboxId: sandbox.name, dashboardSessionId }),
                              "_blank",
                              "noopener,noreferrer",
                            )
                          }
                        >
                          Terminal
                        </DropdownMenuItem>
                      )}
                      {can("restartSandbox") && (
                        <DropdownMenuItem onClick={() => handleRestart(sandbox)}>
                          Restart runtime
                        </DropdownMenuItem>
                      )}
                      <DropdownMenuItem onClick={() => copyLink("terminal", sandbox)}>
                        Copy terminal link
                      </DropdownMenuItem>
                      {can("deleteSandbox") && (
                        <>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem
                            className="text-destructive focus:text-destructive"
                            onClick={() => setDeleteTarget(sandbox)}
                          >
                            Delete…
                          </DropdownMenuItem>
                        </>
                      )}
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              </div>
            )
          })}
        </div>
      )}

      <DeleteSandboxDialog
        sandbox={deleteTarget}
        open={deleteTarget !== null}
        onOpenChange={(v) => { if (!v) setDeleteTarget(null) }}
      />
    </>
  )
}
