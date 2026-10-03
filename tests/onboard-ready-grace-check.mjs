// Guards the post-Ready grace period in runCreateCommandUntilReady
// (app/api/sandbox/create/route.ts).
//
// The OpenClaw create path used to SIGTERM `nemoclaw onboard` the instant the
// sandbox reached Ready (added 2026-05 to survive onboards that hung after the
// sandbox was up). NemoClaw v0.0.130 reports Ready in the MIDDLE of onboard —
// post-create verification and the openclaw / agent_setup / policies steps run
// afterwards — so the kill left ~/.nemoclaw/onboard-session.json in
// "recovery_required" (observed live 2026-10-03). Onboard must now get a grace
// period to exit on its own; the kill only happens once that expires.

import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const src = readFileSync(path.join(ROOT, "app/api/sandbox/create/route.ts"), "utf8")
const fn = src.slice(src.indexOf("async function runCreateCommandUntilReady("))
const readyBranch = fn.slice(fn.indexOf("verification.verified) {"), fn.indexOf("}, intervalMs)"))

assert.match(src, /OPENSHELL_CONTROL_ONBOARD_READY_GRACE_MS/, "grace period must be configurable")
assert.match(src, /DEFAULT_ONBOARD_READY_GRACE_MS = \d/, "a default grace period must exist")
assert.match(readyBranch, /readyGraceTimer = setTimeout\(/, "Ready must start a grace timer")
const beforeGrace = readyBranch.slice(0, readyBranch.indexOf("readyGraceTimer = setTimeout("))
assert.doesNotMatch(beforeGrace, /child\.kill\(/,
  "onboard must NOT be killed at the moment of Ready — that interrupts NemoClaw v0.0.130's post-Ready steps")
assert.match(readyBranch, /killedAfterGrace = true[\s\S]*child\.kill\("SIGTERM"\)/, "the kill must happen only after the grace expires")
assert.match(fn, /if \(readyGraceTimer\) clearTimeout\(readyGraceTimer\)/, "a natural exit must cancel the pending grace kill")
assert.match(fn, /if \(readyKill\) \{\s*finish\(\{[\s\S]*?forcedReady: true/,
  "after Ready the result must still be reported via the close event (registry-write ordering, 2026-07-09)")

console.log("PASS: onboard post-Ready grace period guards")
