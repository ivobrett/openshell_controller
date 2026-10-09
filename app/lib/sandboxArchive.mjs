// Streaming sandbox backup/restore primitives, shared by server.mjs (custom
// server, owns the restore upload) and the Next.js route handlers.
//
// Why this exists: backup and restore used to buffer the whole .tar.gz in
// controller memory and refuse anything over SANDBOX_FILE_TRANSFER_MAX_BYTES
// (128 MiB). Real agent sandboxes are routinely multi-GB (the Oracle BYOVPS
// OpenClaw sandbox was 3.2 GiB on 2026-10-09), so "Download backup" always
// failed with "backup archive is too large; max transfer size is 128 MiB".
// Everything here streams: sandbox -> HTTP response / catalog file, and
// HTTP request -> host temp file -> docker cp -> in-sandbox extract.
//
// Transport is `docker exec` / `docker cp`, not `openshell sandbox exec`:
// exec stdin goes through gRPC with a 1 MiB message limit (unusable for
// restore), and a single mechanism for both directions keeps them symmetric.

import { spawn } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import { unlink } from 'node:fs/promises'
import { Transform } from 'node:stream'

const GIB = 1024 * 1024 * 1024
const ALLOWED_SANDBOX_ROOTS = ['/sandbox', '/tmp']
const SANDBOX_UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'

function positiveInt(raw, fallback) {
  const value = Number.parseInt(String(raw ?? ''), 10)
  return Number.isFinite(value) && value > 0 ? value : fallback
}

// Compressed-archive ceiling for streamed backups and raw restore uploads.
// A safety valve against filling the host disk, not a memory limit.
// Read lazily: server.mjs loads .env.local after its static imports resolve.
export function archiveMaxBytes() {
  return positiveInt(process.env.SANDBOX_ARCHIVE_MAX_BYTES, 16 * GIB)
}
export function archiveTimeoutMs() {
  return positiveInt(process.env.SANDBOX_ARCHIVE_TIMEOUT_MS, 60 * 60 * 1000)
}

export function formatArchiveBytes(value) {
  if (value >= GIB) return `${(value / GIB).toFixed(1)} GiB`
  return `${Math.ceil(value / 1024 / 1024)} MiB`
}

export function shellQuote(value) {
  return "'" + String(value).replace(/'/g, "'\\''") + "'"
}

export function normalizeArchiveSandboxPath(input) {
  const raw = String(input ?? '').trim() || '/sandbox'
  if (raw.includes('\0')) throw new Error('sandbox path contains unsupported characters')
  const absolute = raw.startsWith('/') ? raw : `/sandbox/${raw}`
  const parts = []
  for (const part of absolute.split('/')) {
    if (!part || part === '.') continue
    if (part === '..') parts.pop()
    else parts.push(part)
  }
  const normalized = `/${parts.join('/')}`
  if (!ALLOWED_SANDBOX_ROOTS.some((root) => normalized === root || normalized.startsWith(`${root}/`))) {
    throw new Error('sandbox path must be under /sandbox or /tmp')
  }
  return normalized
}

// OpenShell <= 0.0.106 names containers `openshell-<sandbox>-<uuid>`; 0.0.116
// prefixes the workspace: `openshell-<workspace>--<sandbox>-<uuid>`. Match the
// sandbox name exactly so `ivos-hermes` never resolves to `ivos-hermes2`.
export function pickSandboxContainer(containerNames, sandboxRef) {
  const ref = String(sandboxRef ?? '').trim()
  if (!ref) return null
  const escaped = ref.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const byName = new RegExp(`^openshell-(?:[a-z0-9][a-z0-9-]*--)?${escaped}-${SANDBOX_UUID}$`)
  const names = containerNames.map((name) => String(name).trim()).filter(Boolean)
  return names.find((name) => byName.test(name))
    // sandboxRef may be the sandbox UUID rather than its name.
    || (new RegExp(`^${SANDBOX_UUID}$`).test(ref) ? names.find((name) => name.startsWith('openshell-') && name.endsWith(`-${ref}`)) : null)
    || null
}

function run(cmd, args, { input } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('error', reject)
    child.on('close', (code) => resolve({ code, stdout, stderr: stderr.trim() }))
    if (input !== undefined) child.stdin.end(input)
  })
}

export async function findSandboxContainer(sandboxRef) {
  const result = await run('docker', ['ps', '--format', '{{.Names}}'])
  if (result.code !== 0) throw new Error('docker ps failed')
  const name = pickSandboxContainer(result.stdout.split('\n'), sandboxRef)
  if (!name) throw new Error(`no running container found for sandbox ${sandboxRef}`)
  return name
}

// Uncompressed size of a sandbox directory, for the pre-download estimate.
export async function estimateSandboxPathBytes(containerName, targetPath) {
  const result = await run('docker', [
    'exec', '-u', 'sandbox', containerName, 'sh', '-c',
    `test -d ${shellQuote(targetPath)} && du -sk ${shellQuote(targetPath)} 2>/dev/null | cut -f1`,
  ])
  if (result.code !== 0) throw new Error('sandbox directory does not exist or is not readable')
  const kib = Number.parseInt(result.stdout.trim(), 10)
  return Number.isFinite(kib) ? kib * 1024 : null
}

// Stream `tar -czf -` of a sandbox directory. Returns the readable archive
// stream plus a promise that settles when tar exits. The stream is destroyed
// with an error (so an HTTP download aborts instead of ending as a silently
// truncated .tar.gz) when tar fails, the size cap is hit, or it times out.
export function createSandboxBackupStream({ containerName, targetPath, maxBytes = archiveMaxBytes(), timeoutMs = archiveTimeoutMs() }) {
  const child = spawn('docker', [
    'exec', '-u', 'sandbox', containerName, 'sh', '-c',
    `test -d ${shellQuote(targetPath)} && exec tar -C ${shellQuote(targetPath)} -czf - .`,
  ], { stdio: ['ignore', 'pipe', 'pipe'] })

  let bytes = 0
  let stderr = ''
  let failure = null
  const counter = new Transform({
    transform(chunk, _encoding, callback) {
      bytes += chunk.byteLength
      if (bytes > maxBytes) {
        failure = new Error(`backup archive is too large; max archive size is ${formatArchiveBytes(maxBytes)} (SANDBOX_ARCHIVE_MAX_BYTES)`)
        child.kill('SIGTERM')
        callback(failure)
        return
      }
      callback(null, chunk)
    },
    // The archive is only complete once tar has exited cleanly; hold the end
    // of the stream until then so a failed tar never looks like a good file.
    flush(callback) {
      exited.then(() => callback(), callback)
    },
  })
  const timer = setTimeout(() => {
    failure = new Error('backup timed out (SANDBOX_ARCHIVE_TIMEOUT_MS)')
    child.kill('SIGTERM')
  }, timeoutMs)
  child.stderr.on('data', (chunk) => { stderr = `${stderr}${chunk}`.slice(-2000) })

  const exited = new Promise((resolve, reject) => {
    child.on('error', (error) => { clearTimeout(timer); reject(error) })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (failure) return reject(failure)
      // tar exits 1 for "file changed as we read it" — expected on a live
      // agent and the archive is still usable. >= 2 is a real failure.
      if (code !== 0 && code !== 1) return reject(new Error(stderr.trim() || 'failed to create sandbox backup archive'))
      resolve({ bytes, warning: code === 1 ? (stderr.trim() || 'some files changed while they were archived') : null })
    })
  })
  exited.catch(() => undefined)
  child.stdout.pipe(counter)
  // If the consumer goes away (browser cancelled the download), stop tar.
  counter.on('close', () => { if (child.exitCode === null) child.kill('SIGTERM') })

  return { stream: counter, done: exited }
}

// Stream an HTTP request body (or any readable) to a host file with a byte cap.
export function receiveStreamToFile(readable, filePath, maxBytes = archiveMaxBytes()) {
  return new Promise((resolve, reject) => {
    const out = createWriteStream(filePath, { mode: 0o600 })
    let bytes = 0
    let settled = false
    const fail = (error) => {
      if (settled) return
      settled = true
      readable.unpipe?.(out)
      out.destroy()
      unlink(filePath).catch(() => undefined).finally(() => reject(error))
    }
    readable.on('data', (chunk) => {
      bytes += chunk.byteLength
      if (bytes > maxBytes) {
        fail(new Error(`archive is too large; max archive size is ${formatArchiveBytes(maxBytes)} (SANDBOX_ARCHIVE_MAX_BYTES)`))
      }
    })
    readable.on('error', fail)
    readable.on('aborted', () => fail(new Error('upload was interrupted')))
    out.on('error', fail)
    out.on('finish', () => { if (!settled) { settled = true; resolve(bytes) } })
    readable.pipe(out)
  })
}

// Restore a host-side .tar.gz into a sandbox directory: docker cp it in (no
// gRPC size limit), validate entry paths/types, then extract as the sandbox user.
export async function restoreArchiveFileIntoSandbox({ containerName, hostFile, targetPath, replace, token }) {
  const containerTmp = `/tmp/openshell-restore-${token}.tar.gz`
  const cp = await run('docker', ['cp', hostFile, `${containerName}:${containerTmp}`])
  if (cp.code !== 0) throw new Error(`docker cp failed: ${cp.stderr}`)
  try {
    // Make the file readable by the sandbox user (docker cp creates root-owned files).
    await run('docker', ['exec', '-u', 'root', containerName, 'chmod', '644', containerTmp])
    const qt = shellQuote(targetPath)
    // --warning=no-unknown-keyword: silence macOS PAX header keywords (SCHILY.fflags etc.)
    // --exclude='._*': skip macOS AppleDouble resource-fork sidecar files
    // tar exits 1 for "some files differ" (non-fatal warnings), 2 for fatal errors.
    // Use newline-separated commands (not &&) so ec=$? always runs; treat exit 1 as success.
    const tarFlags = `--warning=no-unknown-keyword --exclude='._*'`
    const script = [
      `tmp=${shellQuote(containerTmp)}`,
      `tar -tzf "$tmp" ${tarFlags} >/tmp/openshell-restore-list.$$ 2>/dev/null || { ec=$?; test "$ec" -eq 1 || { rm -f /tmp/openshell-restore-list.$$; exit "$ec"; }; }`,
      `tar -tvzf "$tmp" ${tarFlags} >/tmp/openshell-restore-verbose.$$ 2>/dev/null || { ec=$?; test "$ec" -eq 1 || { rm -f /tmp/openshell-restore-list.$$ /tmp/openshell-restore-verbose.$$; exit "$ec"; }; }`,
      `while IFS= read -r e; do case "$e" in ""|/*|../*|*/../*|*"/..") rm -f /tmp/openshell-restore-list.$$ /tmp/openshell-restore-verbose.$$; exit 42;; esac; done < /tmp/openshell-restore-list.$$`,
      // Entry types: regular files, directories and symlinks are accepted — a
      // full /sandbox backup always contains symlinks (node_modules/.bin,
      // .hermes/state.db-wal -> runtime/...), so rejecting them made our own
      // backups unrestorable. GNU tar (no -P) defers symlinks with absolute or
      // ".." targets until the end of extraction, so nothing is written
      // through them. Hard links are accepted only when their target is a
      // relative path inside the archive. Devices, FIFOs and sockets are refused.
      `while IFS= read -r e; do case "$e" in [-dl]*) :;; h*) case "$e" in *" link to /"*|*" link to ../"*|*" link to "*"/../"*) rm -f /tmp/openshell-restore-list.$$ /tmp/openshell-restore-verbose.$$; exit 43;; esac;; *) rm -f /tmp/openshell-restore-list.$$ /tmp/openshell-restore-verbose.$$; exit 43;; esac; done < /tmp/openshell-restore-verbose.$$`,
      `mkdir -p ${qt}`,
      replace ? `find ${qt} -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +` : ':',
      `if grep -q '^payload/' /tmp/openshell-restore-list.$$; then tar -xzf "$tmp" -C ${qt} --strip-components=1 --wildcards 'payload/*' ${tarFlags} 2>/dev/null; else tar -xzf "$tmp" -C ${qt} ${tarFlags} 2>/dev/null; fi`,
      `ec=$?`,
      `rm -f /tmp/openshell-restore-list.$$ /tmp/openshell-restore-verbose.$$ 2>/dev/null`,
      `test "$ec" -le 1 || exit "$ec"`,
    ].join('\n')
    const exec = await run('docker', ['exec', '-u', 'sandbox', containerName, 'sh', '-lc', script])
    if (exec.code === 42) throw new Error('archive contains unsafe paths')
    if (exec.code === 43) throw new Error('archive contains unsupported entry types')
    if (exec.code !== 0) throw new Error(exec.stderr || 'failed to restore sandbox archive')
  } finally {
    // The sandbox user does not own the docker-cp'd file, so remove it as root.
    await run('docker', ['exec', '-u', 'root', containerName, 'rm', '-f', containerTmp]).catch(() => undefined)
  }
}
