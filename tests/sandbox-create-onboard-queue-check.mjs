// NemoClaw onboarding is host-exclusive: a second `nemoclaw onboard` started
// while one is running exits in ~2s with "Cannot update onboarding recovery
// because the onboarding lock is unavailable". On a fresh BYOVPS (2026-10-09)
// creating Hermes three minutes after OpenClaw — while OpenClaw's first image
// build was still running — therefore failed instantly and Hermes was never
// created. The create route must queue onboard runs and wait out a lock held
// by someone else.

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { isOnboardLockBusy, runExclusiveOnboard } from '../app/lib/sandboxCreateState.mjs'

// --- runs never overlap, and keep their order ---
const events = []
const task = (name, ms) => () => new Promise((resolve) => {
  events.push(`start:${name}`)
  setTimeout(() => { events.push(`end:${name}`); resolve(name) }, ms)
})
const results = await Promise.all([
  runExclusiveOnboard(task('openclaw', 40)),
  runExclusiveOnboard(task('hermes', 5)),
  runExclusiveOnboard(task('third', 1)),
])
assert.deepEqual(results, ['openclaw', 'hermes', 'third'])
assert.deepEqual(events, ['start:openclaw', 'end:openclaw', 'start:hermes', 'end:hermes', 'start:third', 'end:third'])

// --- a failed onboard rejects its own caller but does not poison the queue ---
await assert.rejects(runExclusiveOnboard(() => Promise.reject(new Error('build failed'))), /build failed/)
assert.equal(await runExclusiveOnboard(async () => 'next create still runs'), 'next create still runs')

// --- lock-busy detection ---
const lockMessage = 'Error: Cannot update onboarding recovery because the onboarding lock is unavailable. Recorded lock PID: 19294.'
assert.equal(isOnboardLockBusy({ stderr: lockMessage, exitCode: 1 }), true)
assert.equal(isOnboardLockBusy({ stdout: lockMessage, stderr: '' }), true)
assert.equal(isOnboardLockBusy({ stderr: 'docker build failed', exitCode: 1 }), false)
assert.equal(isOnboardLockBusy({ stderr: lockMessage, timedOut: true }), false, 'a timed-out run is not retried as lock-busy')
assert.equal(isOnboardLockBusy(null), false)

// --- the create route uses both ---
const route = await readFile(new URL('../app/api/sandbox/create/route.ts', import.meta.url), 'utf8')
assert.match(route, /const runOnboardOnce = \(\) =>\s*\n\s*runExclusiveOnboard\(\(\) =>/, 'onboard runs must go through the queue')
assert.match(route, /while \(isOnboardLockBusy\(result\) && Date\.now\(\) - lockWaitStartedAt < ONBOARD_LOCK_WAIT_MS\)/, 'an externally held lock must be waited out, with a bound')
