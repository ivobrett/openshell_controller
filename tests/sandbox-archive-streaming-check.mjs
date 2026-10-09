// Guards for streamed sandbox backup / restore (app/lib/sandboxArchive.mjs).
//
// Until 2026-10-09 "Download backup" buffered the whole .tar.gz in controller
// memory and failed with "backup archive is too large; max transfer size is
// 128 MiB" for any real agent sandbox (the Oracle BYOVPS OpenClaw sandbox was
// 3.2 GiB), and restore buffered the multipart upload the same way. Both now
// stream. These checks fail if someone reintroduces a buffered path or the
// 128 MiB transfer cap on archives.

import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'

import {
  archiveMaxBytes,
  normalizeArchiveSandboxPath,
  pickSandboxContainer,
  receiveStreamToFile,
} from '../app/lib/sandboxArchive.mjs'

const read = (relative) => readFile(new URL(`../${relative}`, import.meta.url), 'utf8')

// --- container resolution: exact sandbox name, both OpenShell naming schemes ---
const uuidA = '47706505-1e4f-4899-972f-b44cd926cf6e'
const uuidB = '928c8610-5f00-45cd-bd0c-974a39fbd260'
const uuidC = '11111111-2222-3333-4444-555555555555'
const containers = [
  `openshell-default--ivos-hermes-${uuidA}`, // OpenShell 0.0.116 (workspace-prefixed)
  `openshell-ivos-openclaw-${uuidB}`, // OpenShell <= 0.0.106
  `openshell-default--ivos-hermes2-${uuidC}`,
  'admin-034408_main-stack-traefik-1',
]
assert.equal(pickSandboxContainer(containers, 'ivos-hermes'), containers[0])
assert.equal(pickSandboxContainer(containers, 'ivos-openclaw'), containers[1])
assert.equal(pickSandboxContainer(containers, 'ivos-hermes2'), containers[2], 'a name must not match a longer sibling')
assert.equal(pickSandboxContainer(containers, 'ivos'), null, 'a name prefix must not match')
assert.equal(pickSandboxContainer(containers, uuidB), containers[1], 'sandbox UUID refs resolve too')
assert.equal(pickSandboxContainer(containers, 'traefik'), null)
assert.equal(pickSandboxContainer(containers, ''), null)

// --- path confinement ---
assert.equal(normalizeArchiveSandboxPath(''), '/sandbox')
assert.equal(normalizeArchiveSandboxPath('.hermes'), '/sandbox/.hermes')
assert.equal(normalizeArchiveSandboxPath('/tmp/x/../y'), '/tmp/y')
assert.throws(() => normalizeArchiveSandboxPath('/etc'), /under \/sandbox or \/tmp/)
assert.throws(() => normalizeArchiveSandboxPath('/sandbox/../etc'), /under \/sandbox or \/tmp/)
assert.throws(() => normalizeArchiveSandboxPath('/sandboxes'), /under \/sandbox or \/tmp/)

// --- the archive ceiling is far above the old 128 MiB transfer cap ---
assert.ok(archiveMaxBytes() >= 8 * 1024 * 1024 * 1024, 'default archive ceiling must fit multi-GiB sandboxes')

// --- receiveStreamToFile streams to disk, enforces the cap, cleans up ---
const dir = await mkdtemp(path.join(tmpdir(), 'archive-check-'))
try {
  const ok = path.join(dir, 'ok.bin')
  const written = await receiveStreamToFile(Readable.from([Buffer.alloc(700), Buffer.alloc(300)]), ok, 1000)
  assert.equal(written, 1000)
  assert.equal((await readFile(ok)).byteLength, 1000)

  const tooBig = path.join(dir, 'big.bin')
  await assert.rejects(
    receiveStreamToFile(Readable.from([Buffer.alloc(700), Buffer.alloc(301)]), tooBig, 1000),
    /archive is too large/,
  )
  assert.equal(existsSync(tooBig), false, 'an oversized upload must not leave a partial file behind')
} finally {
  await rm(dir, { recursive: true, force: true })
}

// --- source guards: no buffered archive paths ---
const backupRoute = await read('app/api/sandbox/[sandboxId]/backup/route.ts')
assert.match(backupRoute, /Readable\.toWeb\(stream\)/, 'backup route must stream the archive')
assert.doesNotMatch(backupRoute, /backup\.bytes/, 'backup route must not buffer the archive')
assert.match(backupRoute, /searchParams\.get\("check"\) === "1"/, 'backup route must keep the JSON preflight the UI relies on')

const sandboxFiles = await read('app/lib/sandboxFiles.ts')
assert.doesNotMatch(sandboxFiles, /backup archive is too large; max transfer size/, 'the 128 MiB cap must not apply to backups')
assert.match(sandboxFiles, /createSandboxBackupStream\(/)

const catalog = await read('app/lib/backupCatalog.ts')
assert.match(catalog, /pipeline\(stream, createWriteStream\(/, 'catalog backups must stream to disk')
assert.doesNotMatch(catalog, /readFile\(archivePath/, 'catalog archives must not be read into memory')

const server = await read('server.mjs')
assert.match(server, /receiveStreamToFile\(req, hostTmp, maxBytes\)/, 'raw restore uploads must stream to a host temp file')
assert.match(
  server,
  /declared > multipartLimit\) \{\s*\n\s*throw restoreTooLargeError/,
  'the legacy multipart path must reject oversized bodies before buffering them',
)
assert.match(server, /findSandboxContainer\(sandboxName\)/, 'restore must resolve the container from the exact sandbox name')

const panel = await read('app/components/SandboxArchivePanel.tsx')
assert.doesNotMatch(panel, /response\.blob\(\)/, 'the UI must not read the backup into page memory')
assert.match(panel, /body: selectedArchive,/, 'the UI must upload the archive as the raw request body')
