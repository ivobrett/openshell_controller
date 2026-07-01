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

  // The approve path shell-quotes the (already-validated) id and validates
  // before building the command — belt and suspenders.
  assert.ok(/REQUEST_ID_RE\.test\(requestId\)/.test(lib), 'approve must validate requestId with REQUEST_ID_RE')
  assert.ok(/shellQuote\(requestId\)/.test(lib), 'approve must shellQuote requestId')
  assert.ok(
    /"sandbox",\s*"exec",\s*"-n",\s*sandboxName/.test(lib),
    'pairing lib must run via the privileged `openshell sandbox exec -n <name>` channel',
  )
}

console.log('openclaw-pairing-approval-check: PASS')
