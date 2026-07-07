"use client"
import { createContext, useContext } from "react"
import { useQuery } from "@tanstack/react-query"
import { apiFetch } from "@/app/lib/apiFetch"
import type { Capabilities } from "@/app/api/auth/me/route"

export type AuthMe = {
  role: "operator" | "user" | "anonymous"
  operator: boolean
  configured: boolean
  email: string | null
  capabilities: Capabilities | null
  allowedSandboxes: "all" | string[]
}

const FALLBACK: AuthMe = {
  role: "anonymous", operator: false, configured: true,
  email: null, capabilities: null, allowedSandboxes: [],
}

const AuthContext = createContext<{ me: AuthMe; isLoading: boolean }>({ me: FALLBACK, isLoading: true })

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const { data, isLoading } = useQuery({
    queryKey: ["auth", "me"],
    queryFn: () => apiFetch<AuthMe>("/api/auth/me"),
    staleTime: 60_000,
    refetchOnWindowFocus: true,
  })
  return (
    <AuthContext.Provider value={{ me: data ?? FALLBACK, isLoading }}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth() {
  return useContext(AuthContext)
}

/** Convenience: `can('deleteSandbox')` — false while loading or anonymous. */
export function useCan() {
  const { me } = useAuth()
  return (cap: keyof Capabilities) => Boolean(me.capabilities?.[cap])
}
