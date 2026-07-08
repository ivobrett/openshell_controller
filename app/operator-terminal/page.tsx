"use client"

import Link from "next/link"
import { Suspense, useCallback, useEffect, useMemo, useState } from "react"
import { useSearchParams } from "next/navigation"
import "xterm/css/xterm.css"
import { BookOpen, RefreshCw } from "lucide-react"
import { useQuery } from "@tanstack/react-query"
import { apiFetch } from "@/app/lib/apiFetch"
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@/app/components/ui/sheet"
import { Card } from "@/app/components/ui/card"
import { Button } from "@/app/components/ui/button"
import { StatusLed, type LedStatus } from "@/app/components/StatusLed"
import { SkillsQuickList } from "@/app/components/skills/SkillsQuickList"
import { TerminalKeyBar } from "@/app/components/terminal/TerminalKeyBar"
import { useTerminalConnection } from "@/app/hooks/useTerminalConnection"
import { ensureDashboardSessionId, HYDRATION_SAFE_DASHBOARD_SESSION_ID } from "../lib/dashboardSession"

interface ReadinessPodSummary {
  containers?: string[]
  images?: string[]
  runningStatuses?: string[]
  phase?: string
  readyCondition?: string
}

interface ReadinessResponse {
  ok: boolean
  sandboxId?: string
  podExists?: boolean
  podReady?: boolean
  sshReachable?: boolean
  degraded?: boolean
  attach?: {
    alias?: string
    aliasCommand?: string
    fallbackCommand?: string
    loginShellCommand?: string
    shellHint?: string
  }
  pod?: ReadinessPodSummary
  shellProbe?: { ok?: boolean; output?: string; stderr?: string; error?: string }
  note?: string
  error?: string
}

type LoadState = "idle" | "loading" | "ready" | "error"

const FONT_SIZE_KEY = "openshell-control.terminal-font"
const MIN_FONT = 12
const MAX_FONT = 18

const defaultAlias = (sandboxId: string | null) => `ssh openshell-${sandboxId || "my-assistant"}`
const defaultFallback = (sandboxId: string | null) => `ssh openshell-${sandboxId || "my-assistant"}`
const defaultLoginShell = (sandboxId: string | null) =>
  `env PATH=$HOME/.local/bin:$PATH bash -l -c 'ssh openshell-${sandboxId || "my-assistant"}'`
const DEFAULT_SHELL_HINT =
  "If your non-interactive shell misses local tooling, retry from a login shell or prepend PATH=$HOME/.local/bin:$PATH before ssh."

function connectionLed(state: string): { status: LedStatus; label: string } {
  switch (state) {
    case "connected":
      return { status: "running", label: "CONNECTED" }
    case "connecting":
      return { status: "pending", label: "CONNECTING" }
    case "reconnecting":
      return { status: "pending", label: "RECONNECTING" }
    case "ended":
      return { status: "stopped", label: "ENDED" }
    default:
      return { status: "error", label: "DISCONNECTED" }
  }
}

function OperatorTerminalInner() {
  const searchParams = useSearchParams()
  const sandboxId = searchParams.get("sandboxId")
  const requestedDashboardSessionId = searchParams.get("dashboardSessionId")
  const [dashboardSessionId, setDashboardSessionId] = useState(
    () => requestedDashboardSessionId?.trim() || HYDRATION_SAFE_DASHBOARD_SESSION_ID,
  )
  const [state, setState] = useState<LoadState>(sandboxId ? "loading" : "idle")
  const [data, setData] = useState<ReadinessResponse | null>(null)
  const [lastCheckedAt, setLastCheckedAt] = useState<string | null>(null)
  const [copyMessage, setCopyMessage] = useState("")
  const [showRecovery, setShowRecovery] = useState(false)
  const [isFullscreen, setIsFullscreen] = useState(false)
  const [skillsOpen, setSkillsOpen] = useState(false)
  const [coarsePointer, setCoarsePointer] = useState(false)
  const [fontSize, setFontSize] = useState(13)

  useEffect(() => {
    setDashboardSessionId(ensureDashboardSessionId(requestedDashboardSessionId))
  }, [requestedDashboardSessionId])

  useEffect(() => {
    setCoarsePointer(window.matchMedia("(pointer: coarse)").matches)
    const stored = Number(window.localStorage.getItem(FONT_SIZE_KEY))
    if (stored >= MIN_FONT && stored <= MAX_FONT) setFontSize(stored)
  }, [])

  const {
    containerRef,
    state: connState,
    statusText,
    reconnectAttempt,
    exitCode,
    sessionId,
    ctrlLatched,
    startNewSession,
    reconnect,
    sendInput,
    toggleCtrl,
    fit,
  } = useTerminalConnection({ sandboxId, dashboardSessionId, fontSize })

  const changeFont = (delta: number) => {
    setFontSize((current) => {
      const next = Math.min(MAX_FONT, Math.max(MIN_FONT, current + delta))
      window.localStorage.setItem(FONT_SIZE_KEY, String(next))
      return next
    })
  }

  const skillsQuery = useQuery({
    queryKey: ["skills"],
    queryFn: () =>
      apiFetch<{ ok: boolean; skills: { id: string; name: string; description: string; tags: string[]; agents: string }[] }>(
        "/api/skills",
      ),
    staleTime: 60_000,
    select: (d) => d.skills ?? [],
  })

  useEffect(() => {
    if (!isFullscreen) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setIsFullscreen(false)
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [isFullscreen])

  useEffect(() => {
    const id = requestAnimationFrame(() => fit())
    return () => cancelAnimationFrame(id)
  }, [isFullscreen, fit])

  const terminalDescription = sandboxId
    ? "Live operator terminal attached directly to the sandbox shell."
    : "Live operator terminal for host mode, brokered through the dashboard-owned terminal bridge."

  const refreshReadiness = useCallback(async () => {
    if (!sandboxId) {
      setState("idle")
      setData(null)
      return
    }
    setState("loading")
    setCopyMessage("")
    try {
      const response = await fetch(
        `/api/openshell/terminal/readiness?sandboxId=${encodeURIComponent(sandboxId)}`,
        { cache: "no-store" },
      )
      const result: ReadinessResponse = await response.json()
      setData(result)
      setState(response.ok && result.ok ? "ready" : "error")
      setLastCheckedAt(new Date().toLocaleTimeString())
    } catch (error) {
      setData({ ok: false, error: error instanceof Error ? error.message : "Failed to inspect sandbox readiness." })
      setState("error")
      setLastCheckedAt(new Date().toLocaleTimeString())
    }
  }, [sandboxId])

  useEffect(() => {
    refreshReadiness()
  }, [refreshReadiness])

  const readiness = useMemo(() => {
    if (!sandboxId)
      return { status: "pending" as LedStatus, label: "HOST MODE", detail: "No sandbox query was provided. The dashboard terminal stays in host mode and keeps dashboard-session diagnostics for reconnect behavior." }
    if (state === "loading")
      return { status: "pending" as LedStatus, label: "CHECKING READINESS", detail: "Verifying pod metadata and shell reachability." }
    if (state === "ready" && data?.ok && data?.podReady && data?.sshReachable)
      return { status: "running" as LedStatus, label: "LIVE TERMINAL PATH VERIFIED", detail: "The backend confirmed pod readiness and shell reachability, and the dashboard is wired for a live terminal transport." }
    if (state === "ready" && data?.ok && data?.podExists && data?.degraded)
      return { status: "pending" as LedStatus, label: "DEGRADED: POD UP, SHELL UNCONFIRMED", detail: "The pod exists, but the readiness probe did not fully succeed. The live terminal may still connect, but direct SSH remains the stronger fallback." }
    if (state === "ready" && data?.ok && data?.podExists)
      return { status: "running" as LedStatus, label: "READY FOR LIVE TERMINAL", detail: "Pod metadata is present and the dashboard live terminal can attempt a real shell session." }
    return { status: "error" as LedStatus, label: "READINESS CHECK FAILED", detail: "The dashboard could not confirm pod metadata or shell reachability. Use the recovery commands below, then retry." }
  }, [sandboxId, state, data])

  const copyCommand = useCallback(async (command: string) => {
    try {
      await navigator.clipboard.writeText(command)
      setCopyMessage(`Copied: ${command}`)
    } catch {
      setCopyMessage(`Copy failed. Use: ${command}`)
    }
  }, [])

  const aliasCommand = data?.attach?.aliasCommand || defaultAlias(sandboxId)
  const fallbackCommand = data?.attach?.fallbackCommand || defaultFallback(sandboxId)
  const loginShellCommand = data?.attach?.loginShellCommand || defaultLoginShell(sandboxId)
  const shellHint = data?.attach?.shellHint || DEFAULT_SHELL_HINT

  const connLed = connectionLed(connState)

  return (
    <main className="min-h-screen bg-background text-foreground p-6">
      <div className="mx-auto max-w-7xl space-y-5">
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <div>
            <p className="text-[10px] uppercase tracking-[0.25em] text-muted-foreground font-mono">OpenShell Control</p>
            <h1 className="text-xl font-semibold uppercase tracking-wider mt-2">Operator Terminal</h1>
            <p className="mt-2 max-w-2xl text-xs text-muted-foreground">{terminalDescription}</p>
          </div>
          <div className="flex items-center gap-2">
            <Sheet open={skillsOpen} onOpenChange={setSkillsOpen}>
              <SheetTrigger asChild>
                <Button variant="outline" size="sm">
                  <BookOpen className="h-3.5 w-3.5 mr-1.5" />
                  Skills
                </Button>
              </SheetTrigger>
              <SheetContent side={coarsePointer ? "bottom" : "right"} className="w-full sm:w-[420px]">
                <SheetHeader>
                  <SheetTitle className="text-sm uppercase tracking-wider">Skills</SheetTitle>
                </SheetHeader>
                <div className="mt-4">
                  <SkillsQuickList skills={skillsQuery.data ?? []} />
                </div>
              </SheetContent>
            </Sheet>
            <Button asChild variant="secondary" size="sm">
              <Link href="/">Back to Dashboard</Link>
            </Button>
          </div>
        </div>

        {/* Readiness banner */}
        <Card className="px-4 py-3">
          <div className="flex items-center justify-between gap-4 flex-wrap">
            <div className="flex items-center gap-3 min-w-0">
              <span className="text-[10px] uppercase tracking-[0.2em] text-muted-foreground font-mono">Sandbox</span>
              <span className="text-sm font-mono truncate">{sandboxId || "host"}</span>
            </div>
            <div className="flex items-center gap-3 min-w-0">
              <StatusLed status={readiness.status} showLabel={false} dotOnly />
              <span className="text-xs font-mono truncate">{readiness.label}</span>
              {lastCheckedAt && <span className="text-[10px] text-muted-foreground">checked {lastCheckedAt}</span>}
            </div>
          </div>
        </Card>

        {/* Terminal */}
        <section
          className={
            isFullscreen
              ? "fixed inset-0 z-50 bg-background p-4 flex flex-col gap-3"
              : "rounded-lg border border-border bg-card p-6 space-y-4"
          }
        >
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <div className="flex items-center gap-3">
              <h3 className="text-sm font-semibold uppercase tracking-wider">Live Terminal</h3>
              <StatusLed status={connLed.status} showLabel={false} dotOnly />
              <span className="text-[11px] font-mono text-muted-foreground">{connLed.label}</span>
              {isFullscreen && sandboxId && <span className="text-[11px] font-mono text-muted-foreground">/ {sandboxId}</span>}
            </div>
            <div className="flex items-center gap-2">
              <div className="text-[11px] text-muted-foreground font-mono hidden sm:block max-w-[40ch] truncate">{statusText}</div>
              <div className="flex items-center gap-1">
                <Button variant="outline" size="icon" className="h-7 w-7" title="Decrease font size" onClick={() => changeFont(-1)}>
                  A−
                </Button>
                <Button variant="outline" size="icon" className="h-7 w-7" title="Increase font size" onClick={() => changeFont(1)}>
                  A+
                </Button>
              </div>
              <Button
                variant="outline"
                size="icon"
                className="h-7 w-7"
                onClick={() => setIsFullscreen((current) => !current)}
                aria-label={isFullscreen ? "Exit fullscreen" : "Enter fullscreen"}
                title={isFullscreen ? "Exit fullscreen (Esc)" : "Enter fullscreen"}
              >
                {isFullscreen ? (
                  <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="square" strokeLinejoin="miter" aria-hidden="true">
                    <path d="M9 4v5H4 M15 4v5h5 M9 20v-5H4 M15 20v-5h5" />
                  </svg>
                ) : (
                  <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="square" strokeLinejoin="miter" aria-hidden="true">
                    <path d="M4 9V4h5 M20 9V4h-5 M4 15v5h5 M20 15v5h-5" />
                  </svg>
                )}
              </Button>
            </div>
          </div>

          {coarsePointer && (
            <TerminalKeyBar sendInput={sendInput} ctrlLatched={ctrlLatched} onToggleCtrl={toggleCtrl} />
          )}

          <div className={isFullscreen ? "relative rounded-sm border border-border bg-black p-3 flex-1 min-h-0" : "relative rounded-sm border border-border bg-black p-3"}>
            <div ref={containerRef} className={isFullscreen ? "h-full w-full" : "h-[68vh] min-h-[460px] w-full"} />

            {/* Reconnecting overlay — scrollback stays visible underneath. */}
            {connState === "reconnecting" && (
              <div className="absolute inset-0 flex items-center justify-center bg-black/60">
                <div className="flex items-center gap-2 rounded-sm border border-warning/50 bg-card px-4 py-2 text-xs font-mono text-warning">
                  <RefreshCw className="h-3.5 w-3.5 animate-spin" />
                  Reconnecting… attempt {reconnectAttempt}/5
                </div>
              </div>
            )}

            {/* Failed — backoff exhausted. */}
            {connState === "failed" && (
              <div className="absolute inset-0 flex items-center justify-center bg-black/70">
                <div className="flex flex-col items-center gap-3 rounded-sm border border-destructive/50 bg-card px-6 py-4 text-center">
                  <p className="text-xs font-mono text-destructive">Terminal disconnected.</p>
                  <Button size="sm" onClick={reconnect}>Reconnect</Button>
                </div>
              </div>
            )}

            {/* Session ended (clean exit) — green treatment, not an error. */}
            {connState === "ended" && (
              <div className="absolute inset-0 flex items-center justify-center bg-black/70">
                <div className="flex flex-col items-center gap-3 rounded-sm border border-success/50 bg-card px-6 py-4 text-center">
                  <p className="text-xs font-mono text-success">
                    Session ended (exit code {exitCode ?? "unknown"})
                  </p>
                  <Button size="sm" onClick={startNewSession}>Start new session</Button>
                </div>
              </div>
            )}
          </div>

          <div className="flex items-center gap-3 flex-wrap">
            <Button
              variant="outline"
              size="sm"
              onClick={startNewSession}
              disabled={connState === "connecting" || connState === "reconnecting"}
            >
              {connState === "connecting" ? "Connecting…" : "New session"}
            </Button>
            <Button variant="outline" size="sm" onClick={refreshReadiness} disabled={!sandboxId}>
              Refresh readiness
            </Button>
            <Button variant="outline" size="sm" onClick={() => setShowRecovery((current) => !current)}>
              {showRecovery ? "Hide recovery" : "Recovery commands"}
            </Button>
            <span className="text-[11px] text-muted-foreground font-mono">
              {sessionId ? `session ${sessionId.slice(0, 8)}` : "no session"}
            </span>
          </div>
        </section>

        {showRecovery && (
          <Card className="p-6 space-y-5">
            <div>
              <h3 className="text-sm font-semibold uppercase tracking-wider">Recovery Commands</h3>
              <p className="text-xs text-muted-foreground mt-2">{readiness.detail}</p>
            </div>
            <div className="space-y-3">
              <div className="rounded-sm border border-border bg-muted/40 p-4">
                <p className="text-[10px] uppercase tracking-[0.2em] text-muted-foreground font-mono">Preferred attach command</p>
                <code className="block mt-2 text-sm font-mono text-primary break-all">{aliasCommand}</code>
                <Button variant="outline" size="sm" className="mt-3" onClick={() => copyCommand(aliasCommand)}>
                  Copy alias command
                </Button>
              </div>
              <div className="rounded-sm border border-border bg-muted/40 p-4 space-y-3">
                <div>
                  <p className="text-[10px] uppercase tracking-[0.2em] text-muted-foreground font-mono">Fallback if alias or agent config is missing</p>
                  <code className="block mt-2 text-sm font-mono break-all">{fallbackCommand}</code>
                  <p className="text-xs text-muted-foreground mt-2">{shellHint}</p>
                  <Button variant="outline" size="sm" className="mt-3" onClick={() => copyCommand(fallbackCommand)}>
                    Copy fallback command
                  </Button>
                </div>
                <div className="rounded-sm border border-border bg-background p-3">
                  <p className="text-[10px] uppercase tracking-[0.2em] text-muted-foreground font-mono">Login-shell retry for Homebrew/path issues</p>
                  <code className="block mt-2 text-sm font-mono break-all">{loginShellCommand}</code>
                  <Button variant="outline" size="sm" className="mt-3" onClick={() => copyCommand(loginShellCommand)}>
                    Copy login-shell retry
                  </Button>
                </div>
              </div>
            </div>
            {copyMessage && (
              <div className="rounded-sm border border-border bg-muted/40 p-3 text-xs text-muted-foreground">{copyMessage}</div>
            )}
            <p className="text-xs text-muted-foreground">
              For long-running work, run tmux inside the sandbox — the web terminal reattaches to your session on
              reconnect, but a controller restart starts a fresh shell.
            </p>
          </Card>
        )}
      </div>
    </main>
  )
}

export default function OperatorTerminalPage() {
  return (
    <Suspense
      fallback={
        <main className="min-h-screen bg-background text-foreground p-8">
          <div className="mx-auto max-w-6xl">
            <Card className="p-6">Loading operator terminal…</Card>
          </div>
        </main>
      }
    >
      <OperatorTerminalInner />
    </Suspense>
  )
}
