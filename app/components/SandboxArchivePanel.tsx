"use client"

import { useEffect, useState } from "react"
import { Button } from "@/app/components/ui/button"
import { Input } from "@/app/components/ui/input"
import { Badge } from "@/app/components/ui/badge"
import { Alert, AlertDescription } from "@/app/components/ui/alert"
import { Card } from "@/app/components/ui/card"
import type { SandboxInventoryItem } from "../hooks/inventoryModel"

interface SandboxArchivePanelProps {
  sandbox: SandboxInventoryItem
  onRestoreComplete?: () => Promise<void> | void
}

type BackupCatalogEntry = {
  id: string
  fileName: string
  sandboxName: string
  sourcePath: string
  size: number
  createdAt: string
}

function formatBytes(value: number) {
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${Math.ceil(value / 1024)} KiB`
  return `${(value / 1024 / 1024).toFixed(1)} MiB`
}

export default function SandboxArchivePanel({ sandbox, onRestoreComplete }: SandboxArchivePanelProps) {
  const [backupPath, setBackupPath] = useState("/sandbox")
  const [restorePath, setRestorePath] = useState("/sandbox")
  const [restoreReplace, setRestoreReplace] = useState(false)
  const [selectedArchive, setSelectedArchive] = useState<File | null>(null)
  const [catalogBackups, setCatalogBackups] = useState<BackupCatalogEntry[]>([])
  const [busy, setBusy] = useState<"backup" | "catalog" | "restore" | `restore-${string}` | `delete-${string}` | null>(null)
  const [message, setMessage] = useState("")
  const [isError, setIsError] = useState(false)

  async function loadCatalog() {
    const response = await fetch("/api/backups", { cache: "no-store" })
    const data = await response.json()
    if (!response.ok) throw new Error(data.error || "Failed to load backup catalog")
    setCatalogBackups(Array.isArray(data.backups) ? data.backups : [])
  }

  useEffect(() => {
    loadCatalog().catch(() => undefined)
  }, [sandbox.id])

  function setMsg(text: string, error = false) {
    setIsError(error)
    setMessage(text)
  }

  async function backupSandbox() {
    if (!backupPath.trim() || busy) return
    try {
      setBusy("backup")
      setMessage("")
      const pathToBackup = backupPath.trim()
      const response = await fetch(`/api/sandbox/${encodeURIComponent(sandbox.id)}/backup?${new URLSearchParams({ path: pathToBackup })}`)
      if (!response.ok) {
        const data = await response.json().catch(() => ({}))
        throw new Error(data.error || "Failed to create sandbox backup")
      }

      const blob = await response.blob()
      const contentDisposition = response.headers.get("content-disposition") || ""
      const fileName = decodeURIComponent(contentDisposition.match(/filename\*=UTF-8''([^;]+)/)?.[1] || "")
        || contentDisposition.match(/filename="([^"]+)"/)?.[1]
        || `${sandbox.name}-backup.tar.gz`
      const url = window.URL.createObjectURL(blob)
      const anchor = document.createElement("a")
      anchor.href = url
      anchor.download = fileName
      document.body.appendChild(anchor)
      anchor.click()
      anchor.remove()
      window.URL.revokeObjectURL(url)
      setMsg(`Created backup for ${pathToBackup}: ${fileName}.`)
    } catch (error) {
      setMsg(error instanceof Error ? error.message : "Failed to create sandbox backup", true)
    } finally {
      setBusy(null)
    }
  }

  async function saveCatalogBackup() {
    if (!backupPath.trim() || busy) return
    try {
      setBusy("catalog")
      setMessage("")
      const response = await fetch("/api/backups", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sandboxId: sandbox.id, sourcePath: backupPath.trim() }),
      })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || "Failed to save backup to catalog")
      setMsg(`Saved ${data.backup.fileName} to the local backup catalog.`)
      await loadCatalog()
    } catch (error) {
      setMsg(error instanceof Error ? error.message : "Failed to save backup to catalog", true)
    } finally {
      setBusy(null)
    }
  }

  async function restoreSandbox() {
    if (!selectedArchive || !restorePath.trim() || busy) return
    try {
      setBusy("restore")
      setMessage("")
      const form = new FormData()
      form.set("archive", selectedArchive)
      form.set("targetPath", restorePath.trim())
      form.set("replace", restoreReplace ? "true" : "false")
      const response = await fetch(`/api/sandbox/${encodeURIComponent(sandbox.id)}/restore`, {
        method: "POST",
        body: form,
      })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || "Failed to restore sandbox backup")
      setMsg(data.note || `Restored ${selectedArchive.name} into ${restorePath.trim()}.`)
      await onRestoreComplete?.()
    } catch (error) {
      setMsg(error instanceof Error ? error.message : "Failed to restore sandbox backup", true)
    } finally {
      setBusy(null)
    }
  }

  async function restoreCatalogBackup(backupId: string) {
    if (!restorePath.trim() || busy) return
    try {
      setBusy(`restore-${backupId}`)
      setMessage("")
      const response = await fetch(`/api/backups/${encodeURIComponent(backupId)}/restore`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sandboxId: sandbox.id, targetPath: restorePath.trim(), replace: restoreReplace }),
      })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || "Failed to restore catalog backup")
      setMsg(data.note || `Restored catalog backup into ${restorePath.trim()}.`)
      await onRestoreComplete?.()
    } catch (error) {
      setMsg(error instanceof Error ? error.message : "Failed to restore catalog backup", true)
    } finally {
      setBusy(null)
    }
  }

  async function deleteCatalogBackup(backupId: string) {
    if (busy) return
    try {
      setBusy(`delete-${backupId}`)
      setMessage("")
      const response = await fetch(`/api/backups/${encodeURIComponent(backupId)}`, { method: "DELETE" })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || "Failed to delete catalog backup")
      setMsg("Deleted catalog backup.")
      await loadCatalog()
    } catch (error) {
      setMsg(error instanceof Error ? error.message : "Failed to delete catalog backup", true)
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-4 max-lg:flex-col">
        <div>
          <h5 className="text-xs font-semibold uppercase tracking-wider">Backup / Restore</h5>
          <p className="mt-1 text-xs text-muted-foreground">
            Export sandbox contents as a compressed archive, or restore an archive into this sandbox.
          </p>
        </div>
        <Badge variant="outline" className="font-mono text-[10px] tracking-wider">tar.gz</Badge>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card className="p-4 space-y-3">
          <div>
            <h6 className="text-[11px] font-semibold uppercase tracking-wider">Backup</h6>
            <p className="mt-1 text-xs text-muted-foreground">Archive a directory for cold storage or cloning.</p>
          </div>
          <div className="space-y-1.5">
            <label className="text-[10px] uppercase tracking-wider text-muted-foreground">Source Directory</label>
            <Input
              value={backupPath}
              onChange={(event) => setBackupPath(event.target.value)}
              placeholder="/sandbox"
              className="font-mono text-xs"
            />
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              onClick={backupSandbox}
              disabled={!backupPath.trim() || busy !== null}
              size="sm"
            >
              {busy === "backup" ? "Creating Backup…" : "Download Backup"}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={saveCatalogBackup}
              disabled={!backupPath.trim() || busy !== null}
            >
              {busy === "catalog" ? "Saving…" : "Save To Catalog"}
            </Button>
          </div>
        </Card>

        <Card className="p-4 space-y-3">
          <div>
            <h6 className="text-[11px] font-semibold uppercase tracking-wider">Restore</h6>
            <p className="mt-1 text-xs text-muted-foreground">Merge into the target directory, or replace it first.</p>
          </div>
          <input
            type="file"
            accept=".tar.gz,.tgz,application/gzip,application/x-gzip"
            onChange={(event) => setSelectedArchive(event.target.files?.[0] || null)}
            className="block w-full text-xs text-muted-foreground file:mr-3 file:rounded-md file:border file:border-border file:bg-muted file:px-3 file:py-1.5 file:text-xs file:font-mono file:uppercase file:text-foreground"
          />
          <div className="space-y-1.5">
            <label className="text-[10px] uppercase tracking-wider text-muted-foreground">Target Directory</label>
            <Input
              value={restorePath}
              onChange={(event) => setRestorePath(event.target.value)}
              placeholder="/sandbox"
              className="font-mono text-xs"
            />
          </div>
          <label className="flex items-start gap-3 rounded-md border border-border bg-muted/40 p-3">
            <input
              type="checkbox"
              checked={restoreReplace}
              onChange={(event) => setRestoreReplace(event.target.checked)}
              className="mt-0.5 h-4 w-4"
            />
            <span>
              <span className="block text-xs font-mono uppercase tracking-wider">Replace target contents</span>
              <span className="mt-1 block text-[11px] text-muted-foreground">Deletes existing files in the target directory before extracting.</span>
            </span>
          </label>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={restoreSandbox}
            disabled={!selectedArchive || !restorePath.trim() || busy !== null}
          >
            {busy === "restore" ? "Restoring…" : "Restore Archive"}
          </Button>
        </Card>
      </div>

      <Card className="p-4 space-y-3">
        <div className="flex items-start justify-between gap-4 max-md:flex-col">
          <div>
            <h6 className="text-[11px] font-semibold uppercase tracking-wider">Backup Catalog</h6>
            <p className="mt-1 text-xs text-muted-foreground">Host-side cold storage for cloning and redeploying sandboxes later.</p>
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => loadCatalog().catch((error) => setMsg(error.message, true))}
          >
            Refresh Catalog
          </Button>
        </div>

        <div className="space-y-2">
          {catalogBackups.map((backup) => (
            <div key={backup.id} className="rounded-md border border-border bg-muted/30 p-3">
              <div className="flex items-start justify-between gap-4 max-lg:flex-col">
                <div className="min-w-0">
                  <p className="truncate text-xs font-mono">{backup.fileName}</p>
                  <p className="mt-1 text-[10px] uppercase tracking-wider text-muted-foreground">
                    {backup.sandboxName} / {backup.sourcePath} / {formatBytes(backup.size)} / {new Date(backup.createdAt).toLocaleString()}
                  </p>
                </div>
                <div className="flex shrink-0 flex-wrap gap-2">
                  <Button variant="outline" size="sm" asChild>
                    <a href={`/api/backups/${encodeURIComponent(backup.id)}/download`}>Download</a>
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    onClick={() => restoreCatalogBackup(backup.id)}
                    disabled={busy !== null || !restorePath.trim()}
                  >
                    {busy === `restore-${backup.id}` ? "Restoring…" : "Restore Here"}
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => deleteCatalogBackup(backup.id)}
                    disabled={busy !== null}
                  >
                    {busy === `delete-${backup.id}` ? "Deleting…" : "Delete"}
                  </Button>
                </div>
              </div>
            </div>
          ))}
          {catalogBackups.length === 0 && (
            <p className="text-sm text-muted-foreground p-2">No catalog backups saved yet.</p>
          )}
        </div>
      </Card>

      {message && (
        <Alert variant={isError ? "destructive" : "default"}>
          <AlertDescription className="text-xs whitespace-pre-wrap">{message}</AlertDescription>
        </Alert>
      )}
    </div>
  )
}
