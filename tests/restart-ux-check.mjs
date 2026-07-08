import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'

// Phase 4 (§12.4 / §12.7). The "Restart runtime" action is recovery-first
// server-side: it can take up to ~2 minutes (nemoclaw recover 90 s + runtime
// fallback 45 s + ready-wait) and, when the sandbox isn't Ready, returns 409
// with restarted:false + a note — which is a WARNING, not a success. The shared
// helper app/lib/restartRuntime.ts must honour all three: the long timeout, the
// restartMode-aware success copy, and the not-a-success 409 branch.

const root = process.cwd()
const source = await readFile(path.join(root, 'app/lib/restartRuntime.ts'), 'utf8')
const dense = source.replace(/\s+/g, '')

assert.ok(dense.includes('AbortSignal.timeout(180_000)'), 'restart must use AbortSignal.timeout(180_000)')
assert.ok(source.includes('restartMode'), 'restart must branch on restartMode')
assert.ok(source.includes('nemoclaw-recover'), 'restart success copy must distinguish nemoclaw-recover')
assert.ok(source.includes('toast.warning'), 'not-Ready result must be surfaced as a warning, not success')
assert.ok(dense.includes('status===409'), 'restart must treat the 409 not-Ready response specially')

console.log('PASS: restart-ux-check')
