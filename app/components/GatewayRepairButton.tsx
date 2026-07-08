"use client"

import { useState } from "react"
import { toast } from "sonner"
import { queryClient } from "@/app/lib/queryClient"
import { apiFetch } from "@/app/lib/apiFetch"
import { Button } from "@/app/components/ui/button"
import { Alert, AlertDescription } from "@/app/components/ui/alert"

export function GatewayRepairButton() {
  const [busy, setBusy] = useState(false)
  const [detail, setDetail] = useState<string | null>(null)

  const handleRepair = async () => {
    if (busy) return
    setBusy(true)
    setDetail(null)
    try {
      await apiFetch("/api/openshell/gateway/repair", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
        signal: AbortSignal.timeout(120_000),
      })
      toast.success("Gateway repair completed")
      queryClient.invalidateQueries({ queryKey: ["inventory"] })
    } catch (err: any) {
      const body = err?.body
      const parts = [body?.error, body?.stdout, body?.stderr].filter(Boolean).join("\n\n")
      setDetail(parts || (err instanceof Error ? err.message : "Repair failed"))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-3">
      <Button variant="outline" size="sm" disabled={busy} onClick={handleRepair}>
        {busy ? "Repairing gateway…" : "Attempt gateway repair"}
      </Button>
      {detail && (
        <Alert variant="destructive">
          <AlertDescription className="space-y-2">
            <pre className="font-mono text-xs whitespace-pre-wrap">{detail}</pre>
            <p className="text-xs">If repair fails repeatedly, see the gateway recovery runbook.</p>
          </AlertDescription>
        </Alert>
      )}
    </div>
  )
}
