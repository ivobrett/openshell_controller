"use client"
import { useCallback, useEffect, useState } from "react"
import { Button } from "@/app/components/ui/button"
import { Alert, AlertDescription } from "@/app/components/ui/alert"
import { Card } from "@/app/components/ui/card"

type HermesRemoteAccess = {
  sandbox: string
  mode: string
  port: number
  token: string
  url: string
  hermesVersion: string
  updatedAt: string
}

type FetchState =
  | { status: "loading" }
  | { status: "unconfigured"; mode: string }
  | { status: "ready"; access: HermesRemoteAccess; healthy: boolean | null }
  | { status: "error"; message: string }

export default function HermesRemotePanel({ sandboxName }: { sandboxName: string }) {
  const [state, setState] = useState<FetchState>({ status: "loading" })
  const [tokenRevealed, setTokenRevealed] = useState(false)
  const [copied, setCopied] = useState<string | null>(null)
  const [enabling, setEnabling] = useState(false)

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/sandbox/${encodeURIComponent(sandboxName)}/hermes-remote`)
      if (res.status === 404) {
        const data = await res.json().catch(() => ({}))
        setState({ status: "unconfigured", mode: data?.mode || "desktop" })
        return
      }
      const data = await res.json()
      if (!res.ok || !data?.access) {
        setState({ status: "error", message: data?.error || `Request failed (${res.status})` })
        return
      }
      setState({ status: "ready", access: data.access, healthy: null })
      try {
        const probe = await fetch(`${data.access.url}/api/status`, { signal: AbortSignal.timeout(8000) })
        setState({ status: "ready", access: data.access, healthy: probe.ok })
      } catch {
        setState({ status: "ready", access: data.access, healthy: false })
      }
    } catch (error) {
      setState({ status: "error", message: error instanceof Error ? error.message : "Failed to load remote access" })
    }
  }, [sandboxName])

  useEffect(() => {
    setTokenRevealed(false)
    void load()
  }, [load])

  const enable = async () => {
    setEnabling(true)
    try {
      const res = await fetch(`/api/sandbox/${encodeURIComponent(sandboxName)}/hermes-remote`, { method: "POST" })
      const data = await res.json()
      if (!res.ok) {
        setState({ status: "error", message: data?.error || `Enable failed (${res.status})` })
        return
      }
      await load()
    } catch (error) {
      setState({ status: "error", message: error instanceof Error ? error.message : "Enable failed" })
    } finally {
      setEnabling(false)
    }
  }

  const copy = async (label: string, value: string) => {
    try {
      await navigator.clipboard.writeText(value)
      setCopied(label)
      window.setTimeout(() => setCopied((current) => (current === label ? null : current)), 1800)
    } catch {
      // Clipboard unavailable; value visible for manual copy.
    }
  }

  if (state.status === "loading") {
    return <p className="text-xs text-muted-foreground">Loading remote desktop access…</p>
  }

  if (state.status === "unconfigured") {
    if (state.mode === "off") {
      return (
        <p className="text-xs text-muted-foreground">
          Remote desktop exposure is disabled on this deployment (HERMES_REMOTE_MODE=off).
        </p>
      )
    }
    return (
      <div className="space-y-3">
        <p className="text-xs text-muted-foreground">
          This Hermes sandbox is not yet exposed for the Hermes Desktop app.
        </p>
        <Button variant="outline" size="sm" onClick={enable} disabled={enabling}>
          {enabling ? "Enabling… (up to 2 min)" : "Enable remote desktop access"}
        </Button>
      </div>
    )
  }

  if (state.status === "error") {
    return (
      <div className="space-y-3">
        <Alert variant="destructive">
          <AlertDescription className="text-xs">{state.message}</AlertDescription>
        </Alert>
        <Button variant="outline" size="sm" onClick={enable} disabled={enabling}>
          {enabling ? "Retrying… (up to 2 min)" : "Retry exposure"}
        </Button>
      </div>
    )
  }

  const { access, healthy } = state
  const maskedToken = `${access.token.slice(0, 4)}…${access.token.slice(-4)}`

  return (
    <div className="space-y-4">
      <div className="space-y-2 font-mono text-xs">
        <div className="flex items-center gap-2">
          <span className="w-24 shrink-0 text-muted-foreground uppercase tracking-wider">Remote URL</span>
          <span className="truncate">{access.url}</span>
          <Button variant="ghost" size="sm" onClick={() => copy("url", access.url)} className="shrink-0 h-6 px-2">
            {copied === "url" ? "Copied!" : "Copy"}
          </Button>
        </div>
        <div className="flex items-center gap-2">
          <span className="w-24 shrink-0 text-muted-foreground uppercase tracking-wider">Token</span>
          <span className="truncate">{tokenRevealed ? access.token : maskedToken}</span>
          <Button variant="ghost" size="sm" onClick={() => setTokenRevealed((v) => !v)} className="shrink-0 h-6 px-2">
            {tokenRevealed ? "Hide" : "Reveal"}
          </Button>
          <Button variant="ghost" size="sm" onClick={() => copy("token", access.token)} className="shrink-0 h-6 px-2">
            {copied === "token" ? "Copied!" : "Copy"}
          </Button>
        </div>
        <div className="flex items-center gap-2">
          <span className="w-24 shrink-0 text-muted-foreground uppercase tracking-wider">Status</span>
          {healthy === null ? (
            <span className="text-muted-foreground">checking…</span>
          ) : healthy ? (
            <span className="text-primary">● Reachable</span>
          ) : (
            <span className="text-muted-foreground">● Unreachable — try &quot;Retry exposure&quot; below</span>
          )}
          <span className="text-muted-foreground">Backend {access.hermesVersion} · {access.mode} mode</span>
        </div>
      </div>

      <Card className="p-3 text-xs">
        <p className="font-semibold uppercase tracking-wider text-xs">Hermes Desktop setup</p>
        <ol className="mt-2 list-decimal space-y-1 pl-4 text-muted-foreground">
          <li>Settings → Gateway → choose <span className="font-mono">Remote gateway</span></li>
          <li>Paste the Remote URL, wait for the probe, then paste the Session token</li>
          <li>Save and reconnect</li>
        </ol>
        <p className="mt-2 text-muted-foreground">
          The desktop app must run the same Hermes version as the backend ({access.hermesVersion}).
        </p>
      </Card>

      {healthy === false && (
        <Button variant="outline" size="sm" onClick={enable} disabled={enabling}>
          {enabling ? "Repairing… (up to 2 min)" : "Retry exposure"}
        </Button>
      )}
    </div>
  )
}
