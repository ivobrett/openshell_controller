"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"
import { LogOut, Sun, Moon } from "lucide-react"
import { Badge } from "@/app/components/ui/badge"
import { Button } from "@/app/components/ui/button"
import { Separator } from "@/app/components/ui/separator"
import { useAuth } from "@/app/components/providers/AuthProvider"
import { useTheme } from "@/app/lib/useTheme"
import { NodeSwitcher } from "./NodeSwitcher"
import { visibleNavItems } from "./nav"
import { cn } from "@/app/lib/utils"

async function handleLogout() {
  await fetch("/api/auth/logout", { method: "POST" }).catch(() => null)
  window.location.href = "/login"
}

export function AppSidebar() {
  const pathname = usePathname()
  const { me } = useAuth()
  const { theme, toggle } = useTheme()
  const items = visibleNavItems(me.capabilities)

  const isActive = (href: string) =>
    href === "/" ? pathname === "/" : pathname.startsWith(href)

  return (
    <aside className="fixed left-0 top-0 z-20 flex h-screen w-60 flex-col border-r border-border bg-sidebar shadow-[12px_0_40px_rgba(0,0,0,0.22)]">
      {/* Header */}
      <div className="border-b border-sidebar-border p-4">
        <Link href="/" className="flex items-center gap-3">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded bg-primary shadow-[0_0_22px_rgba(118,185,0,0.28)]">
            <svg className="h-5 w-5 text-primary-foreground" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="square" strokeLinejoin="miter" strokeWidth={2} d="M4 7l8-4 8 4v10l-8 4-8-4V7z" />
              <path strokeLinecap="square" strokeLinejoin="miter" strokeWidth={2} d="M4 7l8 4 8-4M12 11v10" />
            </svg>
          </div>
          <div className="min-w-0">
            <p className="text-sm font-semibold text-sidebar-foreground leading-tight">OpenShell Control</p>
          </div>
        </Link>
        {me.capabilities?.manageNodes && <NodeSwitcher />}
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
              className={cn(
                "flex items-center gap-3 rounded-md px-3 py-2.5 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                active
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:bg-secondary hover:text-foreground",
              )}
              aria-current={active ? "page" : undefined}
            >
              <Icon className="h-4 w-4 shrink-0" />
              <span>{item.label}</span>
            </Link>
          )
        })}
      </nav>

      <Separator className="bg-sidebar-border" />

      {/* Footer */}
      <div className="p-3 space-y-2">
        {/* Identity */}
        <div className="px-1">
          {me.role === "operator" ? (
            <Badge variant="outline" className="border-primary text-primary text-[10px] font-mono">
              OPERATOR
            </Badge>
          ) : me.email ? (
            <p className="truncate font-mono text-xs text-muted-foreground">{me.email}</p>
          ) : null}
        </div>

        <div className="flex items-center gap-1">
          {/* Theme toggle */}
          <Button
            variant="ghost"
            size="icon"
            onClick={toggle}
            className="h-8 w-8 text-muted-foreground hover:text-foreground"
            aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} theme`}
          >
            {theme === "dark" ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
          </Button>

          {/* Sign out */}
          <Button
            variant="ghost"
            size="sm"
            onClick={handleLogout}
            className="flex-1 justify-start gap-2 h-8 text-muted-foreground hover:text-foreground text-xs"
          >
            <LogOut className="h-4 w-4" />
            Sign out
          </Button>
        </div>
      </div>
    </aside>
  )
}
