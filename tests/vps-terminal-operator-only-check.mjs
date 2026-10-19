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

const page = read('app/(shell)/page.tsx')
assert.match(page, /\{me\.role === "operator" && \(\s*<Button asChild variant="outline">\s*<Link href=\{buildOperatorTerminalRoute\(\{ dashboardSessionId \}\)\}>VPS terminal<\/Link>/,
  'VPS terminal button must be rendered for operators only and open host mode (no sandboxId)')

console.log('vps-terminal-operator-only-check: ok')
