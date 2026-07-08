import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'

// Phase 4b (§12.3 / §12.7). The client keepalive sends {type:"ping"} frames the
// server does not understand. This is only safe because terminal-server.mjs's
// WS message handler silently ignores unknown message types — it neither
// throws nor closes the socket on an unhandled type; malformed frames are
// swallowed by a catch. This test locks that in: if an upstream change makes
// the handler reject unknown types, the ping keepalive would start killing
// idle shells, and this flags it before it ships.

const root = process.cwd()
const source = await readFile(path.join(root, 'terminal-server.mjs'), 'utf8')

// Extract the message-handler body: from `socket.on('message'` up to the next
// `socket.on('close'` registration.
const start = source.indexOf("socket.on('message'")
assert.ok(start !== -1, "could not locate socket.on('message') handler")
const closeIdx = source.indexOf("socket.on('close'", start)
assert.ok(closeIdx !== -1, "could not locate the close handler after message handler")
const handler = source.slice(start, closeIdx)

// The three handled types must still be present (sanity: we found the right block).
assert.ok(handler.includes("msg.type === 'input'"), "input handling missing")
assert.ok(handler.includes("msg.type === 'resize'"), "resize handling missing")
assert.ok(handler.includes("msg.type === 'kill'"), "kill handling missing")

// The ping tolerance guarantee: no throw and no socket.close in the handler,
// so unknown types (like our keepalive ping) fall through harmlessly.
assert.ok(!/\bthrow\b/.test(handler), 'message handler must not throw on unhandled types')
assert.ok(!/\.close\s*\(/.test(handler), 'message handler must not close the socket on unhandled types')

console.log('PASS: terminal-server-ping-tolerance-check')
