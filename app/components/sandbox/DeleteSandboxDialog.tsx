"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { queryClient } from "@/app/lib/queryClient"
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
} from "@/app/components/ui/alert-dialog"
import { Button } from "@/app/components/ui/button"
import { Input } from "@/app/components/ui/input"
import { Alert, AlertDescription } from "@/app/components/ui/alert"
import type { SandboxInventoryItem } from "@/app/hooks/inventoryModel"

interface DeleteSandboxDialogProps {
  sandbox: SandboxInventoryItem | null
  open: boolean
  onOpenChange: (open: boolean) => void
  onCurrentPage?: boolean
}

function sleep(ms: number) {
  return new Promise<void>((r) => window.setTimeout(r, ms))
}

async function refetchUntilGone(name: string): Promise<boolean> {
  for (let i = 0; i < 10; i++) {
    await queryClient.refetchQueries({ queryKey: ["inventory"] })
    const data = queryClient.getQueryData<any>(["inventory"])
    const sandboxes = data?.sandboxes ?? []
    if (!sandboxes.find((s: SandboxInventoryItem) => s.id === name || s.name === name)) return true
    await sleep(1500)
  }
  await queryClient.refetchQueries({ queryKey: ["inventory"] })
  return false
}

export function DeleteSandboxDialog({
  sandbox,
  open,
  onOpenChange,
  onCurrentPage,
}: DeleteSandboxDialogProps) {
  const router = useRouter()
  const [confirmName, setConfirmName] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const name = sandbox?.name ?? ""
  const isRunning = sandbox?.status === "running"
  const confirmed = confirmName === name

  const handleDelete = async () => {
    if (!sandbox || !confirmed || busy) return
    setBusy(true)
    setError(null)
    try {
      const r = await fetch("/api/sandbox/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sandboxName: name, agent: sandbox.agent || "openclaw" }),
      })
      const data = await r.json()
      if (!r.ok) {
        throw new Error(
          [data.error, data.stdout, data.stderr].filter(Boolean).join("\n\n") || "Failed to destroy sandbox",
        )
      }
      const gone = await refetchUntilGone(name)
      queryClient.invalidateQueries({ queryKey: ["activity"] })
      toast[gone ? "success" : "warning"](
        gone
          ? `Sandbox ${name} deleted`
          : `Delete started for ${name}. Inventory still reports it while cleanup finishes.`,
      )
      onOpenChange(false)
      setConfirmName("")
      if (onCurrentPage) router.push("/")
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to destroy sandbox"
      setError(msg)
    } finally {
      setBusy(false)
    }
  }

  return (
    <AlertDialog open={open} onOpenChange={(v) => { if (!busy) { onOpenChange(v); if (!v) { setConfirmName(""); setError(null) } } }}>
      <AlertDialogContent className="max-w-md">
        <AlertDialogTitle>Delete sandbox {name}?</AlertDialogTitle>
        <AlertDialogDescription>
          This permanently destroys the sandbox and its data. This cannot be undone.
        </AlertDialogDescription>

        {isRunning && (
          <div className="flex items-center justify-between gap-3 rounded-md border border-border p-3">
            <p className="text-xs text-muted-foreground">Download a backup of /sandbox first</p>
            <Button
              variant="outline"
              size="sm"
              asChild
            >
              <a href={`/api/sandbox/${encodeURIComponent(sandbox!.id)}/backup?path=/sandbox`} download>
                Download backup
              </a>
            </Button>
          </div>
        )}

        <div className="space-y-2">
          <label className="text-xs text-muted-foreground">
            Type the sandbox name to confirm
          </label>
          <Input
            value={confirmName}
            onChange={(e) => setConfirmName(e.target.value)}
            placeholder={name}
            disabled={busy}
            autoComplete="off"
          />
        </div>

        {error && (
          <Alert variant="destructive">
            <AlertDescription className="font-mono text-xs whitespace-pre-wrap">{error}</AlertDescription>
          </Alert>
        )}

        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
          <Button
            variant="destructive"
            disabled={!confirmed || busy}
            onClick={handleDelete}
          >
            {busy ? "Deleting…" : "Delete sandbox"}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
