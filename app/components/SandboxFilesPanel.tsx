"use client"

import { useEffect, useMemo, useState } from "react"
import { Button } from "@/app/components/ui/button"
import { Input } from "@/app/components/ui/input"
import { Alert, AlertDescription } from "@/app/components/ui/alert"
import type { SandboxInventoryItem } from "../hooks/inventoryModel"

type SandboxFileEntry = {
  name: string
  path: string
  type: "file" | "directory" | "symlink" | "other"
  size: number | null
  modifiedAt: string | null
}

type SandboxFileListing = {
  path: string
  entries: SandboxFileEntry[]
  truncated: boolean
}

function formatBytes(bytes: number | null) {
  if (bytes === null) return "-"
  if (bytes < 1024) return `${bytes} B`
  const units = ["KiB", "MiB", "GiB"]
  let value = bytes / 1024
  let unitIndex = 0
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024
    unitIndex += 1
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unitIndex]}`
}

function parentPath(currentPath: string) {
  const trimmed = currentPath.replace(/\/+$/, "")
  if (trimmed === "/sandbox" || trimmed === "/tmp") return trimmed
  const parent = trimmed.split("/").slice(0, -1).join("/") || "/sandbox"
  return parent === "" ? "/sandbox" : parent
}

export default function SandboxFilesPanel({
  sandbox,
  embedded = false,
  showHeader = true,
}: {
  sandbox: SandboxInventoryItem
  embedded?: boolean
  showHeader?: boolean
}) {
  const [selectedFile, setSelectedFile] = useState<File | null>(null)
  const [selectedDirectoryFiles, setSelectedDirectoryFiles] = useState<File[]>([])
  const [uploadMode, setUploadMode] = useState<"file" | "directory">("file")
  const [uploadPath, setUploadPath] = useState("/sandbox/")
  const [downloadPath, setDownloadPath] = useState("/sandbox/")
  const [busy, setBusy] = useState<"upload" | "download" | null>(null)
  const [listPath, setListPath] = useState("/sandbox")
  const [listing, setListing] = useState<SandboxFileListing | null>(null)
  const [listingBusy, setListingBusy] = useState(false)
  const [message, setMessage] = useState("")
  const [isError, setIsError] = useState(false)

  const suggestedUploadPath = useMemo(() => {
    if (!selectedFile) return uploadPath
    return uploadPath.endsWith("/") ? `${uploadPath}${selectedFile.name}` : uploadPath
  }, [selectedFile, uploadPath])
  const uploadCount = uploadMode === "directory" ? selectedDirectoryFiles.length : selectedFile ? 1 : 0

  const sortedEntries = useMemo(() => {
    return [...(listing?.entries || [])].sort((left, right) => {
      if (left.type === "directory" && right.type !== "directory") return -1
      if (left.type !== "directory" && right.type === "directory") return 1
      return left.name.localeCompare(right.name)
    })
  }, [listing])

  function setMsg(text: string, error = false) {
    setIsError(error)
    setMessage(text)
  }

  async function loadFileList(nextPath = listPath) {
    if (listingBusy) return
    try {
      setListingBusy(true)
      setMessage("")
      const response = await fetch(`/api/sandbox/${encodeURIComponent(sandbox.id)}/files/list?${new URLSearchParams({ path: nextPath.trim() || "/sandbox" })}`, {
        cache: "no-store",
      })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || "Failed to list sandbox files")
      setListing(data.listing)
      setListPath(data.listing.path)
    } catch (error) {
      setMsg(error instanceof Error ? error.message : "Failed to list sandbox files", true)
    } finally {
      setListingBusy(false)
    }
  }

  useEffect(() => {
    setListPath("/sandbox")
    setDownloadPath("/sandbox/")
    setListing(null)
  }, [sandbox.id])

  useEffect(() => {
    loadFileList("/sandbox")
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sandbox.id])

  async function uploadFile() {
    if (uploadCount === 0 || busy) return
    try {
      setBusy("upload")
      setMessage("")
      const form = new FormData()
      form.set("path", uploadPath)
      if (uploadMode === "directory") {
        form.set("relativePaths", JSON.stringify(selectedDirectoryFiles.map((file) => file.webkitRelativePath || file.name)))
        for (const file of selectedDirectoryFiles) {
          form.append("files", file, file.name)
        }
      } else if (selectedFile) {
        form.set("file", selectedFile)
      }
      const response = await fetch(`/api/sandbox/${encodeURIComponent(sandbox.id)}/files/upload`, {
        method: "POST",
        body: form,
      })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || "Failed to upload file")
      setMsg(data.note || "Upload complete.")
      if (uploadMode === "directory") {
        setDownloadPath(uploadPath)
      } else {
        setDownloadPath(data.uploaded?.path || suggestedUploadPath)
      }
      await loadFileList(listPath)
    } catch (error) {
      setMsg(error instanceof Error ? error.message : "Failed to upload file", true)
    } finally {
      setBusy(null)
    }
  }

  async function downloadFile(pathOverride?: string) {
    const pathToDownload = (pathOverride || downloadPath).trim()
    if (!pathToDownload || busy) return
    try {
      setBusy("download")
      setMessage("")
      const response = await fetch(`/api/sandbox/${encodeURIComponent(sandbox.id)}/files/download?${new URLSearchParams({ path: pathToDownload })}`)
      if (!response.ok) {
        const data = await response.json().catch(() => ({}))
        throw new Error(data.error || "Failed to download file")
      }

      const blob = await response.blob()
      const contentDisposition = response.headers.get("content-disposition") || ""
      const fileName = decodeURIComponent(contentDisposition.match(/filename\*=UTF-8''([^;]+)/)?.[1] || "")
        || contentDisposition.match(/filename="([^"]+)"/)?.[1]
        || pathToDownload.split("/").filter(Boolean).pop()
        || "download.bin"
      const url = window.URL.createObjectURL(blob)
      const anchor = document.createElement("a")
      anchor.href = url
      anchor.download = fileName
      document.body.appendChild(anchor)
      anchor.click()
      anchor.remove()
      window.URL.revokeObjectURL(url)
      setMsg(`Downloaded ${pathToDownload}.`)
    } catch (error) {
      setMsg(error instanceof Error ? error.message : "Failed to download file", true)
    } finally {
      setBusy(null)
    }
  }

  const openEntry = (entry: SandboxFileEntry) => {
    if (entry.type === "directory") {
      setListPath(entry.path)
      loadFileList(entry.path)
      return
    }
    setDownloadPath(entry.path)
  }

  return (
    <div className={embedded ? "" : "space-y-0"}>
      {showHeader && (
        <div className="flex items-center justify-between gap-4 border-b border-border pb-4 mb-5">
          <div>
            <h4 className="text-sm font-semibold uppercase tracking-wider">
              {sandbox.name} — File Transfer
            </h4>
            <p className="mt-1 text-xs text-muted-foreground">
              Move files through scoped sandbox paths.
            </p>
          </div>
        </div>
      )}

      <div className={`${showHeader ? "" : ""} grid grid-cols-1 xl:grid-cols-[minmax(0,0.9fr)_minmax(0,1.2fr)] gap-5`}>
        <section className="rounded-md border border-border bg-muted/30 p-4 space-y-4">
          <div>
            <h5 className="text-xs font-semibold uppercase tracking-wider">Upload</h5>
            <p className="mt-1 text-xs text-muted-foreground">Destination must be under /sandbox or /tmp.</p>
          </div>
          <input
            type="file"
            onChange={(event) => {
              setUploadMode("file")
              setSelectedFile(event.target.files?.[0] || null)
              setSelectedDirectoryFiles([])
            }}
            className="block w-full text-xs text-muted-foreground file:mr-3 file:rounded-md file:border file:border-border file:bg-muted file:px-3 file:py-1.5 file:text-xs file:font-mono file:uppercase file:text-foreground"
          />
          <input
            type="file"
            multiple
            {...({ webkitdirectory: "", directory: "" } as Record<string, string>)}
            onChange={(event) => {
              setUploadMode("directory")
              setSelectedDirectoryFiles(Array.from(event.target.files || []))
              setSelectedFile(null)
            }}
            className="block w-full text-xs text-muted-foreground file:mr-3 file:rounded-md file:border file:border-border file:bg-muted file:px-3 file:py-1.5 file:text-xs file:font-mono file:uppercase file:text-foreground"
          />
          <div className="space-y-1.5">
            <label className="text-[10px] uppercase tracking-wider text-muted-foreground">Destination Path</label>
            <Input
              value={uploadPath}
              onChange={(event) => setUploadPath(event.target.value)}
              placeholder="/sandbox/file.txt"
              className="font-mono text-xs"
            />
            {selectedFile && (
              <p className="text-[11px] font-mono text-muted-foreground">Target: {suggestedUploadPath}</p>
            )}
            {uploadMode === "directory" && selectedDirectoryFiles.length > 0 && (
              <p className="text-[11px] font-mono text-muted-foreground">
                Directory upload: {selectedDirectoryFiles.length} file{selectedDirectoryFiles.length === 1 ? "" : "s"} into {uploadPath}
              </p>
            )}
          </div>
          <Button
            onClick={uploadFile}
            disabled={uploadCount === 0 || busy !== null}
            size="sm"
          >
            {busy === "upload" ? "Uploading…" : uploadMode === "directory" ? "Upload Directory" : "Upload File"}
          </Button>
        </section>

        <section className="rounded-md border border-border bg-muted/30 p-4 space-y-4">
          <div>
            <h5 className="text-xs font-semibold uppercase tracking-wider">Download</h5>
            <p className="mt-1 text-xs text-muted-foreground">Browse sandbox files or enter a file or directory path under /sandbox or /tmp.</p>
          </div>
          <div className="grid grid-cols-1 gap-2 md:grid-cols-[1fr_auto_auto]">
            <Input
              value={listPath}
              onChange={(event) => setListPath(event.target.value)}
              placeholder="/sandbox"
              className="font-mono text-xs"
            />
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => loadFileList(listPath)}
              disabled={listingBusy}
            >
              {listingBusy ? "Loading…" : "List"}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => loadFileList(parentPath(listPath))}
              disabled={listingBusy || listPath === "/sandbox" || listPath === "/tmp"}
            >
              Up
            </Button>
          </div>
          <div className="overflow-hidden rounded-md border border-border bg-background">
            <div className="grid grid-cols-[1fr_84px_116px_76px] gap-3 border-b border-border px-3 py-2 text-[10px] uppercase tracking-wider text-muted-foreground max-md:grid-cols-[1fr_72px]">
              <span>Name</span>
              <span className="max-md:hidden">Size</span>
              <span className="max-md:hidden">Modified</span>
              <span className="text-right">Action</span>
            </div>
            <div className="max-h-72 overflow-auto">
              {listingBusy ? (
                <div className="px-3 py-8 text-center text-xs font-mono uppercase tracking-wider text-muted-foreground">
                  Reading sandbox directory…
                </div>
              ) : sortedEntries.length === 0 ? (
                <div className="px-3 py-8 text-center text-xs text-muted-foreground">
                  {listing ? "No files found in this directory." : "File list has not loaded yet."}
                </div>
              ) : (
                sortedEntries.map((entry) => (
                  <div
                    key={entry.path}
                    className="grid grid-cols-[1fr_84px_116px_76px] items-center gap-3 border-b border-border px-3 py-2 last:border-b-0 hover:bg-muted/40 max-md:grid-cols-[1fr_72px]"
                  >
                    <button
                      type="button"
                      onClick={() => openEntry(entry)}
                      className="min-w-0 text-left"
                      title={entry.path}
                    >
                      <span className="flex min-w-0 items-center gap-2">
                        <span className={`h-2 w-2 shrink-0 rounded-full ${entry.type === "directory" ? "bg-primary" : "bg-muted-foreground"}`} />
                        <span className="truncate text-xs font-mono">{entry.name}</span>
                      </span>
                    </button>
                    <span className="text-xs font-mono text-muted-foreground max-md:hidden">{entry.type === "directory" ? "dir" : formatBytes(entry.size)}</span>
                    <span className="text-xs font-mono text-muted-foreground max-md:hidden">
                      {entry.modifiedAt ? new Date(entry.modifiedAt).toLocaleDateString() : "-"}
                    </span>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        setDownloadPath(entry.path)
                        downloadFile(entry.path)
                      }}
                      disabled={(entry.type !== "file" && entry.type !== "directory") || busy !== null}
                      className="h-7 px-2 justify-end"
                    >
                      Get
                    </Button>
                  </div>
                ))
              )}
            </div>
          </div>
          {listing?.truncated && (
            <p className="text-[11px] text-muted-foreground">
              Showing the first 200 entries. Narrow the path to see more.
            </p>
          )}
          <div className="space-y-1.5">
            <label className="text-[10px] uppercase tracking-wider text-muted-foreground">Source Path</label>
            <Input
              value={downloadPath}
              onChange={(event) => setDownloadPath(event.target.value)}
              placeholder="/sandbox/file.txt"
              className="font-mono text-xs"
            />
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => downloadFile()}
            disabled={!downloadPath.trim() || busy !== null}
          >
            {busy === "download" ? "Downloading…" : "Download Path"}
          </Button>
        </section>
      </div>

      {message && (
        <Alert variant={isError ? "destructive" : "default"} className="mt-4">
          <AlertDescription className="text-xs whitespace-pre-wrap">{message}</AlertDescription>
        </Alert>
      )}
    </div>
  )
}
