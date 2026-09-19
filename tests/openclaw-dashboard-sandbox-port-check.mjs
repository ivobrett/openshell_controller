import assert from 'node:assert/strict'
import path from 'node:path'
import { readFile } from 'node:fs/promises'

// Guards the 2026-09-19 "dashboard times out after 45 s" fix.
//
// SYMPTOM: clicking Open Dashboard showed the launch page stepping through
// "Contacting controller / Starting gateway tunnel / Verifying dashboard token"
// and then "Timed out after 45 s". It affected every sandbox EXCEPT whichever
// one happened to own port 18789, which is why deleting and recreating a
// sandbox appeared to fix it (the new sandbox reclaimed 18789) and why the
// first sandbox on a fresh box always worked.
//
// CAUSE: NemoClaw allocates the in-sandbox OpenClaw gateway port PER SANDBOX —
// the first gets 18789, the next free one 18790, and so on — and records it as
// OPENCLAW_GATEWAY_PORT in the sandbox env (matching gateway.port in
// openclaw.json). The controller assumed the SANDBOX_DASHBOARD_REMOTE_PORT
// constant for every sandbox, so the readiness probe curled a dead port. That
// threw, which dropped into the expensive restartSandboxGatewayWithNemoClaw
// fallback (~35 s) and then 16 more failing retries, so
// /api/openshell/dashboard/open took ~75 s — past the launch page's 45 s
// client timeout.
//
// Measured on the live box, staged timings before the fix:
//   inspect(hostPort=19048) listening=false  t=55ms
//   resolvePort=18789                        t=20068ms   <- wrong, after a timeout
//   ensureRemote=false                       t=66926ms
// and after: resolvePort=18790 t=177ms, ensureRemote=true t=326ms, open ~8s.
//
// The port read MUST go through execSandboxSsh. An earlier attempt used
// `openshell sandbox exec`, which never returned from inside the controller
// and was killed by its own 20s timeout — silently falling back to the wrong
// constant, i.e. reintroducing the very bug. The same command runs in ~0.08s
// from a shell with the controller's own PATH and gateway env, so this is
// about how the controller invokes it, not about the sandbox.

const root = process.cwd()
const hostPath = path.join(root, 'app/lib/openshellHost.ts')
const source = await readFile(hostPath, 'utf8')

assert.match(
  source,
  /async function resolveSandboxGatewayPort\(sandboxName: string\)/,
  'openshellHost must resolve the in-sandbox gateway port per sandbox rather than assuming SANDBOX_DASHBOARD_REMOTE_PORT',
)

assert.match(
  source,
  /resolveSandboxGatewayPort[\s\S]*?execSandboxSsh\(/,
  'resolveSandboxGatewayPort must read the port over execSandboxSsh — `openshell sandbox exec` hangs from inside the controller and silently falls back to the wrong port',
)

assert.match(
  source,
  /OPENCLAW_GATEWAY_PORT/,
  'the port read must use OPENCLAW_GATEWAY_PORT, the value NemoClaw exports into the sandbox',
)

// The readiness probe and the ssh -L tunnel must both target the RESOLVED
// port. If either reverts to the constant the timeout comes straight back.
assert.match(
  source,
  /async function ensureRemoteSandboxOpenClawDashboard\(sandboxName: string, remotePort: number\)/,
  'the readiness probe must take the resolved remote port as a parameter',
)

assert.match(
  source,
  /"-L", `127\.0\.0\.1:\$\{port\}:127\.0\.0\.1:\$\{remotePort\}`/,
  'the ssh -L tunnel must forward to the RESOLVED in-sandbox port, not the constant',
)

assert.doesNotMatch(
  source,
  /curl -fsS --max-time \d+ http:\/\/127\.0\.0\.1:\$\{SANDBOX_DASHBOARD_REMOTE_PORT\}/,
  'the readiness curl must not target the hardcoded constant port',
)

console.log('openclaw-dashboard-sandbox-port-check: OK')
