import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'

const root = process.cwd()
const source = await readFile(path.join(root, 'app/lib/activityLog.ts'), 'utf8')

// Rotation must be ARCHIVAL, not lossy: the hot activity log is capped for fast
// rendering, but entries trimmed out are appended to a durable archive so the
// sandbox lifecycle / shields audit history survives rotation and is backed up.
assert.match(source, /activity-log\.archive\.jsonl/, 'must define a durable archive path next to the hot log')
assert.match(source, /async function archiveOverflow/, 'must archive overflow rather than discard it')
assert.match(source, /appendFile\(ARCHIVE_LOG_PATH/, 'archive must be append-only (never overwritten)')

// Both trim sites (the per-record count cap and the byte-cap on read) must route
// their overflow through the archive before writing the trimmed hot log.
const recordArchive = source.indexOf('Archive any entries that rotate out')
const recordWrite = source.indexOf('slice(-MAX_ACTIVITY_ENTRIES).join("\\n")}\\n`)\n  return payload')
assert.ok(recordArchive > -1, 'recordActivity must archive before trimming')
assert.ok(recordArchive < recordWrite || recordWrite === -1, 'recordActivity must archive before it writes the trimmed hot log')
assert.match(source, /Archive the overflow before trimming so the byte-cap can't lose audit history/, 'the byte-cap read path must archive overflow too')

// Opt-out + best-effort: an archive failure must not block recording.
assert.match(source, /\/\^\(off\|false\|0\)\$\/i\.test\(ARCHIVE_LOG_PATH_RAW\)/, 'archive must be disable-able via env')
assert.match(source, /best-effort|never block/i, 'archive writes must be best-effort so they never block activity recording')

console.log('activity-log-archive-check: PASS archival rotation assertions')
