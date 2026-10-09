import { Readable } from "node:stream"
import { NextResponse } from "next/server"
import { openSandboxBackup } from "@/app/lib/sandboxFiles"
import { recordActivity } from "@/app/lib/activityLog"

function contentDisposition(fileName: string) {
  const fallback = fileName.replace(/[^\w.-]/g, "_") || "sandbox-backup.tar.gz"
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(fileName)}`
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ sandboxId: string }> }
) {
  let sandboxId = ""
  try {
    sandboxId = (await params).sandboxId
    const requestUrl = new URL(request.url)
    const sourcePath = requestUrl.searchParams.get("path") || "/sandbox"
    const backup = await openSandboxBackup(sandboxId, sourcePath)

    // ?check=1 validates the sandbox + path and returns a size estimate without
    // starting the archive. The UI calls it first so errors surface as JSON,
    // then lets the browser download the stream straight to disk.
    if (requestUrl.searchParams.get("check") === "1") {
      return NextResponse.json({
        ok: true,
        sandboxName: backup.sandboxName,
        sourcePath: backup.sourcePath,
        fileName: backup.fileName,
        estimatedBytes: backup.estimatedBytes,
      })
    }

    const { stream, done } = backup.start()
    // The response is already streaming by the time tar finishes, so the
    // outcome can only be recorded, not returned.
    void done.then(
      (result) => recordActivity({
        type: "backup.download",
        status: "success",
        sandboxId,
        sandboxName: backup.sandboxName,
        message: `Created downloadable backup ${backup.fileName}.`,
        metadata: { sourcePath: backup.sourcePath, size: result.bytes, warning: result.warning },
      }),
      (error) => recordActivity({
        type: "backup.download",
        status: "error",
        sandboxId,
        sandboxName: backup.sandboxName,
        message: error instanceof Error ? error.message : "Failed to create sandbox backup",
      }),
    ).catch(() => undefined)

    return new Response(Readable.toWeb(stream) as ReadableStream<Uint8Array>, {
      status: 200,
      headers: {
        "cache-control": "no-store",
        "content-disposition": contentDisposition(backup.fileName),
        "content-type": "application/gzip",
        "x-sandbox-name": backup.sandboxName,
        "x-sandbox-path": backup.sourcePath,
        "x-sandbox-backup-created-at": backup.createdAt,
      },
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to create sandbox backup"
    await recordActivity({
      type: "backup.download",
      status: "error",
      sandboxId: sandboxId || undefined,
      message,
    }).catch(() => undefined)
    const status = /not found|no running container/.test(message) ? 404 : /required|path|large|exist|directory/.test(message) ? 400 : 500
    return NextResponse.json({ ok: false, error: message }, { status })
  }
}
