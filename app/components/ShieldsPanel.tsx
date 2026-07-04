"use client"
import { useCallback, useEffect, useState } from 'react'

type ShieldsStatus = {
  available: boolean
  posture: 'up' | 'down' | 'not_configured' | 'unknown'
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
  | { status: 'loading' }
  | { status: 'ready'; shields: ShieldsStatus; audit: ShieldsAuditEvent[] }
  | { status: 'error'; message: string }

const DOWN_DURATIONS = [
  { value: '5m', label: '5 minutes (default)' },
  { value: '15m', label: '15 minutes' },
  { value: '30m', label: '30 minutes' },
  { value: '1h', label: '1 hour' },
]

function postureBadge(posture: ShieldsStatus['posture']) {
  switch (posture) {
    case 'up':
      return { label: 'SHIELDS UP', className: 'text-[var(--nvidia-green)] border-[var(--nvidia-green)]' }
    case 'down':
      return { label: 'SHIELDS DOWN', className: 'text-amber-400 border-amber-400' }
    case 'not_configured':
      return { label: 'NOT CONFIGURED', className: 'text-[var(--foreground-dim)] border-[var(--foreground-dim)]' }
    default:
      return { label: 'UNKNOWN', className: 'text-[var(--foreground-dim)] border-[var(--foreground-dim)]' }
  }
}

function auditLine(event: ShieldsAuditEvent) {
  const when = new Date(event.timestamp).toLocaleString()
  switch (event.action) {
    case 'shields_up':
      return `${when} — shields up${event.restored_by ? ` (${event.restored_by})` : ''}`
    case 'shields_down':
      return `${when} — shields down${event.timeout_seconds ? ` for ${Math.round(event.timeout_seconds / 60)}m` : ''}${event.reason ? ` — ${event.reason}` : ''}`
    case 'shields_auto_restore':
      return `${when} — auto-relocked (timer)`
    default:
      return `${when} — ${event.action}`
  }
}

export default function ShieldsPanel({ sandboxName }: { sandboxName: string }) {
  const [state, setState] = useState<FetchState>({ status: 'loading' })
  const [acting, setActing] = useState<null | 'up' | 'down'>(null)
  const [downTimeout, setDownTimeout] = useState('5m')
  const [downReason, setDownReason] = useState('')
  const [actionError, setActionError] = useState<string | null>(null)
  // Changing shields posture is operator-only (shields down applies a
  // permissive sandbox policy). OAuth users get a read-only view.
  const [isAdmin, setIsAdmin] = useState<boolean>(false)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const res = await fetch('/api/auth/me')
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
        setState({ status: 'error', message: data?.error || `Request failed (${res.status})` })
        return
      }
      setState({ status: 'ready', shields: data.shields, audit: data.audit ?? [] })
    } catch (error) {
      setState({ status: 'error', message: error instanceof Error ? error.message : 'Failed to load shields status' })
    }
  }, [sandboxName])

  useEffect(() => {
    setActionError(null)
    void load()
  }, [load])

  // While shields are down, poll so the panel catches the auto-relock.
  useEffect(() => {
    if (state.status !== 'ready' || state.shields.posture !== 'down') return
    const interval = setInterval(() => void load(), 30000)
    return () => clearInterval(interval)
  }, [state, load])

  const act = async (action: 'up' | 'down') => {
    setActing(action)
    setActionError(null)
    try {
      const body: Record<string, string> = { action }
      if (action === 'down') {
        body.timeout = downTimeout
        if (downReason.trim()) body.reason = downReason.trim()
      }
      const res = await fetch(`/api/sandbox/${encodeURIComponent(sandboxName)}/shields`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const data = await res.json()
      if (!res.ok) {
        setActionError(data?.error || `shields ${action} failed (${res.status})`)
      } else if (data?.shields) {
        setState({ status: 'ready', shields: data.shields, audit: data.audit ?? [] })
        setDownReason('')
      }
    } catch (error) {
      setActionError(error instanceof Error ? error.message : `shields ${action} failed`)
    } finally {
      setActing(null)
    }
  }

  if (state.status === 'loading') {
    return <p className="text-sm text-[var(--foreground-dim)]">Checking shields status…</p>
  }

  if (state.status === 'error') {
    return (
      <div className="space-y-2">
        <p className="text-sm text-red-400">{state.message}</p>
        <button onClick={() => void load()} className="action-button px-3 py-2">Retry</button>
      </div>
    )
  }

  const { shields, audit } = state
  const badge = postureBadge(shields.posture)
  const locked = shields.posture === 'up'

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <span className={`inline-block border rounded px-2 py-1 text-xs font-mono tracking-wider ${badge.className}`}>
          {badge.label}
        </span>
        {shields.posture === 'down' && (
          <span className="text-xs text-amber-400 font-mono">
            auto-relock {shields.autoLockIn ? `in ${shields.autoLockIn}` : shields.restoreAt ? `at ${new Date(shields.restoreAt).toLocaleTimeString()}` : 'pending'}
          </span>
        )}
        <button onClick={() => void load()} className="action-button px-2 py-1 text-xs ml-auto">Refresh</button>
      </div>

      <p className="text-xs text-[var(--foreground-dim)] leading-relaxed">
        {locked
          ? 'Agent config is locked at the OS level (root-owned, read-only) under a restrictive policy. Config editing is disabled while shields are up.'
          : shields.posture === 'down'
            ? 'Config is temporarily unlocked and a PERMISSIVE sandbox policy is active. Shields auto-relock when the window expires — the window cannot be extended by another shields-down.'
            : 'Default mutable state. Raise shields to lock the agent config for sensitive workloads.'}
      </p>

      {shields.posture === 'down' && shields.reason && (
        <p className="text-xs text-[var(--foreground-dim)]">Reason: {shields.reason}</p>
      )}

      {actionError && <p className="text-sm text-red-400">{actionError}</p>}

      {!isAdmin ? (
        <p className="text-xs text-[var(--foreground-dim)] italic">
          Only the operator (admin) can raise or lower shields.
        </p>
      ) : locked ? (
        <div className="space-y-2">
          <div className="flex items-center gap-2 flex-wrap">
            <select
              value={downTimeout}
              onChange={(e) => setDownTimeout(e.target.value)}
              className="bg-transparent border border-[var(--foreground-dim)] rounded px-2 py-2 text-sm"
            >
              {DOWN_DURATIONS.map((d) => (
                <option key={d.value} value={d.value}>{d.label}</option>
              ))}
            </select>
            <input
              value={downReason}
              onChange={(e) => setDownReason(e.target.value)}
              placeholder="Reason (recorded in audit log)"
              maxLength={200}
              className="bg-transparent border border-[var(--foreground-dim)] rounded px-2 py-2 text-sm flex-1 min-w-[200px]"
            />
            <button onClick={() => void act('down')} disabled={acting !== null} className="action-button px-3 py-2">
              {acting === 'down' ? 'Lowering…' : 'Shields Down'}
            </button>
          </div>
        </div>
      ) : (
        <button onClick={() => void act('up')} disabled={acting !== null} className="action-button px-3 py-2">
          {acting === 'up' ? 'Raising…' : 'Shields Up'}
        </button>
      )}

      {audit.length > 0 && (
        <div>
          <p className="text-[10px] text-[var(--foreground-dim)] uppercase tracking-wider mb-1">Audit trail</p>
          <ul className="space-y-1 max-h-40 overflow-y-auto">
            {audit.map((event, index) => (
              <li key={`${event.timestamp}-${index}`} className="text-xs font-mono text-[var(--foreground-dim)]">
                {auditLine(event)}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
