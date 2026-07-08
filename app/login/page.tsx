"use client"

import { FormEvent, useEffect, useRef, useState } from "react"
import AuthShell from "../components/AuthShell"
import { Button } from "@/app/components/ui/button"
import { Input } from "@/app/components/ui/input"
import { Alert, AlertDescription } from "@/app/components/ui/alert"
import { Skeleton } from "@/app/components/ui/skeleton"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/app/components/ui/collapsible"
import { ChevronRight } from "lucide-react"

export default function LoginPage() {
  const [nextPath, setNextPath] = useState("/")
  const [password, setPassword] = useState("")
  const [message, setMessage] = useState("")
  const [busy, setBusy] = useState(false)
  // null = loading, string = URL, "" = not configured
  const [oauthLoginUrl, setOauthLoginUrl] = useState<string | null>(null)
  const [operatorOpen, setOperatorOpen] = useState(false)
  const passwordRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    setNextPath(new URLSearchParams(window.location.search).get("next") || "/")

    fetch("/api/auth/login")
      .then((res) => res.json())
      .then((data) => {
        const url: string = data.oauthLoginUrl || ""
        setOauthLoginUrl(url)
        // If no IdP configured, expand operator form by default
        if (!url) setOperatorOpen(true)
      })
      .catch(() => {
        setOauthLoginUrl("")
        setOperatorOpen(true)
      })
  }, [])

  useEffect(() => {
    if (operatorOpen) {
      // Autofocus password when operator section is expanded
      setTimeout(() => passwordRef.current?.focus(), 50)
    }
  }, [operatorOpen])

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setBusy(true)
    setMessage("")

    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password, next: nextPath }),
      })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || "Login failed")
      // Browsers carry the original URL fragment through a server redirect when
      // the redirect target has no fragment of its own. Reattach it on the way
      // back so deep-links like `#token=…` survive a login round-trip.
      const carryHash = typeof window !== "undefined" ? window.location.hash : ""
      const nextUrl = data.next || "/"
      window.location.href = carryHash && !nextUrl.includes("#") ? `${nextUrl}${carryHash}` : nextUrl
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Login failed")
    } finally {
      setBusy(false)
    }
  }

  const idpConfigured = oauthLoginUrl !== null && oauthLoginUrl !== ""
  const loading = oauthLoginUrl === null

  return (
    <AuthShell title="OpenShell Control" description="Sandbox fleet control for OpenShell">
      <div className="space-y-4">
        {/* IdP sign-in — primary */}
        {loading ? (
          <Skeleton className="h-10 w-full" />
        ) : idpConfigured ? (
          <Button asChild size="lg" className="w-full">
            <a
              href={`${oauthLoginUrl}${oauthLoginUrl.includes("?") ? "&" : "?"}state=${encodeURIComponent(nextPath)}`}
            >
              Sign in with company account
            </a>
          </Button>
        ) : null}

        {/* Divider — only when IdP is configured */}
        {idpConfigured && (
          <div className="relative flex items-center">
            <div className="flex-grow border-t border-border" />
            <span className="mx-3 text-[10px] uppercase tracking-wider text-muted-foreground font-mono">or</span>
            <div className="flex-grow border-t border-border" />
          </div>
        )}

        {/* Operator sign-in — collapsible when IdP configured, always open otherwise */}
        {idpConfigured ? (
          <Collapsible open={operatorOpen} onOpenChange={setOperatorOpen}>
            <CollapsibleTrigger className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors w-full">
              <ChevronRight
                className={`h-3.5 w-3.5 transition-transform ${operatorOpen ? "rotate-90" : ""}`}
              />
              Operator sign-in
            </CollapsibleTrigger>
            <CollapsibleContent>
              <form onSubmit={submit} className="mt-3 space-y-3">
                <Input
                  ref={passwordRef}
                  type="password"
                  placeholder="Password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete="current-password"
                />
                {message && (
                  <Alert variant="destructive">
                    <AlertDescription className="text-xs">{message}</AlertDescription>
                  </Alert>
                )}
                <Button type="submit" variant="secondary" className="w-full" disabled={busy}>
                  {busy ? "Signing in…" : "Sign in as operator"}
                </Button>
              </form>
            </CollapsibleContent>
          </Collapsible>
        ) : (
          !loading && (
            <form onSubmit={submit} className="space-y-3">
              <Input
                ref={passwordRef}
                type="password"
                placeholder="Password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
                autoFocus
              />
              {message && (
                <Alert variant="destructive">
                  <AlertDescription className="text-xs">{message}</AlertDescription>
                </Alert>
              )}
              <Button type="submit" className="w-full" disabled={busy}>
                {busy ? "Signing in…" : "Sign in as operator"}
              </Button>
            </form>
          )
        )}

        <div className="text-center">
          <a
            href="/forgot-password"
            className="text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            Forgot password?
          </a>
        </div>
      </div>
    </AuthShell>
  )
}
