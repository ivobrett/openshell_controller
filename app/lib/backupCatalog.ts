import { createReadStream, createWriteStream } from "node:fs"
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises"
import path from "node:path"
import { pipeline } from "node:stream/promises"
import { openSandboxBackup, restoreSandboxArchiveFile } from "./sandboxFiles"

const BACKUP_DIR = process.env.SANDBOX_BACKUP_DIR || path.join(process.cwd(), ".runtime", "backups")
const MAX_BACKUP_COUNT = Number.parseInt(process.env.SANDBOX_BACKUP_CATALOG_MAX || "100", 10)

export type BackupCatalogEntry = {
  id: string
  fileName: string
  sandboxId: string
  sandboxName: string
  sourcePath: string
  size: number
  createdAt: string
}

function sanitizeSegment(value: string) {
  return value.trim().replace(/[^\w.@:+-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "") || "backup"
}

function normalizeBackupId(value: string) {
  const safeId = sanitizeSegment(value)
  if (safeId !== value) throw new Error("backup id contains unsupported characters")
  return safeId
}

function archivePath(id: string) {
  return path.join(BACKUP_DIR, `${id}.tar.gz`)
}

function metadataPath(id: string) {
  return path.join(BACKUP_DIR, `${id}.json`)
}

async function ensureBackupDirectory() {
  await mkdir(BACKUP_DIR, { recursive: true, mode: 0o700 })
}

export async function listBackupCatalog() {
  await ensureBackupDirectory()
  const names = await readdir(BACKUP_DIR).catch(() => [])
  const entries = await Promise.all(
    names
      .filter((name) => name.endsWith(".json"))
      .map(async (name) => {
        try {
          const metadata = JSON.parse(await readFile(path.join(BACKUP_DIR, name), "utf8")) as BackupCatalogEntry
          await stat(archivePath(metadata.id))
          return metadata
        } catch {
          return null
        }
      }),
  )

  return entries
    .filter((entry): entry is BackupCatalogEntry => Boolean(entry))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

export async function createCatalogBackup(sandboxId: string, sourcePath: string) {
  await ensureBackupDirectory()
  const archive = await openSandboxBackup(sandboxId, sourcePath)
  const id = `${sanitizeSegment(archive.sandboxName)}-${Date.now().toString(36)}`

  // Stream straight to disk; a failed or oversized archive must not be left
  // behind looking like a usable backup.
  const { stream, done } = archive.start()
  let size: number
  try {
    await pipeline(stream, createWriteStream(archivePath(id), { mode: 0o600 }))
    size = (await done).bytes
  } catch (error) {
    await rm(archivePath(id), { force: true })
    throw error
  }

  const entry: BackupCatalogEntry = {
    id,
    fileName: archive.fileName,
    sandboxId,
    sandboxName: archive.sandboxName,
    sourcePath: archive.sourcePath,
    size,
    createdAt: archive.createdAt,
  }
  await writeFile(metadataPath(id), `${JSON.stringify(entry, null, 2)}\n`, { mode: 0o600 })

  const entries = await listBackupCatalog()
  await Promise.all(entries.slice(MAX_BACKUP_COUNT).map((stale) => deleteCatalogBackup(stale.id).catch(() => undefined)))

  return entry
}

export async function getCatalogBackup(id: string) {
  const safeId = normalizeBackupId(id)
  const metadata = JSON.parse(await readFile(metadataPath(safeId), "utf8")) as BackupCatalogEntry
  const filePath = archivePath(safeId)
  const { size } = await stat(filePath)
  return { metadata, filePath, size, openStream: () => createReadStream(filePath) }
}

export async function restoreCatalogBackup(id: string, targetSandboxId: string, targetPath: string, replace: boolean) {
  const backup = await getCatalogBackup(id)
  return restoreSandboxArchiveFile(targetSandboxId, targetPath, backup.metadata.fileName, backup.filePath, backup.size, replace)
}

export async function deleteCatalogBackup(id: string) {
  const safeId = normalizeBackupId(id)
  await Promise.all([
    rm(archivePath(safeId), { force: true }),
    rm(metadataPath(safeId), { force: true }),
  ])
  return { id: safeId }
}
