"use client"

import { useEffect, useMemo, useState } from "react"
import { Button } from "@/app/components/ui/button"
import { Badge } from "@/app/components/ui/badge"
import { Card } from "@/app/components/ui/card"

type ActivityEntry = {
  id: string
  timestamp: string
  type: string
  message: string
  sandboxName?: string
  status?: "success" | "error" | "info" | "warning"
}

const PAGE_SIZE = 10
const FETCH_LIMIT = 100

function toneClass(status?: ActivityEntry["status"]) {
  if (status === "success") return "bg-primary/15 text-primary"
  if (status === "error") return "bg-destructive/15 text-destructive"
  if (status === "warning") return "bg-warning/15 text-warning"
  return "bg-muted text-muted-foreground"
}

export default function ActivityPanel() {
  const [entries, setEntries] = useState<ActivityEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [page, setPage] = useState(0)

  async function loadActivity() {
    try {
      setLoading(true)
      const response = await fetch(`/api/activity?limit=${FETCH_LIMIT}`, { cache: "no-store" })
      const data = await response.json()
      if (Array.isArray(data?.entries)) {
        setEntries(data.entries)
        setPage(0)
      }
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    loadActivity()
  }, [])

  const pageCount = Math.max(1, Math.ceil(entries.length / PAGE_SIZE))
  const safePage = Math.min(page, pageCount - 1)
  const pageEntries = useMemo(
    () => entries.slice(safePage * PAGE_SIZE, safePage * PAGE_SIZE + PAGE_SIZE),
    [entries, safePage],
  )
  const rangeStart = entries.length === 0 ? 0 : safePage * PAGE_SIZE + 1
  const rangeEnd = Math.min(entries.length, (safePage + 1) * PAGE_SIZE)

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-4 max-md:flex-col">
        <div>
          <h2 className="text-sm font-semibold uppercase tracking-wider">Activity Log</h2>
          <p className="mt-1 text-xs text-muted-foreground">Recent sandbox creation, backup, restore, catalog, and support actions recorded by the controller.</p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <Button type="button" variant="outline" size="sm" onClick={loadActivity} disabled={loading}>
            {loading ? "Refreshing…" : "Refresh"}
          </Button>
          <Button variant="outline" size="sm" asChild>
            <a href="/api/support-bundle">Support Bundle</a>
          </Button>
        </div>
      </div>

      <div className="space-y-2">
        {pageEntries.map((entry) => (
          <Card key={entry.id} className="p-3">
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <p className="truncate text-xs font-mono">{entry.message}</p>
                <p className="mt-1 text-[10px] uppercase tracking-wider text-muted-foreground">
                  {entry.sandboxName || entry.type} / {new Date(entry.timestamp).toLocaleString()}
                </p>
              </div>
              <Badge
                className={`shrink-0 rounded-full text-[10px] font-mono uppercase tracking-wider border-0 ${toneClass(entry.status)}`}
              >
                {entry.status || "info"}
              </Badge>
            </div>
          </Card>
        ))}
        {entries.length === 0 && (
          <Card className="p-4">
            <p className="text-sm text-muted-foreground">No activity recorded yet.</p>
          </Card>
        )}
      </div>

      {entries.length > PAGE_SIZE && (
        <div className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
          <span>
            Showing {rangeStart}–{rangeEnd} of {entries.length}
          </span>
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setPage((p) => Math.max(0, p - 1))}
              disabled={safePage === 0}
            >
              Newer
            </Button>
            <span className="font-mono">
              Page {safePage + 1} / {pageCount}
            </span>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setPage((p) => Math.min(pageCount - 1, p + 1))}
              disabled={safePage >= pageCount - 1}
            >
              Older
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}
