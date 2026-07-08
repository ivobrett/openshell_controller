"use client"
import { useCallback, useEffect, useState } from "react"
import { Button } from "@/app/components/ui/button"
import { Input } from "@/app/components/ui/input"
import { Alert, AlertDescription } from "@/app/components/ui/alert"
import { Badge } from "@/app/components/ui/badge"

type ShieldsStatus = {
  available: boolean
  posture: "up" | "down" | "not_configured" | "unknown"
  since: string | null
  autoLockIn: string | null
  restoreAt: string | null
  reason: string | null
  policy: string | null
  raw: string
  error: string | null
}

type ShieldsAuditEvent = {
  action: string
  sandbox: string
  timestamp: string
  reason?: string | null
  timeout_seconds?: number
  restored_by?: string
  duration_seconds?: number
}

type FetchState =
  | { status: "loading" }
  | { status: "ready"; shields: ShieldsStatus; audit: ShieldsAuditEvent[] }
  | { status: "error"; message: string }

const DOWN_DURATIONS = [
  { value: "5m", label: "5 minutes (default)" },
  { value: "15m", label: "15 minutes" },
  { value: "30m", label: "30 minutes" },
  { value: "1h", label: "1 hour" },
]

function postureBadge(posture: ShieldsStatus["posture"]) {
  switch (posture) {
    case "up":
      return { label: "SHIELDS UP", className: "text-primary border-primary" }
    case "down":
      return { label: "SHIELDS DOWN", className: "text-warning border-warning" }
    case "not_configured":
      return { label: "NOT CONFIGURED", className: "text-muted-foreground border-muted-foreground" }
    default:
      return { label: "UNKNOWN", className: "text-muted-foreground border-muted-foreground" }
  }
}

function auditLine(event: ShieldsAuditEvent) {
  const when = new Date(event.timestamp).toLocaleString()
  switch (event.action) {
    case "shields_up":
      return `${when} — shields up${event.restored_by ? ` (${event.restored_by})` : ""}`
    case "shields_down":
      return `${when} — shields down${event.timeout_seconds ? ` for ${Math.round(event.timeout_seconds / 60)}m` : ""}${event.reason ? ` — ${event.reason}` : ""}`
    case "shields_auto_restore":
      return `${when} — auto-relocked (timer)`
    default:
      return `${when} — ${event.action}`
  }
}

export default function ShieldsPanel({ sandboxName }: { sandboxName: string }) {
  const [state, setState] = useState<FetchState>({ status: "loading" })
  const [acting, setActing] = useState<null | "up" | "down">(null)
  const [downTimeout, setDownTimeout] = useState("5m")
  const [downReason, setDownReason] = useState("")
  const [actionError, setActionError] = useState<string | null>(null)
  // Changing shields posture is operator-only (shields down applies a
  // permissive sandbox policy). OAuth users get a read-only view.
  const [isAdmin, setIsAdmin] = useState<boolean>(false)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const res = await fetch("/api/auth/me")
        const data = await res.json()
        // operator session, or auth not configured (single-operator dev mode)
        if (!cancelled) setIsAdmin(Boolean(data?.operator) || data?.configured === false)
      } catch {
        if (!cancelled) setIsAdmin(false)
      }
    })()
    return () => { cancelled = true }
  }, [])

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/sandbox/${encodeURIComponent(sandboxName)}/shields`)
      const data = await res.json()
      if (!res.ok || !data?.shields) {
        setState({ status: "error", message: data?.error || `Request failed (${res.status})` })
        return
      }
      setState({ status: "ready", shields: data.shields, audit: data.audit ?? [] })
    } catch (error) {
      setState({ status: "error", message: error instanceof Error ? error.message : "Failed to load shields status" })
    }
  }, [sandboxName])

  useEffect(() => {
    setActionError(null)
    void load()
  }, [load])

  // While shields are down, poll so the panel catches the auto-relock.
  useEffect(() => {
    if (state.status !== "ready" || state.shields.posture !== "down") return
    const interval = setInterval(() => void load(), 30000)
    return () => clearInterval(interval)
  }, [state, load])

  const act = async (action: "up" | "down") => {
    setActing(action)
    setActionError(null)
    try {
      const body: Record<string, string> = { action }
      if (action === "down") {
        body.timeout = downTimeout
        if (downReason.trim()) body.reason = downReason.trim()
      }
      const res = await fetch(`/api/sandbox/${encodeURIComponent(sandboxName)}/shields`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })
      const data = await res.json()
      if (!res.ok) {
        setActionError(data?.error || `shields ${action} failed (${res.status})`)
      } else if (data?.shields) {
        setState({ status: "ready", shields: data.shields, audit: data.audit ?? [] })
        setDownReason("")
      }
    } catch (error) {
      setActionError(error instanceof Error ? error.message : `shields ${action} failed`)
    } finally {
      setActing(null)
    }
  }

  if (state.status === "loading") {
    return <p className="text-sm text-muted-foreground">Checking shields status…</p>
  }

  if (state.status === "error") {
    return (
      <div className="space-y-2">
        <Alert variant="destructive">
          <AlertDescription className="text-xs">{state.message}</AlertDescription>
        </Alert>
        <Button variant="outline" size="sm" onClick={() => void load()}>Retry</Button>
      </div>
    )
  }

  const { shields, audit } = state
  const badge = postureBadge(shields.posture)
  const locked = shields.posture === "up"

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <Badge variant="outline" className={`font-mono text-[10px] tracking-wider ${badge.className}`}>
          {badge.label}
        </Badge>
        {shields.posture === "down" && (
          <span className="text-xs text-warning font-mono">
            auto-relock {shields.autoLockIn ? `in ${shields.autoLockIn}` : shields.restoreAt ? `at ${new Date(shields.restoreAt).toLocaleTimeString()}` : "pending"}
          </span>
        )}
        <Button variant="ghost" size="sm" onClick={() => void load()} className="ml-auto h-7 px-2">Refresh</Button>
      </div>

      <p className="text-xs text-muted-foreground leading-relaxed">
        {locked
          ? "Agent config is locked at the OS level (root-owned, read-only) under a restrictive policy. Config editing is disabled while shields are up."
          : shields.posture === "down"
            ? "Config is temporarily unlocked and a PERMISSIVE sandbox policy is active. Shields auto-relock when the window expires — the window cannot be extended by another shields-down."
            : "Default mutable state. Raise shields to lock the agent config for sensitive workloads."}
      </p>

      {shields.posture === "down" && shields.reason && (
        <p className="text-xs text-muted-foreground">Reason: {shields.reason}</p>
      )}

      {actionError && (
        <Alert variant="destructive">
          <AlertDescription className="text-xs">{actionError}</AlertDescription>
        </Alert>
      )}

      {!isAdmin ? (
        <p className="text-xs text-muted-foreground italic">
          Only the operator (admin) can raise or lower shields.
        </p>
      ) : locked ? (
        <div className="space-y-2">
          <div className="flex items-center gap-2 flex-wrap">
            <select
              value={downTimeout}
              onChange={(e) => setDownTimeout(e.target.value)}
              className="rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
            >
              {DOWN_DURATIONS.map((d) => (
                <option key={d.value} value={d.value}>{d.label}</option>
              ))}
            </select>
            <Input
              value={downReason}
              onChange={(e) => setDownReason(e.target.value)}
              placeholder="Reason (recorded in audit log)"
              maxLength={200}
              className="flex-1 min-w-[200px]"
            />
            <Button variant="outline" size="sm" onClick={() => void act("down")} disabled={acting !== null}>
              {acting === "down" ? "Lowering…" : "Shields Down"}
            </Button>
          </div>
        </div>
      ) : (
        <Button variant="outline" size="sm" onClick={() => void act("up")} disabled={acting !== null}>
          {acting === "up" ? "Raising…" : "Shields Up"}
        </Button>
      )}

      {audit.length > 0 && (
        <div>
          <p className="text-[10px] text-muted-foreground uppercase tracking-wider mb-1">Audit trail</p>
          <ul className="space-y-1 max-h-40 overflow-y-auto">
            {audit.map((event, index) => (
              <li key={`${event.timestamp}-${index}`} className="text-xs font-mono text-muted-foreground">
                {auditLine(event)}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
