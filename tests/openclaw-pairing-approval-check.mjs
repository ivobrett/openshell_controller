// Guards for the controller-driven OpenClaw device-pairing approval surface.
//
// Two properties matter here and both are security-relevant:
//   1. Approve is a privileged, mutating action. It must stay operator-only:
//      the pairing route must NOT be added to middleware's OAuth write
//      allowlist (OAUTH_WRITE_ALLOWED_PATHS), and the route must carry the
//      per-sandbox IDP guard so an OAuth user can't even list another
//      sandbox's pairing requests.
//   2. The requestId flows into an in-sandbox `openclaw devices approve`
//      invocation. It is charset-validated before use; that validation must
//      reject shell metacharacters (defence-in-depth even though it is passed
//      through `sh -lc` with shellQuote).

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const here = path.dirname(fileURLToPath(import.meta.url))
const repo = path.join(here, '..')
const read = (rel) => readFileSync(path.join(repo, rel), 'utf8')

const PAIRING_ROUTE = 'app/api/sandbox/[sandboxId]/openclaw-remote/pairing/route.ts'
const PAIRING_LIB = 'app/lib/openclawPairing.ts'

// ── 1a. Operator-only: pairing path must not be in the OAuth write allowlist ──
{
  const middleware = read('middleware.ts')
  const match = middleware.match(/OAUTH_WRITE_ALLOWED_PATHS\s*=\s*\[([\s\S]*?)\]/)
  assert.ok(match, 'OAUTH_WRITE_ALLOWED_PATHS array not found in middleware.ts')
  const allowlist = match[1]
  assert.ok(
    !/pairing/.test(allowlist),
    'pairing route must NOT be in OAUTH_WRITE_ALLOWED_PATHS — approve is operator-only',
  )
  // The historical single entry stays the only write-allowlisted path.
  assert.ok(
    /terminal\/live/.test(allowlist),
    'expected /api/openshell/terminal/live to remain the write-allowlisted path',
  )
}

// ── 1b. Route carries the per-sandbox IDP guard on both handlers ──
{
  const route = read(PAIRING_ROUTE)
  assert.ok(/function forbiddenForIdpUser/.test(route), 'route must define forbiddenForIdpUser')
  // Both GET and POST must call the guard before doing work.
  const guardCalls = route.match(/forbiddenForIdpUser\(request, sandboxName\)/g) || []
  assert.ok(
    guardCalls.length >= 2,
    `expected the IDP guard to run in both GET and POST (found ${guardCalls.length})`,
  )
  assert.ok(/x-forwarded-user/.test(route), 'guard must key off the trusted x-forwarded-user header')
}

// ── 2. requestId validation rejects shell metacharacters ──
{
  const lib = read(PAIRING_LIB)
  const reMatch = lib.match(/REQUEST_ID_RE\s*=\s*\/(.+?)\/([gimsuy]*)/)
  assert.ok(reMatch, 'REQUEST_ID_RE literal not found in openclawPairing.ts')
  const REQUEST_ID_RE = new RegExp(reMatch[1], reMatch[2])

  // Plausible real ids approve fine.
  for (const ok of [
    'a1b2c3d4',
    '3f2504e0-4f89-41d3-9a0c-0305e82c3301',
    'req_2026-07-01T10:00:00',
    'device.node-01',
  ]) {
    assert.ok(REQUEST_ID_RE.test(ok), `expected valid requestId to pass: ${ok}`)
  }

  // Anything carrying shell/command metacharacters (or whitespace/newlines)
  // must be rejected before it can reach the exec layer.
  for (const bad of [
    'id; rm -rf /',
    'id && curl evil',
    'id | cat',
    'id`whoami`',
    'id$(whoami)',
    "id'quote",
    'id"quote',
    'id\nnewline',
    'id with space',
    '../escape',
    'id/slash',
    '',
    'x'.repeat(129),
  ]) {
    assert.ok(!REQUEST_ID_RE.test(bad), `expected metachar/invalid requestId to be rejected: ${JSON.stringify(bad)}`)
  }

  // The approve path validates the target id before building any command, and
  // every arg going into the `su -c` string is shell-quoted (shq).
  assert.ok(/REQUEST_ID_RE\.test\(targetId\)/.test(lib), 'approve must validate the target id with REQUEST_ID_RE')
  assert.ok(/\.map\(shq\)/.test(lib), 'gateway args must be shell-quoted via shq before entering the su -c string')
}

// ── 3. Transport invariants (rewritten 2026-07-12) ──
// Gateway WS calls must reach the gateway inside its network namespace, on the
// stored-device-credential path (gateway env stripped). Getting any of these
// wrong reproduces the live failure: 1006 (wrong IP) or "device pairing
// required" (shared-token auth). File reads still use the privileged
// openshell-exec channel.
{
  const lib = read(PAIRING_LIB)
  // Enter the gateway netns (nsenter -n) rather than dialing an IP.
  assert.ok(/"nsenter",\s*"-t",\s*pid,\s*"-n"/.test(lib), 'gateway calls must nsenter into the gateway netns')
  // Discover the gateway process as `openclaw` (the `openclaw-devices` watcher
  // is intentionally excluded by -x).
  assert.ok(/pgrep",\s*"-x",\s*"openclaw"/.test(lib), 'gateway PID must be found with `pgrep -x openclaw`')
  // Strip the shared-token gateway env so OpenClaw uses its stored device
  // credential (operator authority); a plain-token connection is rejected.
  for (const key of ['OPENCLAW_GATEWAY_URL', 'OPENCLAW_GATEWAY_PORT', 'OPENCLAW_GATEWAY_TOKEN']) {
    assert.ok(lib.includes(`-u ${key}`), `runOpenClawGateway must strip ${key} from the child env`)
  }
  // The operator device must be self-approved before node list/approve.
  assert.ok(/ensureOperatorApproved/.test(lib), 'pairing lib must self-approve the operator device before node ops')
  // File reads still go through the privileged openshell-exec channel.
  assert.ok(
    /"sandbox",\s*"exec",\s*"-n",\s*sandboxName/.test(lib),
    'file reads must run via the privileged `openshell sandbox exec -n <name>` channel',
  )
}

console.log('openclaw-pairing-approval-check: PASS')
