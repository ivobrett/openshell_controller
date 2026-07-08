"use client"

import { FormEvent, useState } from "react"
import AuthShell from "../components/AuthShell"
import { Button } from "@/app/components/ui/button"
import { Input } from "@/app/components/ui/input"
import { Alert, AlertDescription } from "@/app/components/ui/alert"

export default function FirstRunSetup() {
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
      const response = await fetch("/api/auth/setup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || "Could not set password.")
      setIsError(false)
      setMessage("Password set. Redirecting to sign in…")
      window.setTimeout(() => { window.location.href = "/login" }, 800)
    } catch (error) {
      setIsError(true)
      setMessage(error instanceof Error ? error.message : "Could not set password.")
    } finally {
      setBusy(false)
    }
  }

  return (
    <AuthShell title="Set Operator Password" description="Create a password for the operator account to get started.">
      <form onSubmit={submit} className="space-y-4">
        <div className="space-y-1.5">
          <label className="text-[10px] uppercase tracking-wider text-muted-foreground font-mono">
            New Password
          </label>
          <Input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoFocus
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
        <Button type="submit" disabled={busy} className="w-full">
          {busy ? "Setting password…" : "Set Password"}
        </Button>
      </form>
    </AuthShell>
  )
}
