// Regression test for the in-flight-create presentation layer.
//
// Historical failure mode (observed 2026-07-17 on a fresh Hermes create): the
// live inventory reports a sandbox's INSTANTANEOUS gateway phase, which is
// `Error` for the first ~minute of the container's life while onboard is still
// running. With no notion of "a create is in flight", the dashboard painted a
// healthy provisioning sandbox red ("ERROR") and — because the NemoClaw
// registry `agent` field isn't written until onboard finishes — labelled it
// "Custom". These asserts lock in that, WHILE a create is in flight:
//   * a transient Error/Unknown phase is softened to Pending, and
//   * the intended agent overrides an image-inferred "custom";
// and that a sandbox with NO in-flight create is left untouched (so genuinely
// broken sandboxes still surface as Error).

import assert from 'node:assert/strict'

import {
  markSandboxCreateInFlight,
  clearSandboxCreateInFlight,
  getSandboxCreateInFlight,
  applyInFlightPresentation,
} from '../app/lib/sandboxCreateState.mjs'

// ── No in-flight create: pass-through, real errors preserved ────────────
assert.deepEqual(
  applyInFlightPresentation('idle-box', 'Error', 'custom'),
  { phase: 'Error', agent: 'custom' },
  'a sandbox with no in-flight create must be reported verbatim (Error stays Error)',
)
assert.deepEqual(
  applyInFlightPresentation('idle-box', 'Running', 'hermes'),
  { phase: 'Running', agent: 'hermes' },
)
assert.equal(getSandboxCreateInFlight('idle-box'), undefined)

// ── In-flight Hermes create: Error -> Pending, custom -> hermes ─────────
markSandboxCreateInFlight('my-hermes', 'hermes')
assert.equal(getSandboxCreateInFlight('my-hermes')?.agent, 'hermes')

assert.deepEqual(
  applyInFlightPresentation('my-hermes', 'Error', 'custom'),
  { phase: 'Pending', agent: 'hermes' },
  'in-flight Error must soften to Pending and the misclassified custom must become hermes',
)
assert.deepEqual(
  applyInFlightPresentation('my-hermes', 'Unknown', 'custom'),
  { phase: 'Pending', agent: 'hermes' },
  'an un-inspectable sandbox mid-onboard (Unknown) must also present as Pending',
)
// A phase that is already good must NOT be downgraded once it settles.
assert.deepEqual(
  applyInFlightPresentation('my-hermes', 'Running', 'hermes'),
  { phase: 'Running', agent: 'hermes' },
  'a Running phase must pass through untouched even while the request is still open',
)

// ── Intended agent is optional: blueprint that implies no agent ─────────
markSandboxCreateInFlight('my-custom', undefined)
assert.deepEqual(
  applyInFlightPresentation('my-custom', 'Error', 'custom'),
  { phase: 'Pending', agent: 'custom' },
  'without an intended agent the resolver value is kept, but the phase still softens',
)

// ── Clearing restores the genuine-error behaviour ───────────────────────
clearSandboxCreateInFlight('my-hermes')
assert.equal(getSandboxCreateInFlight('my-hermes'), undefined)
assert.deepEqual(
  applyInFlightPresentation('my-hermes', 'Error', 'custom'),
  { phase: 'Error', agent: 'custom' },
  'once the create completes, a real Error must surface as Error again',
)

clearSandboxCreateInFlight('my-custom')

console.log('PASS: sandbox-create-inflight-provisioning-check')
