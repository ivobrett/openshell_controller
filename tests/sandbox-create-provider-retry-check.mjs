// A fresh OpenClaw create failed in 18s on 2026-10-23 because NVIDIA Endpoints
// answered NemoClaw's validation probe with HTTP 500 for a few minutes.
// Non-interactive onboarding aborts on that; the create route retries it with
// backoff, but only for transient upstream/transport failures that aborted
// before a sandbox existed, never for a bad key or model.

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { isProviderTransientFailure, PROVIDER_RETRY_DELAYS_MS } from '../app/lib/sandboxCreateState.mjs'

// The real stderr tail from that run (trimmed).
const live = 'NVIDIA Endpoints endpoint validation failed. Validation probe summary: Chat Completions API: HTTP 500. ' +
  'Validation details were omitted to avoid exposing credentials. The provider endpoint is reachable but currently failing upstream. ' +
  "Onboard aborted before a sandbox was created; releasing managed gateway 'nemoclaw' so provider credentials do not remain in a live process."
const run = (stderr, extra = {}) => ({ completed: true, timedOut: false, exitCode: 1, stderr, stdout: '', ...extra })

assert.equal(isProviderTransientFailure(run(live)), true, 'NVIDIA 500 during validation is retried')
assert.equal(isProviderTransientFailure(run(live.replace('currently failing upstream', 'rate limiting validation requests right now'))), true, '429 is retried')
assert.equal(isProviderTransientFailure(run('Validation timed out before the provider replied. Onboard aborted before a sandbox was created')), true)

assert.equal(isProviderTransientFailure(run(live + ' HTTP 401 Unauthorized')), false, 'a credential failure is never retried')
assert.equal(isProviderTransientFailure(run('The provider endpoint is reachable but currently failing upstream.')), false, 'only when no sandbox was created')
assert.equal(isProviderTransientFailure(run('docker build failed')), false)
assert.equal(isProviderTransientFailure(run(live, { exitCode: 0 })), false)
assert.equal(isProviderTransientFailure(run(live, { timedOut: true })), false, 'a timed-out run is not retried')
assert.equal(isProviderTransientFailure(run(live, { completed: false })), false)
assert.equal(isProviderTransientFailure(null), false)

assert.ok(PROVIDER_RETRY_DELAYS_MS.length >= 2 && PROVIDER_RETRY_DELAYS_MS.reduce((a, b) => a + b, 0) <= 5 * 60_000,
  'a few bounded retries, not an open-ended loop')

const route = await readFile(new URL('../app/api/sandbox/create/route.ts', import.meta.url), 'utf8')
assert.match(route, /for \(const delayMs of PROVIDER_RETRY_DELAYS_MS\) \{\s*if \(!isProviderTransientFailure\(result\)\) break/,
  'the create route retries transient provider failures with the bounded delays')
console.log('sandbox-create-provider-retry-check: PASS')
