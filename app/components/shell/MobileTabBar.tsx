"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"
import { useState } from "react"
import { MoreHorizontal, LogOut } from "lucide-react"
import { Sheet, SheetContent, SheetTitle } from "@/app/components/ui/sheet"
import { useAuth } from "@/app/components/providers/AuthProvider"
import { visibleNavItems } from "./nav"
import { cn } from "@/app/lib/utils"

async function handleLogout() {
  await fetch("/api/auth/logout", { method: "POST" }).catch(() => null)
  window.location.href = "/login"
}

export function MobileTabBar() {
  const pathname = usePathname()
  const { me } = useAuth()
  const [moreOpen, setMoreOpen] = useState(false)

  const allItems = visibleNavItems(me.capabilities)
  const tabItems = allItems.filter((i) => i.mobileTab)
  const moreItems = allItems.filter((i) => !i.mobileTab)

  const isActive = (href: string) =>
    href === "/" ? pathname === "/" : pathname.startsWith(href)

  return (
    <>
      <nav className="fixed bottom-0 left-0 right-0 z-20 lg:hidden flex h-16 items-center border-t border-border bg-background/95 backdrop-blur pb-[env(safe-area-inset-bottom)]">
        {tabItems.map((item) => {
          const active = isActive(item.href)
          const Icon = item.icon
          return (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                "flex flex-1 flex-col items-center justify-center gap-1 py-2 text-[11px] transition-colors",
                active ? "text-primary" : "text-muted-foreground hover:text-foreground",
              )}
              aria-current={active ? "page" : undefined}
            >
              <Icon className="h-5 w-5" />
              <span>{item.label}</span>
            </Link>
          )
        })}

        {/* More tab */}
        {moreItems.length > 0 && (
          <button
            onClick={() => setMoreOpen(true)}
            className="flex flex-1 flex-col items-center justify-center gap-1 py-2 text-[11px] text-muted-foreground hover:text-foreground transition-colors"
            aria-label="More navigation options"
          >
            <MoreHorizontal className="h-5 w-5" />
            <span>More</span>
          </button>
        )}
      </nav>

      {/* More sheet */}
      <Sheet open={moreOpen} onOpenChange={setMoreOpen}>
        <SheetContent side="bottom" className="rounded-t-lg max-h-[70vh]">
          <SheetTitle className="sr-only">More options</SheetTitle>
          <nav className="space-y-1 py-2">
            {moreItems.map((item) => {
              const active = isActive(item.href)
              const Icon = item.icon
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  onClick={() => setMoreOpen(false)}
                  className={cn(
                    "flex items-center gap-3 rounded-md px-3 py-3 text-sm transition-colors",
                    active
                      ? "bg-primary text-primary-foreground"
                      : "text-muted-foreground hover:bg-secondary hover:text-foreground",
                  )}
                >
                  <Icon className="h-5 w-5 shrink-0" />
                  {item.label}
                </Link>
              )
            })}
            <div className="border-t border-border mt-2 pt-2">
              <button
                onClick={handleLogout}
                className="flex w-full items-center gap-3 rounded-md px-3 py-3 text-sm text-muted-foreground hover:bg-secondary hover:text-foreground transition-colors"
              >
                <LogOut className="h-5 w-5" />
                Sign out
              </button>
            </div>
          </nav>
        </SheetContent>
      </Sheet>
    </>
  )
}
