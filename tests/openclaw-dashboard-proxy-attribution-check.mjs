import assert from 'node:assert/strict'
import path from 'node:path'
import { readFile } from 'node:fs/promises'

// Guards the fix for the 2026-09-19 blank-dashboard regression introduced by
// OpenClaw 2026.7.1 -> 2026.9.1 (NemoClaw main@e38726c8d7).
//
// SYMPTOM: "Open Dashboard" renders a completely blank page. The WebSocket
// upgrade still succeeds (101 + connect.challenge), so CLAUDE.md §10's token
// chain looks healthy and the usual "Auth did not match" diagnostics find
// nothing. What actually fails is every gateway-authenticated HTTP route:
//
//   GET <proxyPrefix>/                              -> 403
//   GET <proxyPrefix>/__openclaw/control-ui-config.json -> 403
//   {"error":{"type":"proxy_attribution_required","message":
//     "Proxy client attribution is required. Configure gateway.trustedProxies
//      narrowly and make the proxy overwrite or safely rebuild forwarded
//      client headers."}}
//
// and the in-sandbox gateway log records:
//   [gateway] observed unattributable proxy-shaped traffic from 127.0.0.1
//
// Measured on the live box: identical request 403s without X-Forwarded-For and
// 200s with it, for the SPA shell, every /assets/* chunk, and the control-ui
// config. OpenClaw 2026.7.1 did not enforce this.
//
// THE FIX, and why it is shaped this way: we are the trusted proxy (the sandbox
// pins gateway.trustedProxies = ["127.0.0.1","::1"]), so the controller must
// SUPPLY attribution rather than relay the browser's. Relaying is unreliable
// (any request reaching the controller without XFF blanks the dashboard) and
// unsafe (a client could forge its own source address — verified: injecting
// X-Forwarded-For from curl turned a 403 into a 200). Mirrors server.mjs
// stripping client-supplied x-forwarded-user, CLAUDE.md §6.

const root = process.cwd()
const sharedPath = path.join(root, 'app/api/openshell/dashboard/proxy/shared.ts')
const sharedSource = await readFile(sharedPath, 'utf8')

assert.match(
  sharedSource,
  /headers\.set\('x-forwarded-for', resolveForwardedClient\(request\)\)/,
  'dashboard proxy must SET x-forwarded-for on every upstream request — without it OpenClaw 2026.9.1+ answers 403 proxy_attribution_required and the dashboard renders blank',
)

assert.match(
  sharedSource,
  /const CLIENT_ATTRIBUTION_HEADERS = new Set\(\[[\s\S]*?'x-forwarded-for',[\s\S]*?'x-real-ip',[\s\S]*?'forwarded',[\s\S]*?\]\)/,
  'dashboard proxy must enumerate the inbound client-attribution headers it drops',
)

assert.match(
  sharedSource,
  /!CLIENT_ATTRIBUTION_HEADERS\.has\(lowerKey\)/,
  'the request-header copy loop must EXCLUDE client-supplied attribution headers — forwarding them lets a browser forge its own source address, which is exactly what the gateway error tells us to stop doing',
)

// The rebuilt value must be a single left-most entry, never an appended chain:
// the gateway wants one unambiguous claim from the trusted proxy.
assert.match(
  sharedSource,
  /function resolveForwardedClient\(request: Request\)[\s\S]*?chain\.split\(','\)\[0\]/,
  'resolveForwardedClient must take the left-most entry of the front-proxy chain rather than appending to it',
)

assert.match(
  sharedSource,
  /function resolveForwardedClient\(request: Request\)[\s\S]*?return '127\.0\.0\.1'/,
  'resolveForwardedClient must fall back to a concrete loopback attribution so direct/loopback requests still satisfy the gateway instead of blanking the dashboard',
)

console.log('openclaw-dashboard-proxy-attribution-check: OK')
