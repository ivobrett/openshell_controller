// Guards for the FRESH-BOX GATEWAY GAP.
//
// Background: manidae-cloud commit b6964b22 (2026-08-15) deliberately stopped
// pre-registering a `nemoclaw` gateway placeholder during cloud provisioning.
// It had to: on NemoClaw v0.0.108+ a placeholder bound to the wrong port
// (17670 != DEFAULT_GATEWAY_PORT 8080) is a BLOCKING
// gateway.port.owner_mismatch finding that aborts `nemoclaw onboard` outright,
// which broke every fresh deploy.
//
// The side effect: between provisioning and the first sandbox create, no
// managed gateway exists at all, so `openshell sandbox list` fails with
// "Unknown gateway 'nemoclaw'". The dashboard used to render that as a red
// destructive Alert plus a "Attempt gateway repair" button that runs
// `openshell gateway start --name nemoclaw` — which CANNOT work on a gateway
// that was never registered, only on one that is registered but stopped.
//
// Observed live on a fresh Hetzner box 2026-08-23 (49.13.144.137). Creating a
// sandbox resolved it: `nemoclaw onboard` registered the gateway on :8080 and
// the error cleared on its own.
//
// Note there is NO provisioning-side fix. Registering the gateway at :8080
// during provisioning does not help, because nothing LISTENS on 8080 until
// onboard starts the gateway process — `sandbox list` would simply fail with
// "transport error / Connection refused" instead. And `nemoclaw onboard` is
// the only command that creates the gateway, and it is inherently
// sandbox-creating (~10 min). So the fix has to be presentational.
//
// These assertions lock in BOTH halves. The second one matters most: a missing
// gateway is only benign on a box that has never had a sandbox. If the NemoClaw
// registry lists sandboxes but the gateway is gone, that is real breakage and
// must still surface as an error.

import assert from "node:assert"
import { readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const TELEMETRY = path.join(ROOT, "app/api/telemetry/real/route.ts")
const PAGE = path.join(ROOT, "app/(shell)/page.tsx")
const HOOK = path.join(ROOT, "app/hooks/queries.ts")

const telemetry = readFileSync(TELEMETRY, "utf8")
const page = readFileSync(PAGE, "utf8")
const hook = readFileSync(HOOK, "utf8")

// --- 1. the "Unknown gateway" condition is special-cased at all -------------
assert.match(
  telemetry,
  /Unknown gateway/i,
  "telemetry/real must special-case the \"Unknown gateway\" failure; without it a fresh box " +
    "renders a red error plus a repair button that structurally cannot work",
)

assert.match(
  telemetry,
  /awaitingFirstSandbox:\s*true/,
  "telemetry/real must return awaitingFirstSandbox:true for the fresh-box case so the UI can " +
    "render an empty state instead of an error",
)

// --- 2. THE GUARD: only benign when the registry has no sandboxes -----------
// This is the assertion that stops someone "simplifying" the fix into a
// blanket suppression of every Unknown-gateway error.
const unknownGatewayBlock = telemetry.slice(telemetry.search(/Unknown gateway/i))
assert.match(
  unknownGatewayBlock,
  /readNemoClawRegistry\(\)/,
  "the Unknown-gateway branch MUST consult the NemoClaw registry. Suppressing the error " +
    "unconditionally would hide a genuinely deregistered gateway on a box that already has " +
    "sandboxes. The registry is read from disk and is gateway-independent, so it stays readable " +
    "in exactly the situation where the gateway is missing (CLAUDE.md §3).",
)
assert.match(
  unknownGatewayBlock,
  /length\s*===\s*0/,
  "the fresh-box empty state must be gated on the registry listing ZERO sandboxes",
)

// The 500 path must still exist for the real-breakage case.
assert.match(
  telemetry,
  /\{\s*status:\s*500\s*\}/,
  "telemetry/real must still return 500 when the gateway is missing but the registry lists " +
    "sandboxes — that case is real breakage and must stay loud",
)

// --- 3. the flag is plumbed through to the UI ------------------------------
assert.match(
  hook,
  /awaitingFirstSandbox/,
  "useInventory must expose awaitingFirstSandbox or the page cannot render the note",
)
assert.match(
  page,
  /awaitingFirstSandbox/,
  "the dashboard page must consume awaitingFirstSandbox",
)

// --- 4. the empty state stays gated on !error ------------------------------
// The fresh-box payload is a 200 with an empty sandbox list, so it flows into
// the existing empty state. If someone re-orders these branches so an error
// renders the empty state, real failures would silently look like "no
// sandboxes yet".
assert.match(
  page,
  /!error\s*&&\s*sandboxes\.length\s*===\s*0/,
  "the empty state must remain gated on !error so a genuine inventory failure is never " +
    "mistaken for an empty host",
)

console.log("PASS: fresh-box gateway empty-state guards")
