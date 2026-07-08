"use client"

import { useMemo, useState } from "react"
import { PageHeader } from "@/app/components/PageHeader"
import { Button } from "@/app/components/ui/button"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/app/components/ui/select"
import { useActivity } from "@/app/hooks/queries"
import { useInventory } from "@/app/hooks/queries"
import { useAuth } from "@/app/components/providers/AuthProvider"
import { relativeTime, absoluteTime } from "@/app/lib/format"
import { Card } from "@/app/components/ui/card"

const PAGE_SIZE = 10

function toneClass(status?: string) {
  if (status === "success") return "bg-success/15 text-success"
  if (status === "error") return "bg-destructive/15 text-destructive"
  if (status === "warning") return "bg-warning/15 text-warning"
  return "bg-muted text-muted-foreground"
}

export default function ActivityPage() {
  const { me } = useAuth()
  const activityQuery = useActivity(100)
  const { sandboxes } = useInventory()
  const [sandboxFilter, setSandboxFilter] = useState("all")
  const [page, setPage] = useState(0)

  const filtered = useMemo(() => {
    const entries = activityQuery.data ?? []
    if (sandboxFilter === "all") return entries
    return entries.filter((e) => e.sandboxName === sandboxFilter)
  }, [activityQuery.data, sandboxFilter])

  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE))
  const safePage = Math.min(page, pageCount - 1)
  const pageEntries = filtered.slice(safePage * PAGE_SIZE, (safePage + 1) * PAGE_SIZE)

  const sandboxNames = Array.from(new Set(sandboxes.map((s) => s.name))).sort()

  const actions = me.role === "operator" ? (
    <Button variant="outline" size="sm" asChild>
      <a href="/api/support-bundle" download>Download support bundle</a>
    </Button>
  ) : undefined

  return (
    <>
      <PageHeader
        title="Activity"
        description="Recent sandbox and gateway events."
        actions={actions}
      />

      <div className="flex items-center gap-3 mb-4">
        <Select value={sandboxFilter} onValueChange={(v) => { setSandboxFilter(v); setPage(0) }}>
          <SelectTrigger className="w-48 h-8 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All sandboxes</SelectItem>
            {sandboxNames.map((n) => (
              <SelectItem key={n} value={n}>{n}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        {activityQuery.isFetching && (
          <span className="text-xs text-muted-foreground font-mono">Refreshing…</span>
        )}
      </div>

      <Card className="p-0 overflow-hidden">
        {filtered.length === 0 ? (
          <p className="p-6 text-sm text-muted-foreground">No activity entries.</p>
        ) : (
          <ul className="divide-y divide-border">
            {pageEntries.map((entry) => (
              <li key={entry.id} className="flex items-start gap-3 px-4 py-3">
                <span className={`mt-0.5 shrink-0 inline-flex justify-center w-16 rounded-sm py-0.5 text-[10px] font-mono uppercase ${toneClass(entry.status)}`}>
                  {entry.status || "info"}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-xs">{entry.message}</p>
                  {entry.sandboxName && (
                    <p className="text-[10px] font-mono text-muted-foreground">{entry.sandboxName}</p>
                  )}
                </div>
                <span className="shrink-0 text-right whitespace-nowrap" title={new Date(entry.timestamp).toISOString()}>
                  <span className="block text-[10px] font-mono text-muted-foreground">{relativeTime(entry.timestamp)}</span>
                  <span className="block text-[10px] font-mono text-muted-foreground/60">{absoluteTime(entry.timestamp)}</span>
                </span>
              </li>
            ))}
          </ul>
        )}

        {pageCount > 1 && (
          <div className="flex items-center justify-between border-t border-border px-4 py-3">
            <span className="text-xs text-muted-foreground">
              {filtered.length === 0 ? 0 : safePage * PAGE_SIZE + 1}–{Math.min(filtered.length, (safePage + 1) * PAGE_SIZE)} of {filtered.length}
            </span>
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={safePage === 0}
                onClick={() => setPage((p) => p - 1)}
              >
                Previous
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={safePage >= pageCount - 1}
                onClick={() => setPage((p) => p + 1)}
              >
                Next
              </Button>
            </div>
          </div>
        )}
      </Card>
    </>
  )
}
