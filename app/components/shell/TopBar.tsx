"use client"

import { usePathname } from "next/navigation"
import { Menu, Sun, Moon, RefreshCw, LogOut } from "lucide-react"
import { useState } from "react"
import { Button } from "@/app/components/ui/button"
import { Sheet, SheetContent, SheetTitle } from "@/app/components/ui/sheet"
import { useAuth } from "@/app/components/providers/AuthProvider"
import { useTheme } from "@/app/lib/useTheme"
import { useConnectionHealth } from "@/app/hooks/useConnectionHealth"
import { ApprovalsBell } from "@/app/components/ApprovalsBell"
import { visibleNavItems } from "./nav"
import Link from "next/link"
import { cn } from "@/app/lib/utils"

function breadcrumb(pathname: string): string {
  if (pathname === "/") return "Dashboard"
  if (pathname.startsWith("/sandboxes/new")) return "Sandboxes / New"
  if (pathname.startsWith("/sandboxes/")) {
    const name = decodeURIComponent(pathname.split("/")[2] ?? "")
    return name ? `Sandboxes / ${name}` : "Sandboxes"
  }
  if (pathname.startsWith("/activity")) return "Activity"
  if (pathname.startsWith("/inference")) return "Inference"
  if (pathname.startsWith("/mcp")) return "MCP"
  if (pathname.startsWith("/wizards")) return "Wizards"
  if (pathname.startsWith("/skills")) return "Skills"
  if (pathname.startsWith("/security")) return "Security"
  if (pathname.startsWith("/help")) return "Help"
  return "OpenShell Control"
}

async function handleLogout() {
  await fetch("/api/auth/logout", { method: "POST" }).catch(() => null)
  window.location.href = "/login"
}

export function TopBar() {
  const pathname = usePathname()
  const { me } = useAuth()
  const { theme, toggle } = useTheme()
  const { reconnecting } = useConnectionHealth()
  const [sheetOpen, setSheetOpen] = useState(false)
  const items = visibleNavItems(me.capabilities)

  const isActive = (href: string) =>
    href === "/" ? pathname === "/" : pathname.startsWith(href)

  return (
    <header className="fixed top-0 left-0 right-0 lg:left-60 z-10 flex h-[calc(3.5rem+env(safe-area-inset-top))] items-center border-b border-border bg-background/95 backdrop-blur px-4 gap-3 pt-[env(safe-area-inset-top)]">
      {/* Hamburger — mobile only */}
      <Button
        variant="ghost"
        size="icon"
        className="lg:hidden h-8 w-8 shrink-0"
        aria-label="Open navigation"
        onClick={() => setSheetOpen(true)}
      >
        <Menu className="h-4 w-4" />
      </Button>

      {/* Breadcrumb */}
      <p className="flex-1 text-sm font-medium text-foreground truncate">
        {breadcrumb(pathname)}
      </p>

      {/* Reconnecting badge */}
      {reconnecting && (
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <RefreshCw className="h-3 w-3 animate-spin" />
          <span className="hidden sm:inline">Reconnecting…</span>
        </div>
      )}

      {/* Approvals bell */}
      <ApprovalsBell />

      {/* Theme toggle — right side on mobile (sidebar is hidden) */}
      <Button
        variant="ghost"
        size="icon"
        onClick={toggle}
        className="h-8 w-8 lg:hidden text-muted-foreground hover:text-foreground"
        aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} theme`}
      >
        {theme === "dark" ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
      </Button>

      {/* Mobile nav sheet */}
      <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
        <SheetContent side="left" className="w-72 p-0 flex flex-col">
          <SheetTitle className="sr-only">Navigation</SheetTitle>
          {/* Product mark */}
          <div className="flex items-center gap-3 border-b border-border p-4">
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded bg-primary">
              <svg className="h-5 w-5 text-primary-foreground" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="square" strokeLinejoin="miter" strokeWidth={2} d="M4 7l8-4 8 4v10l-8 4-8-4V7z" />
                <path strokeLinecap="square" strokeLinejoin="miter" strokeWidth={2} d="M4 7l8 4 8-4M12 11v10" />
              </svg>
            </div>
            <p className="text-sm font-semibold">OpenShell Control</p>
          </div>

          {/* Nav */}
          <nav className="flex-1 overflow-y-auto p-2 space-y-0.5">
            {items.map((item) => {
              const active = isActive(item.href)
              const Icon = item.icon
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  onClick={() => setSheetOpen(false)}
                  className={cn(
                    "flex items-center gap-3 rounded-md px-3 py-2.5 text-sm transition-colors",
                    active
                      ? "bg-primary text-primary-foreground"
                      : "text-muted-foreground hover:bg-secondary hover:text-foreground",
                  )}
                >
                  <Icon className="h-4 w-4 shrink-0" />
                  {item.label}
                </Link>
              )
            })}
          </nav>

          {/* Sign out */}
          <div className="border-t border-border p-2">
            <button
              onClick={handleLogout}
              className="flex w-full items-center gap-3 rounded-md px-3 py-2.5 text-sm text-muted-foreground hover:bg-secondary hover:text-foreground transition-colors"
            >
              <LogOut className="h-4 w-4" />
              Sign out
            </button>
          </div>
        </SheetContent>
      </Sheet>
    </header>
  )
}
