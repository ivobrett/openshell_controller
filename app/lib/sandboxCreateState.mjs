// Tracks sandbox creates that are currently in flight in THIS controller
// process, so the live inventory (/api/telemetry/real) can distinguish a
// sandbox that is transiently `Error`/`Unknown` mid-onboard from one that is
// genuinely broken.
//
// A NemoClaw onboard holds the create request open for the full image build
// (~5-7 min), and the sandbox container reports phase `Error` for the first
// ~minute of its life before its inner services (Hermes / OpenClaw gateway)
// come up. Without this signal the dashboard paints a healthy provisioning
// sandbox red, and — because the NemoClaw registry `agent` field isn't written
// until onboard finishes — labels it "Custom" (the container image reports a
// bare id that misses isNemoClawImage). See app/api/telemetry/real/route.ts.
//
// Both the create route and the telemetry route run in the same Next server
// process, so a module singleton shares state. We hang it off globalThis to be
// robust against any per-route module duplication in the production bundle.
//
// Plain ESM (not .ts) so tests can import it under node without TS tooling,
// matching the policy.mjs / filterInventory.mjs pattern. Types live in
// sandboxCreateState.d.ts.

const GLOBAL_KEY = Symbol.for("openshell.sandboxCreateInFlight")

function store() {
  if (!globalThis[GLOBAL_KEY]) globalThis[GLOBAL_KEY] = new Map()
  return globalThis[GLOBAL_KEY]
}

export function markSandboxCreateInFlight(name, agent) {
  if (!name) return
  const trimmedAgent = typeof agent === "string" ? agent.trim() : ""
  store().set(name, { agent: trimmedAgent || undefined, startedAt: Date.now() })
}

export function clearSandboxCreateInFlight(name) {
  if (!name) return
  store().delete(name)
}

export function getSandboxCreateInFlight(name) {
  return store().get(name)
}

// Fold an in-flight create over a sandbox's live phase/agent. While a create
// is in flight for `name`, a transient `Error`/`Unknown` phase is reported as
// `Pending` (so the UI shows an amber "PENDING" state rather than a red
// "ERROR"), and the intended agent overrides an image-inferred "custom". A
// sandbox with no in-flight create is returned unchanged, so genuinely broken
// sandboxes still surface as Error.
export function applyInFlightPresentation(name, phase, agent) {
  const inFlight = getSandboxCreateInFlight(name)
  if (!inFlight) return { phase, agent }
  const softenedPhase = phase === "Error" || phase === "Unknown" ? "Pending" : phase
  return {
    phase: softenedPhase,
    agent: inFlight.agent || agent,
  }
}
