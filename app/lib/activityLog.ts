import { appendFile, mkdir, readFile, stat, writeFile } from "node:fs/promises"
import path from "node:path"

const ACTIVITY_LOG_PATH = process.env.OPENSHELL_ACTIVITY_LOG_PATH
  || path.join(process.cwd(), ".runtime", "activity-log.jsonl")
const MAX_ACTIVITY_ENTRIES = Number.parseInt(process.env.OPENSHELL_ACTIVITY_LOG_MAX_ENTRIES || "200", 10)
const MAX_ACTIVITY_BYTES = Number.parseInt(process.env.OPENSHELL_ACTIVITY_LOG_MAX_BYTES || String(1024 * 1024), 10)

// Durable audit archive: entries trimmed out of the "hot" activity log are
// APPENDED here rather than discarded, so the full sandbox lifecycle history
// survives rotation. Lives alongside the hot log under .runtime/ (which
// the manidae backup-job stages), and is size-bounded on disk by host logrotate
// (installed by the AgentGateway deploy). Set path to "" (or "off") to opt out.
const ARCHIVE_LOG_PATH_RAW = process.env.OPENSHELL_ACTIVITY_ARCHIVE_PATH
  ?? path.join(path.dirname(ACTIVITY_LOG_PATH), "activity-log.archive.jsonl")
const ARCHIVE_LOG_PATH = /^(off|false|0)$/i.test(ARCHIVE_LOG_PATH_RAW) ? "" : ARCHIVE_LOG_PATH_RAW

// Append rotated-out lines to the durable archive. Best-effort: an archive
// failure must never block recording new activity or reading the hot log.
async function archiveOverflow(overflow: string[]) {
  if (!ARCHIVE_LOG_PATH || overflow.length === 0) return
  try {
    await appendFile(ARCHIVE_LOG_PATH, `${overflow.join("\n")}\n`)
  } catch {
    // archive unavailable (read-only fs, etc.) — retention degrades to the hot
    // log only, but the primary path keeps working.
  }
}

export type ActivityEntry = {
  id: string
  timestamp: string
  type: string
  message: string
  sandboxId?: string
  sandboxName?: string
  status?: "success" | "error" | "info" | "warning"
  metadata?: Record<string, unknown>
}

function compactMetadata(metadata?: Record<string, unknown>) {
  if (!metadata) return undefined
  return Object.fromEntries(
    Object.entries(metadata).filter(([, value]) => value !== undefined && value !== null && value !== ""),
  )
}

async function ensureLogDirectory() {
  await mkdir(path.dirname(ACTIVITY_LOG_PATH), { recursive: true })
}

async function readLogText() {
  try {
    const currentStat = await stat(ACTIVITY_LOG_PATH)
    if (currentStat.size > MAX_ACTIVITY_BYTES) {
      const text = await readFile(ACTIVITY_LOG_PATH, "utf8")
      const all = text.split(/\r?\n/).filter(Boolean)
      // Archive the overflow before trimming so the byte-cap can't lose audit history.
      await archiveOverflow(all.slice(0, Math.max(0, all.length - MAX_ACTIVITY_ENTRIES)))
      const tail = all.slice(-MAX_ACTIVITY_ENTRIES).join("\n")
      await writeFile(ACTIVITY_LOG_PATH, `${tail}\n`)
      return tail
    }
    return await readFile(ACTIVITY_LOG_PATH, "utf8")
  } catch {
    return ""
  }
}

export async function recordActivity(entry: Omit<ActivityEntry, "id" | "timestamp">) {
  const payload: ActivityEntry = {
    id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    timestamp: new Date().toISOString(),
    ...entry,
    metadata: compactMetadata(entry.metadata),
  }

  await ensureLogDirectory()
  const text = await readLogText()
  const lines = text.split(/\r?\n/).filter(Boolean)
  lines.push(JSON.stringify(payload))
  // Archive any entries that rotate out of the hot log rather than dropping them.
  await archiveOverflow(lines.slice(0, Math.max(0, lines.length - MAX_ACTIVITY_ENTRIES)))
  await writeFile(ACTIVITY_LOG_PATH, `${lines.slice(-MAX_ACTIVITY_ENTRIES).join("\n")}\n`)
  return payload
}

export async function listActivity(limit = 100) {
  const safeLimit = Math.max(1, Math.min(limit, MAX_ACTIVITY_ENTRIES))
  const text = await readLogText()
  return text
    .split(/\r?\n/)
    .filter(Boolean)
    .slice(-safeLimit)
    .map((line) => {
      try {
        return JSON.parse(line) as ActivityEntry
      } catch {
        return null
      }
    })
    .filter((entry): entry is ActivityEntry => Boolean(entry))
    .reverse()
}
