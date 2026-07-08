import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'

// Phase 4b (§12.3 / §12.7). Guards the terminal auto-reconnect + keepalive
// invariants in app/hooks/useTerminalConnection.ts. These are the behaviours
// that make "I left the tab for 5 minutes and my shell died" not happen:
//   - fixed backoff schedule [1000,2000,4000,8000,15000] (5 attempts)
//   - reconnect reuses the SAME sessionId (server replays the 200 kB buffer);
//     the sessionId is only cleared on an explicit reset/new-session
//   - visibilitychange + online listeners force an immediate reconnect
//   - a 25 s {type:"ping"} keepalive runs only while the tab is visible
// If any of these regress, the terminal silently loses its rock-solidity.

const root = process.cwd()
const source = await readFile(path.join(root, 'app/hooks/useTerminalConnection.ts'), 'utf8')
const dense = source.replace(/\s+/g, '')

// 1. Backoff schedule present, exactly.
assert.ok(
  dense.includes('[1000,2000,4000,8000,15000]'),
  'reconnect backoff schedule [1000,2000,4000,8000,15000] missing',
)

// 2. Wake-from-sleep / network-restored listeners registered.
assert.ok(source.includes('"visibilitychange"'), 'visibilitychange listener missing')
assert.ok(source.includes('"online"'), 'online listener missing')

// 3. Same-sessionId reuse on reconnect: liveSessionIdRef is cleared ONLY in the
//    reset path, never in the scheduled-reconnect path. Exactly one clear site.
const clearCount = (source.match(/liveSessionIdRef\.current\s*=\s*""/g) || []).length
assert.equal(
  clearCount,
  1,
  `expected liveSessionIdRef to be cleared exactly once (reset only), found ${clearCount}`,
)

// 4. Keepalive: {type:"ping"} on a 25 s interval, guarded by document.hidden.
assert.ok(dense.includes('{type:"ping"}'), 'keepalive {type:"ping"} frame missing')
assert.ok(dense.includes('25000'), 'keepalive 25000 ms interval missing')
assert.ok(dense.includes('!document.hidden'), 'keepalive document.hidden guard missing')

console.log('PASS: terminal-reconnect-check')
