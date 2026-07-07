"use client"
import { useCallback, useEffect, useState } from 'react'

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
  | { status: 'loading' }
  | { status: 'unconfigured' }
  | { status: 'ready'; access: OpenClawRemoteAccess; healthy: boolean | null }
  | { status: 'error'; message: string }

type PairingRequest = {
  requestId: string
  role?: string
  label?: string
  scopes?: string[]
  createdAt?: string
}

type PairingState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; requests: PairingRequest[]; raw: string }
  | { status: 'done'; message: string }
  | { status: 'error'; message: string }

export default function OpenClawRemotePanel({ sandboxName }: { sandboxName: string }) {
  const [state, setState] = useState<FetchState>({ status: 'loading' })
  const [tokenRevealed, setTokenRevealed] = useState(false)
  const [copied, setCopied] = useState<string | null>(null)
  const [enabling, setEnabling] = useState(false)
  const [pairing, setPairing] = useState<PairingState>({ status: 'idle' })
  const [approving, setApproving] = useState(false)
  const [qr, setQr] = useState<
    | { status: 'idle' }
    | { status: 'loading' }
    | { status: 'ready'; setupCode: string; qrDataUrl: string }
    | { status: 'error'; message: string }
  >({ status: 'idle' })

  const generateQr = useCallback(async () => {
    setQr({ status: 'loading' })
    try {
      const res = await fetch(`/api/sandbox/${encodeURIComponent(sandboxName)}/openclaw-remote/qr`, { method: 'POST' })
      const data = await res.json()
      if (!res.ok || !data?.setupCode) {
        setQr({ status: 'error', message: data?.error || `QR failed (${res.status})` })
        return
      }
      setQr({ status: 'ready', setupCode: data.setupCode, qrDataUrl: typeof data.qrDataUrl === 'string' ? data.qrDataUrl : '' })
    } catch (error) {
      setQr({ status: 'error', message: error instanceof Error ? error.message : 'QR generation failed' })
    }
  }, [sandboxName])

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/sandbox/${encodeURIComponent(sandboxName)}/openclaw-remote`)
      if (res.status === 404) {
        setState({ status: 'unconfigured' })
        return
      }
      const data = await res.json()
      if (!res.ok || !data?.access) {
        setState({ status: 'error', message: data?.error || `Request failed (${res.status})` })
        return
      }
      // Reachability is determined server-side (the route probes the gateway —
      // a browser fetch to the per-sandbox subdomain would be CORS-blocked).
      setState({
        status: 'ready',
        access: data.access,
        healthy: typeof data.reachable === 'boolean' ? data.reachable : null,
      })
    } catch (error) {
      setState({ status: 'error', message: error instanceof Error ? error.message : 'Failed to load remote access' })
    }
  }, [sandboxName])

  useEffect(() => {
    setTokenRevealed(false)
    void load()
  }, [load])

  const enable = async () => {
    setEnabling(true)
    try {
      const res = await fetch(`/api/sandbox/${encodeURIComponent(sandboxName)}/openclaw-remote`, { method: 'POST' })
      const data = await res.json()
      if (!res.ok) {
        setState({ status: 'error', message: data?.error || `Enable failed (${res.status})` })
        return
      }
      await load()
    } catch (error) {
      setState({ status: 'error', message: error instanceof Error ? error.message : 'Enable failed' })
    } finally {
      setEnabling(false)
    }
  }

  const loadPairing = useCallback(async () => {
    setPairing({ status: 'loading' })
    try {
      const res = await fetch(`/api/sandbox/${encodeURIComponent(sandboxName)}/openclaw-remote/pairing`)
      const data = await res.json()
      if (!res.ok) {
        setPairing({ status: 'error', message: data?.error || `Request failed (${res.status})` })
        return
      }
      setPairing({ status: 'ready', requests: Array.isArray(data?.requests) ? data.requests : [], raw: typeof data?.raw === 'string' ? data.raw : '' })
    } catch (error) {
      setPairing({ status: 'error', message: error instanceof Error ? error.message : 'Failed to list pairing requests' })
    }
  }, [sandboxName])

  const approve = async (requestId?: string) => {
    setApproving(true)
    try {
      const res = await fetch(`/api/sandbox/${encodeURIComponent(sandboxName)}/openclaw-remote/pairing`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestId ? { requestId } : {}),
      })
      const data = await res.json()
      if (!res.ok) {
        setPairing({ status: 'error', message: data?.error || `Approve failed (${res.status})` })
        return
      }
      setPairing({ status: 'done', message: data?.output || 'Pairing approved.' })
    } catch (error) {
      setPairing({ status: 'error', message: error instanceof Error ? error.message : 'Approve failed' })
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

  if (state.status === 'loading') {
    return <p className="text-xs text-[var(--foreground-dim)]">Loading mobile-app gateway access…</p>
  }

  if (state.status === 'unconfigured') {
    return (
      <div className="space-y-3">
        <p className="text-xs text-[var(--foreground-dim)]">
          This OpenClaw sandbox is not yet exposed for the OpenClaw mobile apps.
        </p>
        <button onClick={enable} disabled={enabling} className="action-button px-3 py-2">
          {enabling ? 'Enabling…' : 'Enable mobile-app gateway access'}
        </button>
      </div>
    )
  }

  if (state.status === 'error') {
    return (
      <div className="space-y-3">
        <p className="text-xs text-[var(--status-pending)]">{state.message}</p>
        <button onClick={enable} disabled={enabling} className="action-button px-3 py-2">
          {enabling ? 'Retrying…' : 'Retry exposure'}
        </button>
      </div>
    )
  }

  const { access, healthy } = state
  const maskedToken = `${access.token.slice(0, 4)}…${access.token.slice(-4)}`

  const Row = ({ label, value, copyKey }: { label: string; value: string; copyKey: string }) => (
    <div className="flex items-center gap-2">
      <span className="w-24 shrink-0 text-[var(--foreground-dim)] uppercase tracking-wider">{label}</span>
      <span className="truncate text-[var(--foreground-hex)]">{value}</span>
      <button onClick={() => copy(copyKey, value)} className="action-button px-2 py-1 shrink-0">
        {copied === copyKey ? 'Copied!' : 'Copy'}
      </button>
    </div>
  )

  return (
    <div className="space-y-4">
      <div className="space-y-2 font-mono text-xs">
        <Row label="Host" value={access.host} copyKey="host" />
        <Row label="Port" value={String(access.port)} copyKey="port" />
        <Row label="URL" value={access.url} copyKey="url" />
        <div className="flex items-center gap-2">
          <span className="w-24 shrink-0 text-[var(--foreground-dim)] uppercase tracking-wider">Token</span>
          <span className="truncate text-[var(--foreground-hex)]">{tokenRevealed ? access.token : maskedToken}</span>
          <button onClick={() => setTokenRevealed((v) => !v)} className="action-button px-2 py-1 shrink-0">
            {tokenRevealed ? 'Hide' : 'Reveal'}
          </button>
          <button onClick={() => copy('token', access.token)} className="action-button px-2 py-1 shrink-0">
            {copied === 'token' ? 'Copied!' : 'Copy'}
          </button>
        </div>
        <div className="flex items-center gap-2">
          <span className="w-24 shrink-0 text-[var(--foreground-dim)] uppercase tracking-wider">Status</span>
          {healthy === null ? (
            <span className="text-[var(--foreground-dim)]">checking…</span>
          ) : healthy ? (
            <span className="text-[var(--status-running)]">● Reachable</span>
          ) : (
            <span className="text-[var(--status-pending)]">● Unreachable — try “Retry exposure” below</span>
          )}
        </div>
      </div>

      <div className="rounded-sm border border-[var(--border-subtle)] bg-[var(--background-tertiary)] p-3 text-xs text-[var(--foreground-dim)]">
        <div className="flex items-center justify-between gap-2">
          <p className="font-semibold uppercase tracking-wider text-[var(--foreground-hex)]">OpenClaw mobile app — pair by QR</p>
          <button onClick={() => void generateQr()} disabled={qr.status === 'loading'} className="action-button px-2 py-1">
            {qr.status === 'loading' ? 'Generating…' : qr.status === 'ready' ? 'Regenerate QR' : 'Generate QR'}
          </button>
        </div>
        <ol className="mt-2 list-decimal space-y-1 pl-4">
          <li>Tap <span className="font-mono">Generate QR</span> → open the app → <span className="font-mono">Scan QR / add via setup code</span></li>
          <li>Scan the code below (the bootstrap token auto-approves device pairing — no manual step)</li>
          <li>The app then requests node capabilities → approve it under <span className="font-mono">Node approval</span> below</li>
        </ol>

        {qr.status === 'ready' && (
          <div className="mt-3 space-y-2">
            {qr.qrDataUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={qr.qrDataUrl} alt="OpenClaw pairing QR" className="rounded-sm bg-white p-2" width={220} height={220} />
            ) : null}
            <div className="flex items-center gap-2">
              <span className="w-24 shrink-0 uppercase tracking-wider">Setup code</span>
              <span className="truncate font-mono text-[var(--foreground-hex)]">{qr.setupCode.slice(0, 16)}…</span>
              <button onClick={() => copy('setup', qr.setupCode)} className="action-button px-2 py-1 shrink-0">
                {copied === 'setup' ? 'Copied!' : 'Copy'}
              </button>
            </div>
            <p className="text-[var(--foreground-dim)]">Short-lived — regenerate if it expires before you scan.</p>
          </div>
        )}
        {qr.status === 'error' && <p className="mt-2 text-[var(--status-pending)]">{qr.message}</p>}

        <details className="mt-3">
          <summary className="cursor-pointer text-[var(--foreground-dim)]">Manual setup (no QR)</summary>
          <ol className="mt-2 list-decimal space-y-1 pl-4">
            <li>App → <span className="font-mono">Connect</span> → <span className="font-mono">Manual / Advanced</span></li>
            <li>Host <span className="font-mono">{access.host}</span>, Port <span className="font-mono">{access.port}</span>, <span className="font-mono">wss://</span> on; paste the Token above</li>
            <li>Then approve under <span className="font-mono">Node approval</span> below</li>
          </ol>
        </details>
      </div>

      <div className="rounded-sm border border-[var(--border-subtle)] bg-[var(--background-tertiary)] p-3 text-xs">
        <div className="flex items-center justify-between gap-2">
          <p className="font-semibold uppercase tracking-wider text-[var(--foreground-hex)]">Node approval</p>
          <div className="flex items-center gap-2">
            <button onClick={() => void loadPairing()} disabled={pairing.status === 'loading' || approving} className="action-button px-2 py-1">
              {pairing.status === 'loading' ? 'Checking…' : 'Check pending'}
            </button>
            <button onClick={() => void approve()} disabled={approving} className="action-button px-2 py-1">
              {approving ? 'Approving…' : 'Approve latest'}
            </button>
          </div>
        </div>

        {pairing.status === 'ready' && pairing.requests.length > 0 && (
          <ul className="mt-2 space-y-1">
            {pairing.requests.map((req) => (
              <li key={req.requestId} className="flex items-center gap-2">
                <span className="truncate font-mono text-[var(--foreground-hex)]">
                  {req.label || req.requestId}{req.role ? ` · ${req.role}` : ''}{req.scopes && req.scopes.length ? ` · ${req.scopes.join(',')}` : ''}
                </span>
                <button onClick={() => void approve(req.requestId)} disabled={approving} className="action-button ml-auto shrink-0 px-2 py-1">
                  Approve
                </button>
              </li>
            ))}
          </ul>
        )}

        {pairing.status === 'ready' && pairing.requests.length === 0 && (
          <p className="mt-2 text-[var(--foreground-dim)]">
            No pending node requests{pairing.raw ? '' : ' — scan the QR / open the app first, then Check pending'}.
            {pairing.raw && !pairing.raw.startsWith('[') ? (
              <span className="mt-1 block whitespace-pre-wrap font-mono text-[var(--foreground-dim)]">{pairing.raw}</span>
            ) : null}
          </p>
        )}

        {pairing.status === 'done' && (
          <p className="mt-2 whitespace-pre-wrap font-mono text-[var(--status-running)]">{pairing.message}</p>
        )}

        {pairing.status === 'error' && (
          <p className="mt-2 text-[var(--status-pending)]">{pairing.message}</p>
        )}
      </div>

      {healthy === false && (
        <button onClick={enable} disabled={enabling} className="action-button px-3 py-2">
          {enabling ? 'Repairing…' : 'Retry exposure'}
        </button>
      )}
    </div>
  )
}
