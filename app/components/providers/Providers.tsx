"use client"
import { QueryClientProvider } from "@tanstack/react-query"
import { Toaster } from "sonner"
import { queryClient } from "@/app/lib/queryClient"
import { AuthProvider } from "./AuthProvider"

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        {children}
        <Toaster richColors position="bottom-right" />
      </AuthProvider>
    </QueryClientProvider>
  )
}
