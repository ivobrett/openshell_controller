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

type AuthContextValue = {
  me: AuthMe
  isLoading: boolean
  can: (cap: keyof Capabilities) => boolean
}

function makeCan(me: AuthMe) {
  return (cap: keyof Capabilities) => Boolean(me.capabilities?.[cap])
}

const AuthContext = createContext<AuthContextValue>({
  me: FALLBACK,
  isLoading: true,
  can: () => false,
})

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const { data, isLoading } = useQuery({
    queryKey: ["auth", "me"],
    queryFn: () => apiFetch<AuthMe>("/api/auth/me"),
    staleTime: 60_000,
    refetchOnWindowFocus: true,
  })
  const me = data ?? FALLBACK
  return (
    <AuthContext.Provider value={{ me, isLoading, can: makeCan(me) }}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth() {
  return useContext(AuthContext)
}

/** Convenience: `can('deleteSandbox')` — false while loading or anonymous. */
export function useCan() {
  const { can } = useAuth()
  return can
}
