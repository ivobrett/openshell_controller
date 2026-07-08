import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'

// Guards the /api/auth/me v2 capability contract introduced in the UI refresh
// Phase 1 (docs/ui-refresh/03-auth-and-capabilities.md §3.1).
//
// The client capability model + server-side inventory filtering both key off
// this route's shape. If someone drops the legacy `operator:` boolean,
// ShieldsPanel + setup-account break; if the OAUTH_CAPS accidentally grant a
// write capability, the UI would render operator controls for IdP users whose
// requests then 403 (the exact bad UX this phase removes).

const root = process.cwd()
const routePath = path.join(root, 'app/api/auth/me/route.ts')
const source = await readFile(routePath, 'utf8')

// ── 1. Response shape: new fields present, legacy field retained ──

assert.match(source, /role:\s*["']operator["']/, 'route must return role:"operator"')
assert.match(source, /role:\s*["']user["']/, 'route must return role:"user" for OAuth users')
assert.match(source, /role:\s*["']anonymous["']/, 'route must return role:"anonymous"')
assert.match(source, /allowedSandboxes:/, 'route must return an allowedSandboxes field')
assert.match(source, /allowedSandboxes:\s*["']all["']/, 'operator must get allowedSandboxes:"all"')
assert.match(
  source,
  /operator:\s*true/,
  'route must keep the legacy operator:true field (ShieldsPanel + setup-account read it)',
)
assert.match(source, /capabilities:\s*OPERATOR_CAPS/, 'operator branch must return OPERATOR_CAPS')
assert.match(source, /capabilities:\s*OAUTH_CAPS/, 'oauth branch must return OAUTH_CAPS')

// Identity must be derived server-side, never from client-supplied headers.
assert.match(
  source,
  /resolveAuthContext/,
  'route must derive identity via resolveAuthContext, not a trusted header',
)
assert.doesNotMatch(
  source,
  /x-forwarded-user/,
  'route must NOT trust x-forwarded-user for its own identity decision',
)

// ── 2. Extract + eval the capability object literals ──

function extractCaps(name) {
  const match = source.match(new RegExp(`const ${name}: Capabilities = (\\{[^}]*\\})`))
  assert.ok(match, `${name} object literal must be present`)
  // Function eval tolerates the trailing // comments inside the literal.
  return Function(`return ${match[1]}`)()
}

const OPERATOR_CAPS = extractCaps('OPERATOR_CAPS')
const OAUTH_CAPS = extractCaps('OAUTH_CAPS')

// Both objects must declare the SAME capability keys (no drift).
const opKeys = Object.keys(OPERATOR_CAPS).sort()
const oauthKeys = Object.keys(OAUTH_CAPS).sort()
assert.deepEqual(opKeys, oauthKeys, 'OPERATOR_CAPS and OAUTH_CAPS must declare the same keys')

// Operator: every capability true.
for (const [key, value] of Object.entries(OPERATOR_CAPS)) {
  assert.equal(value, true, `OPERATOR_CAPS.${key} must be true`)
}

// OAuth: the write / admin capabilities must be false (server enforces this;
// the UI just mirrors it).
for (const key of [
  'createSandbox', 'deleteSandbox', 'restartSandbox', 'manageFiles',
  'manageInference', 'manageMcp', 'approvePermissions', 'manageShields',
  'backupRestore', 'manageSecurity', 'manageNodes', 'viewWizards',
]) {
  assert.equal(OAUTH_CAPS[key], false, `OAUTH_CAPS.${key} must be false`)
}

// OAuth: the read + per-sandbox capabilities they DO have.
for (const key of ['openTerminal', 'openDashboard', 'viewActivity', 'viewSkills']) {
  assert.equal(OAUTH_CAPS[key], true, `OAUTH_CAPS.${key} must be true`)
}

console.log('auth-me-capabilities-check: PASS /api/auth/me v2 capability contract intact')
