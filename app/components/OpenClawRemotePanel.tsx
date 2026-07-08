"use client"
import { useCallback, useEffect, useState } from "react"
import { Button } from "@/app/components/ui/button"
import { Alert, AlertDescription } from "@/app/components/ui/alert"
import { Card } from "@/app/components/ui/card"

type OpenClawRemoteAccess = {
  sandbox: string
  gatewayPort: number
  hostPort: number
  token: string
  host: string
  port: number
  url: string
  updatedAt: string
}

type FetchState =
  | { status: "loading" }
  | { status: "unconfigured" }
  | { status: "ready"; access: OpenClawRemoteAccess; healthy: boolean | null }
  | { status: "error"; message: string }

type PairingRequest = {
  requestId: string
  role?: string
  label?: string
  scopes?: string[]
  createdAt?: string
}

type PairingState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; requests: PairingRequest[]; raw: string }
  | { status: "done"; message: string }
  | { status: "error"; message: string }

export default function OpenClawRemotePanel({ sandboxName }: { sandboxName: string }) {
  const [state, setState] = useState<FetchState>({ status: "loading" })
  const [tokenRevealed, setTokenRevealed] = useState(false)
  const [copied, setCopied] = useState<string | null>(null)
  const [enabling, setEnabling] = useState(false)
  const [pairing, setPairing] = useState<PairingState>({ status: "idle" })
  const [approving, setApproving] = useState(false)
  const [qr, setQr] = useState<
    | { status: "idle" }
    | { status: "loading" }
    | { status: "ready"; setupCode: string; qrDataUrl: string }
    | { status: "error"; message: string }
  >({ status: "idle" })

  const generateQr = useCallback(async () => {
    setQr({ status: "loading" })
    try {
      const res = await fetch(`/api/sandbox/${encodeURIComponent(sandboxName)}/openclaw-remote/qr`, { method: "POST" })
      const data = await res.json()
      if (!res.ok || !data?.setupCode) {
        setQr({ status: "error", message: data?.error || `QR failed (${res.status})` })
        return
      }
      setQr({ status: "ready", setupCode: data.setupCode, qrDataUrl: typeof data.qrDataUrl === "string" ? data.qrDataUrl : "" })
    } catch (error) {
      setQr({ status: "error", message: error instanceof Error ? error.message : "QR generation failed" })
    }
  }, [sandboxName])

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/sandbox/${encodeURIComponent(sandboxName)}/openclaw-remote`)
      if (res.status === 404) {
        setState({ status: "unconfigured" })
        return
      }
      const data = await res.json()
      if (!res.ok || !data?.access) {
        setState({ status: "error", message: data?.error || `Request failed (${res.status})` })
        return
      }
      // Reachability is determined server-side (the route probes the gateway —
      // a browser fetch to the per-sandbox subdomain would be CORS-blocked).
      setState({
        status: "ready",
        access: data.access,
        healthy: typeof data.reachable === "boolean" ? data.reachable : null,
      })
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
      const res = await fetch(`/api/sandbox/${encodeURIComponent(sandboxName)}/openclaw-remote`, { method: "POST" })
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

  const loadPairing = useCallback(async () => {
    setPairing({ status: "loading" })
    try {
      const res = await fetch(`/api/sandbox/${encodeURIComponent(sandboxName)}/openclaw-remote/pairing`)
      const data = await res.json()
      if (!res.ok) {
        setPairing({ status: "error", message: data?.error || `Request failed (${res.status})` })
        return
      }
      setPairing({ status: "ready", requests: Array.isArray(data?.requests) ? data.requests : [], raw: typeof data?.raw === "string" ? data.raw : "" })
    } catch (error) {
      setPairing({ status: "error", message: error instanceof Error ? error.message : "Failed to list pairing requests" })
    }
  }, [sandboxName])

  const approve = async (requestId?: string) => {
    setApproving(true)
    try {
      const res = await fetch(`/api/sandbox/${encodeURIComponent(sandboxName)}/openclaw-remote/pairing`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(requestId ? { requestId } : {}),
      })
      const data = await res.json()
      if (!res.ok) {
        setPairing({ status: "error", message: data?.error || `Approve failed (${res.status})` })
        return
      }
      setPairing({ status: "done", message: data?.output || "Pairing approved." })
    } catch (error) {
      setPairing({ status: "error", message: error instanceof Error ? error.message : "Approve failed" })
    } finally {
      setApproving(false)
    }
  }

  const copy = async (label: string, value: string) => {
    try {
      await navigator.clipboard.writeText(value)
      setCopied(label)
      window.setTimeout(() => setCopied((current) => (current === label ? null : current)), 1800)
    } catch {
      // Clipboard unavailable; the value is visible for manual copy.
    }
  }

  if (state.status === "loading") {
    return <p className="text-xs text-muted-foreground">Loading mobile-app gateway access…</p>
  }

  if (state.status === "unconfigured") {
    return (
      <div className="space-y-3">
        <p className="text-xs text-muted-foreground">
          This OpenClaw sandbox is not yet exposed for the OpenClaw mobile apps.
        </p>
        <Button variant="outline" size="sm" onClick={enable} disabled={enabling}>
          {enabling ? "Enabling…" : "Enable mobile-app gateway access"}
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
          {enabling ? "Retrying…" : "Retry exposure"}
        </Button>
      </div>
    )
  }

  const { access, healthy } = state
  const maskedToken = `${access.token.slice(0, 4)}…${access.token.slice(-4)}`

  const Row = ({ label, value, copyKey }: { label: string; value: string; copyKey: string }) => (
    <div className="flex items-center gap-2">
      <span className="w-24 shrink-0 text-muted-foreground uppercase tracking-wider">{label}</span>
      <span className="truncate">{value}</span>
      <Button variant="ghost" size="sm" onClick={() => copy(copyKey, value)} className="shrink-0 h-6 px-2">
        {copied === copyKey ? "Copied!" : "Copy"}
      </Button>
    </div>
  )

  return (
    <div className="space-y-4">
      <div className="space-y-2 font-mono text-xs">
        <Row label="Host" value={access.host} copyKey="host" />
        <Row label="Port" value={String(access.port)} copyKey="port" />
        <Row label="URL" value={access.url} copyKey="url" />
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
        </div>
      </div>

      <Card className="p-3 text-xs space-y-3">
        <div className="flex items-center justify-between gap-2">
          <p className="font-semibold uppercase tracking-wider">OpenClaw mobile app — pair by QR</p>
          <Button variant="outline" size="sm" onClick={() => void generateQr()} disabled={qr.status === "loading"} className="h-7">
            {qr.status === "loading" ? "Generating…" : qr.status === "ready" ? "Regenerate QR" : "Generate QR"}
          </Button>
        </div>
        <ol className="list-decimal space-y-1 pl-4 text-muted-foreground">
          <li>Tap <span className="font-mono">Generate QR</span> → open the app → <span className="font-mono">Scan QR / add via setup code</span></li>
          <li>Scan the code below (the bootstrap token auto-approves device pairing — no manual step)</li>
          <li>The app then requests node capabilities → approve it under <span className="font-mono">Node approval</span> below</li>
        </ol>

        {qr.status === "ready" && (
          <div className="space-y-2">
            {qr.qrDataUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={qr.qrDataUrl} alt="OpenClaw pairing QR" className="rounded bg-white p-2" width={220} height={220} />
            ) : null}
            <div className="flex items-center gap-2">
              <span className="w-24 shrink-0 uppercase tracking-wider text-muted-foreground">Setup code</span>
              <span className="truncate font-mono">{qr.setupCode.slice(0, 16)}…</span>
              <Button variant="ghost" size="sm" onClick={() => copy("setup", qr.setupCode)} className="shrink-0 h-6 px-2">
                {copied === "setup" ? "Copied!" : "Copy"}
              </Button>
            </div>
            <p className="text-muted-foreground">Short-lived — regenerate if it expires before you scan.</p>
          </div>
        )}
        {qr.status === "error" && (
          <p className="text-destructive text-xs">{qr.message}</p>
        )}

        <details>
          <summary className="cursor-pointer text-muted-foreground">Manual setup (no QR)</summary>
          <ol className="mt-2 list-decimal space-y-1 pl-4 text-muted-foreground">
            <li>App → <span className="font-mono">Connect</span> → <span className="font-mono">Manual / Advanced</span></li>
            <li>Host <span className="font-mono">{access.host}</span>, Port <span className="font-mono">{access.port}</span>, <span className="font-mono">wss://</span> on; paste the Token above</li>
            <li>Then approve under <span className="font-mono">Node approval</span> below</li>
          </ol>
        </details>
      </Card>

      <Card className="p-3 text-xs space-y-2">
        <div className="flex items-center justify-between gap-2">
          <p className="font-semibold uppercase tracking-wider">Node approval</p>
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" onClick={() => void loadPairing()} disabled={pairing.status === "loading" || approving} className="h-7">
              {pairing.status === "loading" ? "Checking…" : "Check pending"}
            </Button>
            <Button variant="outline" size="sm" onClick={() => void approve()} disabled={approving} className="h-7">
              {approving ? "Approving…" : "Approve latest"}
            </Button>
          </div>
        </div>

        {pairing.status === "ready" && pairing.requests.length > 0 && (
          <ul className="space-y-1">
            {pairing.requests.map((req) => (
              <li key={req.requestId} className="flex items-center gap-2">
                <span className="truncate font-mono">
                  {req.label || req.requestId}{req.role ? ` · ${req.role}` : ""}{req.scopes && req.scopes.length ? ` · ${req.scopes.join(",")}` : ""}
                </span>
                <Button variant="outline" size="sm" onClick={() => void approve(req.requestId)} disabled={approving} className="ml-auto shrink-0 h-6">
                  Approve
                </Button>
              </li>
            ))}
          </ul>
        )}

        {pairing.status === "ready" && pairing.requests.length === 0 && (
          <p className="text-muted-foreground">
            No pending node requests{pairing.raw ? "" : " — scan the QR / open the app first, then Check pending"}.
            {pairing.raw && !pairing.raw.startsWith("[") ? (
              <span className="mt-1 block whitespace-pre-wrap font-mono text-muted-foreground">{pairing.raw}</span>
            ) : null}
          </p>
        )}

        {pairing.status === "done" && (
          <p className="whitespace-pre-wrap font-mono text-primary">{pairing.message}</p>
        )}

        {pairing.status === "error" && (
          <p className="text-muted-foreground">{pairing.message}</p>
        )}
      </Card>

      {healthy === false && (
        <Button variant="outline" size="sm" onClick={enable} disabled={enabling}>
          {enabling ? "Repairing…" : "Retry exposure"}
        </Button>
      )}
    </div>
  )
}
