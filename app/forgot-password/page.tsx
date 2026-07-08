"use client"

import { FormEvent, useState } from "react"
import AuthShell from "../components/AuthShell"
import { Button } from "@/app/components/ui/button"
import { Input } from "@/app/components/ui/input"
import { Alert, AlertDescription } from "@/app/components/ui/alert"

export default function ForgotPasswordPage() {
  const [recoveryToken, setRecoveryToken] = useState("")
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
      const response = await fetch("/api/auth/recover", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ recoveryToken, password }),
      })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || "Could not reset password.")
      setIsError(false)
      setMessage("Password reset. Redirecting...")
      window.setTimeout(() => {
        window.location.href = "/"
      }, 600)
    } catch (error) {
      setIsError(true)
      setMessage(error instanceof Error ? error.message : "Could not reset password.")
    } finally {
      setBusy(false)
    }
  }

  return (
    <AuthShell title="Forgot Password?" description="Use the local recovery token from .env.local to reset the operator password.">
      <form onSubmit={submit} className="space-y-4">
        <div className="space-y-1.5">
          <label className="text-[10px] uppercase tracking-wider text-muted-foreground font-mono">
            Recovery Token
          </label>
          <Input
            type="password"
            value={recoveryToken}
            onChange={(event) => setRecoveryToken(event.target.value)}
            autoFocus
            autoComplete="off"
          />
        </div>

        <div className="space-y-1.5">
          <label className="text-[10px] uppercase tracking-wider text-muted-foreground font-mono">
            New Password
          </label>
          <Input
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </div>

        <div className="space-y-1.5">
          <label className="text-[10px] uppercase tracking-wider text-muted-foreground font-mono">
            Confirm Password
          </label>
          <Input
            type="password"
            value={confirmPassword}
            onChange={(event) => setConfirmPassword(event.target.value)}
          />
        </div>

        {message && (
          <Alert variant={isError ? "destructive" : "default"}>
            <AlertDescription className="text-xs">{message}</AlertDescription>
          </Alert>
        )}

        <Button type="submit" disabled={busy} className="w-full">
          {busy ? "Resetting…" : "Reset Password"}
        </Button>

        <div className="text-center">
          <a
            href="/login"
            className="text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            Back to Sign In
          </a>
        </div>
      </form>
    </AuthShell>
  )
}
