import { randomBytes } from "node:crypto"
import { rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { NextResponse } from "next/server"
import { assertRequestContentLength, restoreSandboxArchiveFile } from "@/app/lib/sandboxFiles"
import { recordActivity } from "@/app/lib/activityLog"

export async function POST(
  request: Request,
  { params }: { params: Promise<{ sandboxId: string }> }
) {
  try {
    const { sandboxId } = await params
    assertRequestContentLength(request)
    const form = await request.formData()
    const file = form.get("archive")
    const rawTargetPath = form.get("targetPath")
    const rawReplace = form.get("replace")
    if (!(file instanceof File)) throw new Error("archive is required")

    const targetPath = typeof rawTargetPath === "string" && rawTargetPath.trim()
      ? rawTargetPath.trim()
      : "/sandbox"
    const replace = rawReplace === "true" || rawReplace === "1"
    // server.mjs intercepts POST .../restore before Next.js in production
    // (streaming upload); this handler only serves `next dev` without it.
    const payload = Buffer.from(await file.arrayBuffer())
    const hostFile = path.join(tmpdir(), `openshell-restore-${randomBytes(16).toString("hex")}.tar.gz`)
    await writeFile(hostFile, payload, { mode: 0o600 })
    const restored = await restoreSandboxArchiveFile(sandboxId, targetPath, file.name, hostFile, payload.byteLength, replace)
      .finally(() => rm(hostFile, { force: true }))
    await recordActivity({
      type: "backup.upload.restore",
      status: "success",
      sandboxId,
      sandboxName: restored.sandboxName,
      message: `Restored uploaded archive ${file.name} into ${restored.targetPath}.`,
      metadata: { targetPath: restored.targetPath, mode: restored.mode, bytes: restored.bytes },
    }).catch(() => undefined)

    return NextResponse.json({
      ok: true,
      restored,
      note: `Restored ${file.name} into ${restored.targetPath} (${restored.mode}).`,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to restore sandbox backup"
    await recordActivity({
      type: "backup.upload.restore",
      status: "error",
      message,
    }).catch(() => undefined)
    return NextResponse.json({ ok: false, error: message }, { status: /required|path|large|unsafe|archive/.test(message) ? 400 : 500 })
  }
}
