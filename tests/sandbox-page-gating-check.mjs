import assert from 'node:assert/strict'
import { extractSandboxIdFromUrl } from '../app/lib/auth/policy.mjs'

// Behavioural guard for the new /sandboxes/<name> page-route extraction added
// in Phase 1 (§3.4), plus a regression guard that the three pre-existing
// extraction branches still return their previous values. middleware.ts uses
// this to gate OAuth users away from sandbox detail pages they lack access to.

// ── New UI detail-page branch ──
assert.equal(extractSandboxIdFromUrl('/sandboxes/alpha'), 'alpha', '/sandboxes/alpha → alpha')
assert.equal(
  extractSandboxIdFromUrl('/sandboxes/alpha/anything'),
  'alpha',
  '/sandboxes/alpha/anything → alpha',
)
assert.equal(extractSandboxIdFromUrl('/sandboxes/new'), null, '/sandboxes/new is the create page → null')
assert.equal(extractSandboxIdFromUrl('/sandboxes/'), null, '/sandboxes/ (no name) → null')

// URL-encoded names decode.
assert.equal(
  extractSandboxIdFromUrl('/sandboxes/my%2Dbox'),
  'my-box',
  'encoded /sandboxes/my%2Dbox → my-box',
)

// ── Regression: pre-existing branches unchanged ──
assert.equal(
  extractSandboxIdFromUrl('/api/sandbox/foo/hermes/dashboard/proxy'),
  'foo',
  '/api/sandbox/foo/... → foo',
)
assert.equal(
  extractSandboxIdFromUrl('/api/openshell/instances/sandbox-3-bar/dashboard/proxy'),
  'bar',
  '/api/openshell/instances/sandbox-3-bar/... → bar',
)
assert.equal(
  extractSandboxIdFromUrl('/api/openshell/terminal/live', new URLSearchParams('sandboxId=baz')),
  'baz',
  '?sandboxId=baz → baz',
)

// Unrelated path with no matching branch and no query → null.
assert.equal(
  extractSandboxIdFromUrl('/api/telemetry/real', new URLSearchParams()),
  null,
  'unrelated path → null',
)

console.log('sandbox-page-gating-check: PASS /sandboxes page-route extraction + existing branches intact')
