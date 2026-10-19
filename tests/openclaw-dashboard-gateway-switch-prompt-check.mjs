// OpenClaw >= 2026.10 shows "Switch to a different Gateway?" when the launch
// hash's gatewayUrl differs from the stored settings.gatewayUrl. Ours always
// differed: the stored one carries ?token= (required by
// openclaw-dashboard-same-origin-ws-check.mjs). Seen on Oracle with 2026.10.5
// on 2026-10-19. The bootstrap now removes gatewayUrl from the hash AFTER saving
// it, so the token carriers and cookie-wins behaviour (CLAUDE.md §10) are unchanged.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const src = readFileSync(new URL('../app/api/openshell/dashboard/proxy/shared.ts', import.meta.url), 'utf8')

const saved = src.indexOf('for (const key of settingsKeys) window.localStorage.setItem(key, serializedSettings);')
const stripped = src.indexOf("hashParams.delete('gatewayUrl');")
assert.ok(saved > 0 && stripped > 0, 'bootstrap must save settings and strip the hash gatewayUrl')
assert.ok(stripped > saved, 'the hash gatewayUrl must be removed only AFTER settings (with token) are saved')
assert.match(src, /window\.history\.replaceState\(window\.history\.state, '', window\.location\.pathname \+ window\.location\.search \+ \(remainingHash \? '#' \+ remainingHash : ''\)\)/,
  'strip with replaceState, keeping path, query and any other hash params (e.g. token)')
assert.doesNotMatch(src, /hashParams\.delete\('token'\)/, 'the hash token is still consumed by older OpenClaw — do not strip it')
assert.match(src, /settings\.gatewayUrl = effectiveGatewayUrl/, 'stored gatewayUrl keeps its embedded token')

console.log('openclaw-dashboard-gateway-switch-prompt-check: ok')
