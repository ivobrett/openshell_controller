"use client"

import { FormEvent, useCallback, useEffect, useState } from "react"
import { PageHeader } from "@/app/components/PageHeader"
import { Card } from "@/app/components/ui/card"
import { Button } from "@/app/components/ui/button"
import { Input } from "@/app/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/app/components/ui/select"
import { Alert, AlertDescription } from "@/app/components/ui/alert"
import { useAuth } from "@/app/components/providers/AuthProvider"
import { useInventory } from "@/app/hooks/queries"

type AccessEntry = { sandboxName: string; email: string }

export default function SecurityPage() {
  const { me, isLoading } = useAuth()

  if (isLoading) {
    return (
      <>
        <PageHeader title="Security" description="Manage the operator password and per-sandbox access for company users." />
        <p className="text-xs text-muted-foreground">Loading…</p>
      </>
    )
  }

  const showPassword = me.operator || !me.configured
  const showSandboxAccess = me.operator
  const showLockedNotice = !me.operator && me.configured

  return (
    <>
      <PageHeader title="Security" description="Manage the operator password and per-sandbox access for company users." />

      <div className="max-w-lg space-y-6">
        {showPassword && (
          <Card className="p-6">
            <PasswordSection firstRun={!me.configured} />
          </Card>
        )}
        {showSandboxAccess && (
          <Card className="p-6">
            <SandboxAccessSection />
          </Card>
        )}
        {showLockedNotice && (
          <Card className="p-6">
            <p className="text-sm text-muted-foreground">
              Operator sign-in is managed by the operator.
            </p>
          </Card>
        )}
      </div>
    </>
  )
}

function PasswordSection({ firstRun }: { firstRun: boolean }) {
  const [currentPassword, setCurrentPassword] = useState("")
  const [password, setPassword] = useState("")
  const [confirmPassword, setConfirmPassword] = useState("")
  const [message, setMessage] = useState("")
  const [isError, setIsError] = useState(false)
  const [busy, setBusy] = useState(false)

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setMessage("")
    if (password !== confirmPassword) {
      setIsError(true)
      setMessage("Passwords do not match.")
      return
    }
    setBusy(true)
    try {
      const r = await fetch("/api/auth/setup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ currentPassword, password }),
      })
      const data = await r.json()
      if (!r.ok) throw new Error(data.error || "Could not update account.")
      setIsError(false)
      setMessage("Password updated. Redirecting…")
      window.setTimeout(() => { window.location.href = "/" }, 600)
    } catch (err) {
      setIsError(true)
      setMessage(err instanceof Error ? err.message : "Could not update account.")
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      <h2 className="text-xs font-semibold uppercase tracking-wider">
        {firstRun ? "Set Password" : "Operator Password"}
      </h2>
      {!firstRun && (
        <div className="space-y-1.5">
          <label className="text-[10px] uppercase tracking-wider text-muted-foreground font-mono">
            Current Password
          </label>
          <Input
            type="password"
            value={currentPassword}
            onChange={(e) => setCurrentPassword(e.target.value)}
            autoComplete="current-password"
          />
        </div>
      )}
      <div className="space-y-1.5">
        <label className="text-[10px] uppercase tracking-wider text-muted-foreground font-mono">
          New Password
        </label>
        <Input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="new-password"
        />
      </div>
      <div className="space-y-1.5">
        <label className="text-[10px] uppercase tracking-wider text-muted-foreground font-mono">
          Confirm Password
        </label>
        <Input
          type="password"
          value={confirmPassword}
          onChange={(e) => setConfirmPassword(e.target.value)}
          autoComplete="new-password"
        />
      </div>
      {message && (
        <Alert variant={isError ? "destructive" : "default"}>
          <AlertDescription className="text-xs">{message}</AlertDescription>
        </Alert>
      )}
      <Button type="submit" disabled={busy}>
        {busy ? "Saving…" : "Save Password"}
      </Button>
    </form>
  )
}

function SandboxAccessSection() {
  const { sandboxes } = useInventory()
  const sandboxOptions = sandboxes.map((s) => s.name).sort()

  const [entries, setEntries] = useState<AccessEntry[]>([])
  const [pickedSandbox, setPickedSandbox] = useState("")
  const [newEmail, setNewEmail] = useState("")
  const [loading, setLoading] = useState(true)
  const [authorized, setAuthorized] = useState(true)
  const [dirty, setDirty] = useState(false)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState("")
  const [isError, setIsError] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const r = await fetch("/api/security/sandbox-access", { cache: "no-store" })
      if (r.status === 401) { setAuthorized(false); return }
      const data = await r.json()
      if (!r.ok) throw new Error(data.error || "Failed to load sandbox access list.")
      setAuthorized(true)
      setEntries(Array.isArray(data.entries) ? data.entries : [])
      setDirty(false)
    } catch (err) {
      setIsError(true)
      setMessage(err instanceof Error ? err.message : "Failed to load sandbox access list.")
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  useEffect(() => {
    if (sandboxOptions.length > 0) {
      setPickedSandbox((prev) => prev || sandboxOptions[0])
    }
  }, [sandboxOptions])

  const addEntry = () => {
    setMessage("")
    const sandboxName = pickedSandbox.trim()
    const email = newEmail.trim().toLowerCase()
    if (!sandboxName || !email) { setIsError(true); setMessage("Pick a sandbox and enter an email."); return }
    if (entries.some((e) => e.sandboxName === sandboxName && e.email === email)) {
      setIsError(true); setMessage("That sandbox/email pair is already in the list."); return
    }
    setEntries([...entries, { sandboxName, email }])
    setNewEmail("")
    setDirty(true)
  }

  const removeEntry = (i: number) => {
    setEntries(entries.filter((_, idx) => idx !== i))
    setDirty(true)
  }

  const save = async () => {
    setBusy(true)
    setMessage("")
    try {
      const r = await fetch("/api/security/sandbox-access", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ entries }),
      })
      const data = await r.json()
      if (!r.ok) throw new Error(data.error || "Failed to save.")
      setEntries(Array.isArray(data.entries) ? data.entries : entries)
      setDirty(false)
      setIsError(false)
      setMessage("Saved.")
    } catch (err) {
      setIsError(true)
      setMessage(err instanceof Error ? err.message : "Failed to save.")
    } finally {
      setBusy(false)
    }
  }

  if (!authorized) {
    return (
      <div className="space-y-2">
        <h2 className="text-xs font-semibold uppercase tracking-wider">Sandbox Access</h2>
        <p className="text-sm text-muted-foreground">
          Sign in as an operator to manage per-sandbox access for company users.
        </p>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <h2 className="text-xs font-semibold uppercase tracking-wider">Sandbox Access</h2>
      <p className="text-xs text-muted-foreground">
        Authorize company (OAuth/IDP) users for specific sandboxes. Changes take effect immediately.
      </p>

      {loading ? (
        <p className="text-xs text-muted-foreground">Loading…</p>
      ) : (
        <>
          {entries.length === 0 ? (
            <p className="text-xs text-muted-foreground italic">No assignments yet.</p>
          ) : (
            <ul className="space-y-1">
              {entries.map((entry, idx) => (
                <li
                  key={`${entry.sandboxName}:${entry.email}:${idx}`}
                  className="flex items-center gap-2 rounded-md border border-border bg-muted/40 px-3 py-1.5 text-xs font-mono"
                >
                  <span className="font-medium truncate">{entry.sandboxName}</span>
                  <span className="flex-1 truncate text-muted-foreground">{entry.email}</span>
                  <button
                    type="button"
                    onClick={() => removeEntry(idx)}
                    className="text-muted-foreground hover:text-destructive transition-colors shrink-0"
                    aria-label={`Remove ${entry.email} from ${entry.sandboxName}`}
                  >
                    ×
                  </button>
                </li>
              ))}
            </ul>
          )}

          <div className="rounded-md border border-border bg-muted/30 p-4 space-y-3">
            <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-mono">
              Add Assignment
            </p>
            {sandboxOptions.length > 0 ? (
              <Select value={pickedSandbox || undefined} onValueChange={setPickedSandbox}>
                <SelectTrigger className="w-full h-8 text-xs">
                  <SelectValue placeholder="Select a sandbox" />
                </SelectTrigger>
                <SelectContent>
                  {sandboxOptions.map((n) => (
                    <SelectItem key={n} value={n}>{n}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : (
              <Input
                type="text"
                value={pickedSandbox}
                onChange={(e) => setPickedSandbox(e.target.value)}
                placeholder="sandbox name"
                className="h-8 text-xs"
              />
            )}
            <Input
              type="email"
              value={newEmail}
              onChange={(e) => setNewEmail(e.target.value)}
              placeholder="user@example.com"
              className="h-8 text-xs"
            />
            <Button type="button" variant="outline" size="sm" className="w-full" onClick={addEntry}>
              + Add
            </Button>
          </div>

          {message && (
            <Alert variant={isError ? "destructive" : "default"}>
              <AlertDescription className="text-xs">{message}</AlertDescription>
            </Alert>
          )}

          <Button onClick={save} disabled={busy || !dirty}>
            {busy ? "Saving…" : "Save Sandbox Access"}
          </Button>
        </>
      )}
    </div>
  )
}
