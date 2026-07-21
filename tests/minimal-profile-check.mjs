import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'

// Guards the OPENSHELL_CONTROL_PROFILE=minimal install mode: a stripped-back
// controller for a host that only has the OpenShell CLI + a local gateway
// (e.g. the `openshell` snap), managing plain custom sandboxes only.
//
// These are source-text guards (the repo's convention) — they lock in the four
// load-bearing pieces so a refactor or an upstream merge can't silently drop
// minimal mode and start leaking NemoClaw/OpenClaw surfaces onto a plain host.

const root = process.cwd()
const read = (rel) => readFile(path.join(root, rel), 'utf8')

// ── 1. Profile helper: reads the env var, defaults to full ──
const profileSrc = await read('app/lib/controlProfile.ts')
assert.match(profileSrc, /OPENSHELL_CONTROL_PROFILE/, 'controlProfile must read OPENSHELL_CONTROL_PROFILE')
assert.match(profileSrc, /NEXT_PUBLIC_OPENSHELL_CONTROL_PROFILE/, 'controlProfile must expose a NEXT_PUBLIC_ mirror for client components')
assert.match(profileSrc, /===\s*["']minimal["']/, 'profile is minimal only when the value equals "minimal" (default full)')
assert.match(profileSrc, /export function isMinimalProfile/, 'must export isMinimalProfile')

// ── 2. Blueprint list: minimal returns ONLY custom-sandbox ──
const createSrc = await read('app/api/sandbox/create/route.ts')
assert.match(createSrc, /import \{ isMinimalProfile \} from "@\/app\/lib\/controlProfile"/, 'create route must import isMinimalProfile')
// The minimal branch must appear inside GET, gate on isMinimalProfile(), and
// expose custom-sandbox but NOT the NemoClaw/OpenClaw/Hermes blueprints.
const getBody = createSrc.slice(createSrc.indexOf('export async function GET'))
const minimalBranch = getBody.slice(getBody.indexOf('isMinimalProfile()'), getBody.indexOf('const baselineStatus'))
assert.ok(minimalBranch.length > 0, 'GET must have an isMinimalProfile() branch before the full blueprint list')
assert.match(minimalBranch, /id:\s*["']custom-sandbox["']/, 'minimal blueprint list must include custom-sandbox')
for (const forbidden of ['nemoclaw-blueprint', 'nemoclaw-hermes', 'nemoclaw-deepagents-code', 'redeploy-image']) {
  assert.ok(!minimalBranch.includes(forbidden), `minimal blueprint list must NOT include ${forbidden}`)
}

// ── 3. Capability gating: minimal strips NemoClaw/OpenClaw-dependent caps ──
const meSrc = await read('app/api/auth/me/route.ts')
assert.match(meSrc, /function applyProfileCaps/, 'me route must define applyProfileCaps')
assert.match(meSrc, /if \(!isMinimalProfile\(\)\) return caps/, 'applyProfileCaps must be an identity outside minimal mode')
for (const cap of ['openDashboard', 'manageInference', 'manageMcp', 'viewWizards']) {
  assert.match(
    applyProfileCapsBody(meSrc),
    new RegExp(`${cap}:\\s*false`),
    `minimal profile must disable ${cap}`,
  )
}

function applyProfileCapsBody(src) {
  const start = src.indexOf('function applyProfileCaps')
  return src.slice(start, src.indexOf('function allowedSandboxesForEmail'))
}

// ── 4. Gateway name is parameterised, not hardcoded to nemoclaw ──
const hostSrc = await read('app/lib/openshellHost.ts')
assert.doesNotMatch(
  hostSrc,
  /ssh-proxy --gateway-name nemoclaw/,
  'ssh-proxy gateway-name must not be hardcoded to nemoclaw — it must honor OPENSHELL_GATEWAY',
)
assert.match(
  hostSrc,
  /ssh-proxy --gateway-name \$\{OPENSHELL_GATEWAY \|\| "nemoclaw"\}/,
  'ssh-proxy gateway-name must be OPENSHELL_GATEWAY with a nemoclaw fallback for full-mode compatibility',
)

// ── 5. Installer exposes --minimal and writes the profile ──
const installer = await read('install.sh')
assert.match(installer, /--minimal\)/, 'install.sh must accept a --minimal flag')
assert.match(installer, /OPENSHELL_CONTROL_PROFILE.*PROFILE_VALUE|PROFILE_VALUE="minimal"/, 'install.sh must write OPENSHELL_CONTROL_PROFILE from the profile')
assert.match(installer, /openshell-gateway/, 'install.sh minimal path must default the gateway to openshell-gateway')

console.log('minimal-profile-check: PASS OPENSHELL_CONTROL_PROFILE=minimal contract intact')
