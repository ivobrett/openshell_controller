"use client"

import { AppSidebar } from "./AppSidebar"
import { TopBar } from "./TopBar"
import { MobileTabBar } from "./MobileTabBar"

export function AppShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen">
      {/* Desktop sidebar */}
      <div className="hidden lg:block">
        <AppSidebar />
      </div>

      {/* Top bar (all breakpoints) */}
      <TopBar />

      {/* Main content */}
      <main className="lg:pl-60 pt-[calc(3.5rem+env(safe-area-inset-top))] pb-[calc(5rem+env(safe-area-inset-bottom))] lg:pb-6">
        <div className="mx-auto max-w-7xl p-4 md:p-6">
          {children}
        </div>
      </main>

      {/* Mobile bottom tab bar */}
      <MobileTabBar />
    </div>
  )
}
