// The VPS terminal (terminal-server "host" mode = a shell on the box as the
// controller's user) is operator-only. 2026-10-19: the main page gained a
// "VPS terminal" button, and both OAuth gates now refuse sandboxId 'host', which
// they would otherwise have allowed to any OAuth user granted a sandbox
// literally named 'host'.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8')

const terminalServer = read('terminal-server.mjs')
assert.match(terminalServer, /sandboxId !== 'host'/, "terminal-server still treats 'host' as host-shell mode (premise of this test)")

const server = read('server.mjs')
const oauthGate = server.match(/function isOAuthSandboxUpgradeAuthorized[\s\S]*?\n}\n/)
assert.ok(oauthGate, 'isOAuthSandboxUpgradeAuthorized not found in server.mjs')
assert.match(oauthGate[0], /if \(!sandboxId \|\| sandboxId === 'host'\) return false/, 'WS upgrade must refuse host mode to OAuth users')

const live = read('app/api/openshell/terminal/live/route.ts')
assert.match(live, /if \(!sandboxId \|\| sandboxId === 'host' \|\| !isUserAuthorizedForSandbox\(idpUser, sandboxId\)\)/, 'terminal/live must refuse host mode to OAuth users')

// 2026-10-20: the VPS terminal moved from a Dashboard header button to the last
// sidebar link, gated by the operator-only openHostTerminal capability.
const nav = read('app/components/shell/nav.ts')
const items = nav.match(/export const NAV_ITEMS: NavItem\[\] = \[([\s\S]*?)\n\]/)[1]
const last = items.trim().split('\n').filter((l) => l.trim().startsWith('{')).pop()
assert.match(last, /href: "\/operator-terminal", label: "VPS terminal".*cap: "openHostTerminal"/, 'VPS terminal must be the last sidebar link, capability-gated')
assert.doesNotMatch(last, /mobileTab: true/, 'not a mobile bottom tab')

const me = read('app/api/auth/me/route.ts')
const caps = (name) => me.match(new RegExp(`const ${name}: Capabilities = (\\{[^}]*\\})`))[1]
assert.match(caps('OPERATOR_CAPS'), /openHostTerminal: true/, 'operators get the VPS terminal')
assert.match(caps('OAUTH_CAPS'), /openHostTerminal: false/, 'OAuth users never get the VPS terminal')

const page = read('app/(shell)/page.tsx')
assert.doesNotMatch(page, /VPS terminal/, 'the old Dashboard header button is gone')

console.log('vps-terminal-operator-only-check: ok')
