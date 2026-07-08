"use client"

import { Suspense, use, useEffect, useMemo, useState } from "react"
import { useRouter, useSearchParams } from "next/navigation"
import Link from "next/link"
import { toast } from "sonner"
import {
  ChevronLeft,
  PanelsTopLeft,
  MonitorSmartphone,
  SquareTerminal,
  RotateCcw,
  MoreHorizontal,
} from "lucide-react"
import { Card } from "@/app/components/ui/card"
import { Badge } from "@/app/components/ui/badge"
import { Button } from "@/app/components/ui/button"
import { Skeleton } from "@/app/components/ui/skeleton"
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/app/components/ui/tabs"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/app/components/ui/dropdown-menu"
import { StatusLed } from "@/app/components/StatusLed"
import { SandboxTypeLogo } from "@/app/components/sandbox/SandboxTypeLogo"
import { DeleteSandboxDialog } from "@/app/components/sandbox/DeleteSandboxDialog"
import { SandboxMcpAccess, enableMcpForSandbox, sandboxCanAccessMcpServer } from "@/app/components/sandbox/SandboxMcpAccess"
import { SandboxPolicyRequests } from "@/app/components/sandbox/SandboxPolicyRequests"
import SandboxHealthPanel from "@/app/components/SandboxHealthPanel"
import SandboxFilesPanel from "@/app/components/SandboxFilesPanel"
import SandboxInferencePanel from "@/app/components/SandboxInferencePanel"
import SandboxArchivePanel from "@/app/components/SandboxArchivePanel"
import ShieldsPanel from "@/app/components/ShieldsPanel"
import ConfigurationPanel from "@/app/components/ConfigurationPanel"
import HermesRemotePanel from "@/app/components/HermesRemotePanel"
import OpenClawRemotePanel from "@/app/components/OpenClawRemotePanel"
import { useAuth } from "@/app/components/providers/AuthProvider"
import { useInventory, usePermissionFeeds, useSandboxTelemetry, useMcpServers } from "@/app/hooks/queries"
import { visiblePendingRequests, loadDismissedPermissionAlerts } from "@/app/lib/permissionAlerts"
import { launchOpenClawDashboard } from "@/app/lib/launchDashboard"
import { restartRuntime } from "@/app/lib/restartRuntime"
import {
  buildOperatorTerminalRoute,
  createHydrationSafeDashboardSessionState,
  loadDashboardSessionState,
} from "@/app/lib/dashboardSession"
import type { SandboxInventoryItem } from "@/app/hooks/inventoryModel"
import type { McpServerAccess } from "@/app/hooks/models"

const BASELINE_MCP: { id: string; label: string }[] = [
  { id: "memory", label: "Memory" },
  { id: "inter-sandbox-chat", label: "Inter-sandbox chat" },
]

function displaySandboxAgent(agent?: string) {
  if (agent === "hermes") return "Hermes"
  if (agent === "custom") return "Custom"
  return "OpenClaw"
}

function DetailField({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid grid-cols-[7rem_minmax(0,1fr)] items-center gap-3">
      <span className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</span>
      <span className="truncate font-mono text-xs" title={value}>{value}</span>
    </div>
  )
}

function AgentCapabilitiesCard({
  sandbox,
  mcpServers,
  canManage,
}: {
  sandbox: SandboxInventoryItem
  mcpServers: McpServerAccess[]
  canManage: boolean
}) {
  const [enablingId, setEnablingId] = useState<string | null>(null)
  const allowed = mcpServers.filter((s) => sandboxCanAccessMcpServer(sandbox, s))
  const allowedIds = new Set(allowed.map((s) => s.id))

  const enable = async (server: McpServerAccess) => {
    if (enablingId) return
    setEnablingId(server.id)
    try {
      await enableMcpForSandbox(sandbox, server)
      toast.success(`${server.name} enabled for ${sandbox.name}`, {
        description: "Config issued — the agent sees new servers on its next MCP session.",
      })
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to enable server")
    } finally {
      setEnablingId(null)
    }
  }

  return (
    <Card className="p-4 space-y-3">
      <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Agent capabilities</h3>
      {allowed.length === 0 ? (
        <p className="text-xs text-muted-foreground">No MCP servers are allowed for this sandbox yet.</p>
      ) : (
        <ul className="space-y-2">
          {allowed.map((server) => (
            <li key={server.id} className="text-xs">
              <span className="font-mono font-medium">{server.name}</span>
              {server.summary && <p className="mt-0.5 text-muted-foreground">{server.summary}</p>}
            </li>
          ))}
        </ul>
      )}

      {canManage && (
        <div className="flex flex-wrap gap-2 pt-1">
          {BASELINE_MCP.map(({ id, label }) => {
            const server = mcpServers.find((s) => s.id === id)
            if (!server || allowedIds.has(id)) return null
            return (
              <Button
                key={id}
                size="sm"
                variant="outline"
                disabled={enablingId !== null}
                onClick={() => enable(server)}
              >
                {enablingId === id ? "Enabling…" : `Enable ${label}`}
              </Button>
            )
          })}
        </div>
      )}

      <div className="flex flex-wrap gap-4 pt-2 border-t border-border text-xs">
        {canManage && (
          <Link
            href={`/sandboxes/${encodeURIComponent(sandbox.name)}?tab=mcp`}
            className="text-muted-foreground hover:text-foreground transition-colors"
          >
            Manage MCP access →
          </Link>
        )}
        <Link href="/skills" className="text-muted-foreground hover:text-foreground transition-colors">
          Setup skills →
        </Link>
      </div>
    </Card>
  )
}

// Controlled by the parent so it shares a single busy flag with the header
// Restart button — two independent controls could otherwise double-fire a
// ~2-minute restart (concurrent POSTs / racing gateway kill+relaunch).
function RuntimeCard({
  canRestart,
  busy,
  lastResult,
  onRestart,
}: {
  canRestart: boolean
  busy: boolean
  lastResult: string | null
  onRestart: () => void
}) {
  if (!canRestart) return null

  return (
    <Card className="p-4 space-y-3">
      <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Runtime</h3>
      <p className="text-xs text-muted-foreground">
        Recover the sandbox gateway and agent runtime (keeps all data).
      </p>
      <Button size="sm" variant="outline" disabled={busy} onClick={onRestart}>
        <RotateCcw className={busy ? "h-3.5 w-3.5 mr-1.5 animate-spin" : "h-3.5 w-3.5 mr-1.5"} />
        {busy ? "Restarting…" : "Restart runtime"}
      </Button>
      {lastResult && <p className="text-[10px] font-mono text-muted-foreground">{lastResult}</p>}
    </Card>
  )
}

function ShareLinksCard({ sandbox, dashboardSessionId }: { sandbox: SandboxInventoryItem; dashboardSessionId: string }) {
  const isHermes = sandbox.agent === "hermes"
  const isCustom = sandbox.agent === "custom"

  const copy = async (url: string, label: string) => {
    try {
      await navigator.clipboard.writeText(window.location.origin + url)
      toast.success(`${label} copied`)
    } catch {
      toast.error("Failed to copy link")
    }
  }

  return (
    <Card className="p-4 space-y-3">
      <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Share links</h3>
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="outline"
          onClick={() => copy(buildOperatorTerminalRoute({ sandboxId: sandbox.name, dashboardSessionId }), "Terminal link")}
        >
          Copy terminal link
        </Button>
        {!isHermes && !isCustom && (
          <Button
            size="sm"
            variant="outline"
            onClick={() => copy(`/launch/dashboard?sandboxId=${encodeURIComponent(sandbox.name)}`, "Dashboard link")}
          >
            Copy dashboard link
          </Button>
        )}
        {isHermes && (
          <Button
            size="sm"
            variant="outline"
            onClick={() => copy(`/api/sandbox/${encodeURIComponent(sandbox.name)}/hermes/dashboard/proxy/`, "Dashboard link")}
          >
            Copy dashboard link
          </Button>
        )}
      </div>
    </Card>
  )
}

function SandboxDetailInner({ name }: { name: string }) {
  const router = useRouter()
  const searchParams = useSearchParams()
  const { me, can } = useAuth()
  const { sandboxes, isLoading, refetch } = useInventory()

  const sandbox = sandboxes.find((s) => s.name === name || s.id === name)

  const [dashboardSessionId, setDashboardSessionId] = useState(
    () => createHydrationSafeDashboardSessionState().dashboardSessionId,
  )
  useEffect(() => {
    setDashboardSessionId(loadDashboardSessionState().dashboardSessionId)
  }, [])

  const singletonList = useMemo(() => (sandbox ? [sandbox] : []), [sandbox])
  const feedQuery = usePermissionFeeds(can("approvePermissions") ? singletonList : [])
  const feed = sandbox ? feedQuery.data?.[sandbox.id] : undefined
  const dismissed = loadDismissedPermissionAlerts()
  const pendingCount = sandbox ? visiblePendingRequests(feed, sandbox, dismissed).length : 0

  const mcpQuery = useMcpServers()
  const mcpServers = mcpQuery.data ?? []

  const activeTab = searchParams.get("tab") || "overview"
  const setTab = (tab: string) => {
    const params = new URLSearchParams(searchParams.toString())
    if (tab === "overview") params.delete("tab")
    else params.set("tab", tab)
    const qs = params.toString()
    router.replace(`/sandboxes/${encodeURIComponent(name)}${qs ? `?${qs}` : ""}`)
  }

  const isHermes = sandbox?.agent === "hermes"
  const isCustom = sandbox?.agent === "custom"
  const isOpenClaw = !isHermes && !isCustom

  // Tab visibility per §5.3. role === "user" gets Overview only.
  type TabDef = { key: string; label: string; show: boolean; badge?: number }
  const tabs: TabDef[] = [
    { key: "overview", label: "Overview", show: true },
    { key: "access", label: "Access", show: (isOpenClaw || isHermes) && me.role === "operator" },
    { key: "files", label: "Files", show: can("manageFiles") },
    { key: "inference", label: "Inference", show: can("manageInference") },
    { key: "mcp", label: "MCP", show: can("manageMcp") },
    { key: "policy", label: "Policy", show: can("approvePermissions"), badge: pendingCount },
    { key: "backup", label: "Backup", show: can("backupRestore") },
    { key: "shields", label: "Shields", show: isOpenClaw && can("manageShields") },
  ]
  const visibleTabs = tabs.filter((t) => t.show)
  const currentTab = visibleTabs.some((t) => t.key === activeTab) ? activeTab : "overview"

  // Telemetry only shows on Overview; gate on the RESOLVED tab so a deep link to
  // an unauthorized tab (which falls back to Overview) still fetches the cards.
  const telemetryQuery = useSandboxTelemetry(currentTab === "overview" && !!sandbox)
  const telemetry = telemetryQuery.data

  const [deleteOpen, setDeleteOpen] = useState(false)
  const [restarting, setRestarting] = useState(false)
  const [lastRestartResult, setLastRestartResult] = useState<string | null>(null)

  if (isLoading && !sandbox) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-6 w-40" />
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    )
  }

  if (!sandbox) {
    return (
      <div className="py-16 text-center space-y-3">
        <h1 className="text-sm font-semibold uppercase tracking-wider">
          Sandbox not found or you don&apos;t have access
        </h1>
        <Button asChild size="sm" variant="outline">
          <Link href="/">← Sandboxes</Link>
        </Button>
      </div>
    )
  }

  // Single busy flag shared by the header Restart button and the RuntimeCard.
  const handleRestart = async () => {
    if (restarting) return
    setRestarting(true)
    try {
      const result = await restartRuntime(sandbox)
      // 409 not-Ready resolves with restarted:false (warning toast) — don't
      // claim success in that case.
      if (result?.restarted !== false) {
        setLastRestartResult(`Restart requested ${new Date().toLocaleTimeString()}`)
      }
    } catch {
      // toast surfaced already
    } finally {
      setRestarting(false)
    }
  }

  const copyLink = async (path: string, label: string) => {
    try {
      await navigator.clipboard.writeText(window.location.origin + path)
      toast.success(`${label} copied`)
    } catch {
      toast.error("Failed to copy link")
    }
  }

  return (
    <>
      {/* Breadcrumb */}
      <Link
        href="/"
        className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors mb-4"
      >
        <ChevronLeft className="h-3.5 w-3.5" /> Sandboxes
      </Link>

      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-4 mb-6">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <SandboxTypeLogo agent={sandbox.agent} size="md" />
            <h1 className="font-mono text-lg font-semibold truncate">{sandbox.name}</h1>
            <StatusLed status={sandbox.status} ready={sandbox.ready} />
            <span className="text-xs text-muted-foreground">{displaySandboxAgent(sandbox.agent)}</span>
            {sandbox.isDefault && (
              <Badge variant="outline" className="text-[10px] px-1.5 py-0">default</Badge>
            )}
          </div>
          <p className="mt-1 font-mono text-xs text-muted-foreground truncate">
            {sandbox.id} · {sandbox.namespace} · {sandbox.sshHostAlias || sandbox.ip}
          </p>
        </div>

        <div className="flex items-center gap-1.5">
          {isOpenClaw && can("openDashboard") && (
            <Button size="sm" variant="outline" onClick={() => launchOpenClawDashboard(sandbox.name)}>
              <PanelsTopLeft className="h-3.5 w-3.5 mr-1.5" /> Open dashboard
            </Button>
          )}
          {isHermes && (
            <Button
              size="sm"
              variant="outline"
              onClick={() =>
                window.open(
                  `/api/sandbox/${encodeURIComponent(sandbox.name)}/hermes/dashboard/proxy/`,
                  "_blank",
                  "noopener,noreferrer",
                )
              }
            >
              <MonitorSmartphone className="h-3.5 w-3.5 mr-1.5" /> Open Hermes dashboard
            </Button>
          )}
          {can("openTerminal") && (
            <Button
              size="sm"
              variant="outline"
              onClick={() =>
                window.open(
                  buildOperatorTerminalRoute({ sandboxId: sandbox.name, dashboardSessionId }),
                  "_blank",
                  "noopener,noreferrer",
                )
              }
            >
              <SquareTerminal className="h-3.5 w-3.5 mr-1.5" /> Terminal
            </Button>
          )}
          {can("restartSandbox") && (
            <Button size="sm" variant="outline" disabled={restarting} onClick={handleRestart}>
              <RotateCcw className={restarting ? "h-3.5 w-3.5 mr-1.5 animate-spin" : "h-3.5 w-3.5 mr-1.5"} />
              {restarting ? "Restarting…" : "Restart"}
            </Button>
          )}
          {can("deleteSandbox") && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button size="icon" variant="ghost" className="h-10 w-10 md:h-8 md:w-8">
                  <MoreHorizontal className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem
                  onClick={() =>
                    copyLink(buildOperatorTerminalRoute({ sandboxId: sandbox.name, dashboardSessionId }), "Terminal link")
                  }
                >
                  Copy terminal link
                </DropdownMenuItem>
                {isOpenClaw && (
                  <DropdownMenuItem
                    onClick={() =>
                      copyLink(`/launch/dashboard?sandboxId=${encodeURIComponent(sandbox.name)}`, "Dashboard link")
                    }
                  >
                    Copy dashboard link
                  </DropdownMenuItem>
                )}
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  className="text-destructive focus:text-destructive"
                  onClick={() => setDeleteOpen(true)}
                >
                  Delete…
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      </div>

      {/* Tabs */}
      <Tabs value={currentTab} onValueChange={setTab}>
        <TabsList className="flex flex-wrap h-auto justify-start">
          {visibleTabs.map((tab) => (
            <TabsTrigger key={tab.key} value={tab.key} className="gap-1.5">
              {tab.label}
              {tab.badge && tab.badge > 0 ? (
                <span className="inline-flex items-center justify-center min-w-4 h-4 rounded-full bg-warning text-black text-[10px] font-mono px-1">
                  {tab.badge}
                </span>
              ) : null}
            </TabsTrigger>
          ))}
        </TabsList>

        <TabsContent value="overview" className="space-y-4">
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            {[
              ["Host CPU", telemetry ? `${telemetry.cpu.toFixed(1)}%` : "—"],
              ["Host MEM", telemetry ? `${telemetry.memory.toFixed(1)}%` : "—"],
              ["Host DISK", telemetry ? `${telemetry.disk.toFixed(1)}%` : "—"],
              ["Updated", telemetry ? new Date(telemetry.timestamp).toLocaleTimeString() : "—"],
            ].map(([label, value]) => (
              <Card key={label} className="p-4 space-y-1">
                <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-mono">{label}</p>
                <p className="text-xl font-mono text-primary">{value}</p>
              </Card>
            ))}
          </div>
          <p className="text-[10px] text-muted-foreground">Controller host resources</p>

          <AgentCapabilitiesCard sandbox={sandbox} mcpServers={mcpServers} canManage={can("manageMcp")} />

          {/* Health checks hit an operator-only endpoint (/api/sandbox/<id>/health,
              403 for IdP users) — don't show the broken panel to them. */}
          {me.role === "operator" && <SandboxHealthPanel sandbox={sandbox} />}

          <RuntimeCard
            canRestart={can("restartSandbox")}
            busy={restarting}
            lastResult={lastRestartResult}
            onRestart={handleRestart}
          />

          <Card className="p-4 space-y-2">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Details</h3>
            <DetailField label="Sandbox ID" value={sandbox.id} />
            <DetailField label="Namespace" value={sandbox.namespace} />
            <DetailField label="Host Alias" value={sandbox.sshHostAlias || "N/A"} />
            <DetailField label="Attach Target" value={sandbox.ip} />
            <DetailField label="Agent" value={displaySandboxAgent(sandbox.agent)} />
            <DetailField label="Default" value={sandbox.isDefault ? "yes" : "no"} />
          </Card>
        </TabsContent>

        {(isOpenClaw || isHermes) && me.role === "operator" && (
          <TabsContent value="access" className="space-y-4">
            {isHermes ? (
              <HermesRemotePanel sandboxName={sandbox.name} />
            ) : (
              <OpenClawRemotePanel sandboxName={sandbox.name} />
            )}
            <ShareLinksCard sandbox={sandbox} dashboardSessionId={dashboardSessionId} />
          </TabsContent>
        )}

        {can("manageFiles") && (
          <TabsContent value="files">
            <SandboxFilesPanel sandbox={sandbox} embedded showHeader={false} />
          </TabsContent>
        )}

        {can("manageInference") && (
          <TabsContent value="inference">
            <SandboxInferencePanel sandbox={sandbox} embedded showHeader={false} />
          </TabsContent>
        )}

        {can("manageMcp") && (
          <TabsContent value="mcp">
            <SandboxMcpAccess sandbox={sandbox} />
          </TabsContent>
        )}

        {can("approvePermissions") && (
          <TabsContent value="policy" className="space-y-4">
            <SandboxPolicyRequests sandbox={sandbox} feed={feed} />
            <ConfigurationPanel sandboxId={sandbox.id} mode="existing" embedded showHeader={false} />
          </TabsContent>
        )}

        {can("backupRestore") && (
          <TabsContent value="backup">
            <SandboxArchivePanel sandbox={sandbox} onRestoreComplete={() => { refetch() }} />
          </TabsContent>
        )}

        {/* OpenClaw only: Hermes `shields up` is broken in NemoClaw
            v0.0.73 — the config-lock step reverts the config parent dir
            to 755 root:root while its own verify demands 1775 root:sandbox
            ("Config not locked: parent dir mode=755 (expected 1775)"),
            and it can't be pre-fixed (the lock reverts manual perms) or
            rebuilt away (fresh sandboxes fail identically). Re-enable for
            Hermes once NemoClaw fixes it. */}
        {isOpenClaw && can("manageShields") && (
          <TabsContent value="shields">
            <ShieldsPanel sandboxName={sandbox.name} />
          </TabsContent>
        )}
      </Tabs>

      <DeleteSandboxDialog
        sandbox={deleteOpen ? sandbox : null}
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        onCurrentPage
      />
    </>
  )
}

export default function SandboxDetailPage({ params }: { params: Promise<{ name: string }> }) {
  const { name } = use(params)
  const decoded = decodeURIComponent(name)
  return (
    <Suspense fallback={<Skeleton className="h-64 w-full" />}>
      <SandboxDetailInner name={decoded} />
    </Suspense>
  )
}
