"use client"

import { useEffect, useState, Suspense } from "react"
import { useSearchParams, useRouter } from "next/navigation"
import Link from "next/link"
import { toast } from "sonner"
import { Card } from "@/app/components/ui/card"
import { Button } from "@/app/components/ui/button"
import { Alert, AlertDescription } from "@/app/components/ui/alert"
import { PageHeader } from "@/app/components/PageHeader"
import { StatusLed } from "@/app/components/StatusLed"
import { SandboxTable } from "@/app/components/sandbox/SandboxTable"
import { GatewayRepairButton } from "@/app/components/GatewayRepairButton"
import LiveTelemetryBar from "@/app/components/LiveTelemetryBar"
import { useInventory, useActivity, usePermissionFeeds } from "@/app/hooks/queries"
import { loadDismissedPermissionAlerts } from "@/app/lib/permissionAlerts"
import { relativeTime } from "@/app/lib/format"
import { useAuth } from "@/app/components/providers/AuthProvider"
import { createHydrationSafeDashboardSessionState, loadDashboardSessionState } from "@/app/lib/dashboardSession"

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

function ActivityDot({ status }: { status?: string }) {
  const cls =
    status === "success"
      ? "bg-success"
      : status === "error"
        ? "bg-destructive"
        : status === "warning"
          ? "bg-warning"
          : "bg-muted-foreground"
  return <span className={`inline-block h-1.5 w-1.5 rounded-full shrink-0 ${cls}`} />
}

export default function DashboardPage() {
  const { me, can } = useAuth()
  const { sandboxes, nemoclaw, isLoading, error, refetch, awaitingFirstSandbox } = useInventory()
  const activityQuery = useActivity(5)
  const recentActivity = can("viewActivity") ? (activityQuery.data ?? []).slice(0, 5) : []

  const approvalSandboxes = can("approvePermissions") ? sandboxes : []
  const feedQuery = usePermissionFeeds(approvalSandboxes)
  const feeds = feedQuery.data ?? {}
  const dismissedAlerts = loadDismissedPermissionAlerts()

  const [dashboardSessionId, setDashboardSessionId] = useState(
    () => createHydrationSafeDashboardSessionState().dashboardSessionId,
  )
  const [telemetryBarEnabled, setTelemetryBarEnabled] = useState(false)

  useEffect(() => {
    const s = loadDashboardSessionState()
    setDashboardSessionId(s.dashboardSessionId)
    setTelemetryBarEnabled(window.localStorage.getItem(TELEMETRY_BAR_ENABLED_KEY) === "true")
  }, [])

  const running = sandboxes.filter((s) => s.status === "running" && s.ready).length
  const total = sandboxes.length
  const needsAction = can("approvePermissions")
    ? sandboxes.reduce((n, s) => {
        const feed = feeds[s.id]
        const pending = (feed?.pending || []).filter(
          (r) => !dismissedAlerts[s.id]?.includes(r.chunkId),
        ).length
        return n + pending
      }, 0)
    : 0

  const gatewayAvailable = nemoclaw?.available ?? false

  const headerDesc = isLoading
    ? "Loading…"
    : total > 0
      ? `${running} running · ${total} total · gateway ${gatewayAvailable ? "available" : "not detected"}`
      : `Gateway ${gatewayAvailable ? "available" : "not detected"}`

  return (
    <>
      <Suspense>
        <DeniedToast />
      </Suspense>

      {telemetryBarEnabled && <LiveTelemetryBar />}

      <PageHeader
        title="Sandboxes"
        description={headerDesc}
        actions={
          can("createSandbox") ? (
            <Button asChild>
              <Link href="/sandboxes/new">New sandbox</Link>
            </Button>
          ) : undefined
        }
      />

      {/* Stat cards */}
      <div className="grid grid-cols-2 gap-3 mb-6 lg:grid-cols-4">
        <Card className="p-4 space-y-1">
          <p className="text-xs text-muted-foreground uppercase tracking-wider font-mono">Total</p>
          <p className="text-2xl font-semibold font-mono">{total}</p>
        </Card>
        <Card className="p-4 space-y-1">
          <p className="text-xs text-muted-foreground uppercase tracking-wider font-mono">Running</p>
          <div className="flex items-center gap-2">
            <StatusLed status={running > 0 ? "running" : "stopped"} ready={running > 0} dotOnly />
            <p className="text-2xl font-semibold font-mono">{running}</p>
          </div>
        </Card>
        {can("approvePermissions") && (
          <Card className="p-4 space-y-1">
            <p className="text-xs text-muted-foreground uppercase tracking-wider font-mono">Needs action</p>
            <p className={`text-2xl font-semibold font-mono ${needsAction > 0 ? "text-warning" : ""}`}>
              {needsAction}
            </p>
          </Card>
        )}
        {me.role === "operator" && (
          <Card className="p-4 space-y-1">
            <p className="text-xs text-muted-foreground uppercase tracking-wider font-mono">Gateway</p>
            <div className="flex items-center gap-2">
              <StatusLed status={gatewayAvailable ? "running" : "stopped"} ready={gatewayAvailable} dotOnly />
              <p className="text-xs font-mono">{gatewayAvailable ? "available" : "not detected"}</p>
            </div>
          </Card>
        )}
        {/* IdP users don't get the approvals/gateway cards (operator-only), so
            fill their two slots with account/access info to keep the grid even. */}
        {me.role === "user" && (
          <>
            <Card className="p-4 space-y-1">
              <p className="text-xs text-muted-foreground uppercase tracking-wider font-mono">Account</p>
              <p className="text-sm font-mono truncate" title={me.email ?? undefined}>{me.email ?? "—"}</p>
              <p className="text-[10px] text-muted-foreground">Signed in via IdP</p>
            </Card>
            <Card className="p-4 space-y-1">
              <p className="text-xs text-muted-foreground uppercase tracking-wider font-mono">Access</p>
              <p className="text-sm">Terminal &amp; dashboard</p>
              <p className="text-[10px] text-muted-foreground">On your granted sandboxes — ask your operator to grant more.</p>
            </Card>
          </>
        )}
      </div>

      {/* Error state (no data ever loaded) */}
      {error && (
        <Alert variant="destructive" className="mb-6" data-testid="inventory-error-state">
          <AlertDescription className="space-y-3">
            <p className="font-mono text-xs">{error}</p>
            <div className="flex gap-2">
              <Button size="sm" variant="outline" onClick={() => refetch()}>
                Retry
              </Button>
              {me.role === "operator" && <GatewayRepairButton />}
            </div>
          </AlertDescription>
        </Alert>
      )}

      {/* Main content: table + recent activity */}
      <div className="xl:flex xl:gap-6">
        {/* Sandbox table */}
        <div className="flex-1 min-w-0">
          {isLoading ? (
            <div className="flex items-center justify-center h-48" data-testid="inventory-loading-state">
              <p className="text-xs font-mono uppercase tracking-wider text-muted-foreground">Initializing…</p>
            </div>
          ) : !error && sandboxes.length === 0 ? (
            <div className="py-16 text-center space-y-3" data-testid="inventory-empty-state">
              <svg className="w-12 h-12 mx-auto text-muted-foreground" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="square" strokeLinejoin="miter" strokeWidth={1.5} d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4" />
              </svg>
              <h3 className="text-sm font-semibold uppercase tracking-wider">No sandboxes yet</h3>
              <p className="text-xs text-muted-foreground">
                {can("createSandbox")
                  ? "Create your first sandbox to get started."
                  : "Ask your operator to grant you access to a sandbox."}
              </p>
              {/*
                Fresh box: the managed NemoClaw gateway does not exist until the
                first `nemoclaw onboard` runs, i.e. until the first sandbox is
                created. Explain that rather than leaving the host looking
                half-broken. See the FRESH-BOX GATEWAY GAP note in
                app/api/telemetry/real/route.ts.
              */}
              {awaitingFirstSandbox && (
                <p className="text-[10px] text-muted-foreground" data-testid="awaiting-first-sandbox-note">
                  The NemoClaw gateway is created automatically with your first sandbox.
                </p>
              )}
              {can("createSandbox") && (
                <Button asChild size="sm">
                  <Link href="/sandboxes/new">New sandbox</Link>
                </Button>
              )}
            </div>
          ) : !error ? (
            <SandboxTable
              sandboxes={sandboxes}
              permissionFeeds={feeds}
              dismissedAlerts={dismissedAlerts}
              dashboardSessionId={dashboardSessionId}
            />
          ) : null}
        </div>

        {/* Recent activity */}
        {can("viewActivity") && (
          <div className="mt-6 xl:mt-0 xl:w-80 shrink-0">
            <Card className="p-4">
              <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3">
                Recent activity
              </h3>
              {recentActivity.length === 0 ? (
                <p className="text-xs text-muted-foreground">No recent activity.</p>
              ) : (
                <ul className="space-y-2.5">
                  {recentActivity.map((entry) => (
                    <li key={entry.id} className="flex items-start gap-2 min-w-0">
                      <ActivityDot status={entry.status} />
                      <div className="min-w-0 flex-1">
                        <p className="text-xs truncate">{entry.message}</p>
                        <p className="text-[10px] font-mono text-muted-foreground">{relativeTime(entry.timestamp)}</p>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
              <div className="mt-3 pt-3 border-t border-border">
                <Link href="/activity" className="text-xs text-muted-foreground hover:text-foreground transition-colors">
                  View all →
                </Link>
              </div>
            </Card>
          </div>
        )}
      </div>
    </>
  )
}
