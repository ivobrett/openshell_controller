// Behavioural tests for app/lib/sandboxCreate/registryRouteMetadata.ts, plus
// source guards on the create route's call site.
//
// Why: NemoClaw v0.0.78 refuses every create/recover on a gateway while any
// ~/.nemoclaw/sandboxes.json row lacks durable provider+model metadata — and
// the OpenClaw blueprint create SIGTERMs `nemoclaw onboard` at readiness,
// before onboarding writes those fields. On 2026-07-09 (BYOVPS) this made
// every OpenClaw Quick Create brick the NEXT create with:
//   "At least one registered sandbox lacks durable provider or model
//    metadata, so same-gateway compatibility cannot be proven"
// The fix completes the row from the gateway's single shared route (sibling
// row, else onboard-session.json). These tests lock in that behaviour.
// Runbook: docs/runbooks/live-vps-upgrades.md (Trap 3).

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import {
  ROUTE_METADATA_FIELDS,
  hasDurableRoute,
  planRouteMetadataPatch,
} from '../app/lib/sandboxCreate/registryRouteMetadata.ts'

const route = {
  provider: 'nvidia-prod',
  model: 'nvidia/nemotron-3-super-120b-a12b',
  endpointUrl: 'https://integrate.api.nvidia.com/v1',
  credentialEnv: 'NVIDIA_INFERENCE_API_KEY',
  preferredInferenceApi: 'openai-completions',
}

const nullRoute = {
  provider: null,
  model: null,
  endpointUrl: null,
  credentialEnv: null,
  preferredInferenceApi: null,
}

function registryWith(sandboxes) {
  return { defaultSandbox: Object.keys(sandboxes)[0] ?? null, sandboxes }
}

// 1. The production failure: OpenClaw row killed pre-metadata + complete
//    sibling → all five fields copied from the sibling.
{
  const reg = registryWith({
    'my-first-hermes': { name: 'my-first-hermes', agent: 'hermes', ...route },
    'my-first-claw': { name: 'my-first-claw', agent: 'openclaw', ...nullRoute },
  })
  const plan = planRouteMetadataPatch(reg, 'my-first-claw', null)
  assert.equal(plan.action, 'patch', 'null-metadata row with a durable sibling must be patched')
  assert.equal(plan.sourceKind, 'sibling')
  assert.deepEqual([...plan.filledFields].sort(), [...ROUTE_METADATA_FIELDS].sort(), 'all five route fields must be filled')
  for (const field of ROUTE_METADATA_FIELDS) {
    assert.equal(plan.entry[field], route[field], `${field} must be copied from the sibling`)
  }
  assert.equal(plan.entry.agent, 'openclaw', 'non-route fields must be preserved')
  assert.ok(hasDurableRoute(plan.entry), 'patched entry must satisfy the durable-route check')
}

// 2. Hermes path (onboard ran to completion) → row already durable, no write.
{
  const reg = registryWith({
    'my-first-hermes': { name: 'my-first-hermes', agent: 'hermes', ...route },
  })
  const plan = planRouteMetadataPatch(reg, 'my-first-hermes', null)
  assert.deepEqual(plan, { action: 'none', reason: 'already-durable' }, 'complete rows must never be rewritten')
}

// 3. First sandbox on the gateway (no sibling) → fall back to the completed
//    onboarding session.
{
  const reg = registryWith({
    'solo-claw': { name: 'solo-claw', agent: 'openclaw', ...nullRoute },
  })
  const session = { status: 'complete', sandboxName: 'other', ...route }
  const plan = planRouteMetadataPatch(reg, 'solo-claw', session)
  assert.equal(plan.action, 'patch')
  assert.equal(plan.sourceKind, 'onboard-session', 'without a sibling the onboarding session is the route source')
  assert.equal(plan.entry.provider, 'nvidia-prod')
  assert.equal(plan.entry.model, 'nvidia/nemotron-3-super-120b-a12b')
}

// 4. No sibling, no usable session → no-source (the route logs a warning and
//    records an activity entry; it must NOT invent values).
{
  const reg = registryWith({
    'solo-claw': { name: 'solo-claw', agent: 'openclaw', ...nullRoute },
  })
  assert.deepEqual(planRouteMetadataPatch(reg, 'solo-claw', null), { action: 'none', reason: 'no-source' })
  assert.deepEqual(
    planRouteMetadataPatch(reg, 'solo-claw', { status: 'failed', provider: null, model: null }),
    { action: 'none', reason: 'no-source' },
    'a session without provider+model is not a route source',
  )
}

// 5. Partially-written row (provider recorded, model still null — e.g. killed
//    during model discovery) → only the missing fields are filled.
{
  const reg = registryWith({
    'my-first-hermes': { name: 'my-first-hermes', agent: 'hermes', ...route },
    'partial-claw': { name: 'partial-claw', agent: 'openclaw', ...nullRoute, provider: 'nvidia-prod' },
  })
  const plan = planRouteMetadataPatch(reg, 'partial-claw', null)
  assert.equal(plan.action, 'patch')
  assert.ok(!plan.filledFields.includes('provider'), 'existing provider must not be re-filled')
  assert.ok(plan.filledFields.includes('model'))
  assert.equal(plan.entry.provider, 'nvidia-prod')
  assert.equal(plan.entry.model, route.model)
}

// 6. Provider mismatch with the source → refuse rather than fabricate a
//    hybrid route (one-route-per-gateway means this shouldn't happen; if it
//    does, the operator resolves it per the runbook).
{
  const reg = registryWith({
    'my-first-hermes': { name: 'my-first-hermes', agent: 'hermes', ...route },
    'weird-claw': { name: 'weird-claw', agent: 'openclaw', ...nullRoute, provider: 'ollama' },
  })
  assert.deepEqual(planRouteMetadataPatch(reg, 'weird-claw', null), { action: 'none', reason: 'provider-mismatch' })
}

// 7. Unknown sandbox / malformed registry → no-entry, never a throw.
{
  assert.deepEqual(planRouteMetadataPatch(registryWith({}), 'ghost', null), { action: 'none', reason: 'no-entry' })
  assert.deepEqual(planRouteMetadataPatch(null, 'ghost', null), { action: 'none', reason: 'no-entry' })
  assert.deepEqual(planRouteMetadataPatch({ sandboxes: 'garbage' }, 'ghost', null), { action: 'none', reason: 'no-entry' })
}

// 8. Empty-string fields count as missing (NemoClaw's own nonEmptyString
//    semantics), and whitespace-only values are not copied.
{
  const reg = registryWith({
    src: { name: 'src', ...route, endpointUrl: '   ' },
    dst: { name: 'dst', provider: '', model: '', endpointUrl: '', credentialEnv: '', preferredInferenceApi: '' },
  })
  const plan = planRouteMetadataPatch(reg, 'dst', null)
  assert.equal(plan.action, 'patch')
  assert.ok(!plan.filledFields.includes('endpointUrl'), 'whitespace-only source values must not be copied')
  assert.equal(plan.entry.provider, route.provider)
}

// --- Source guards on the create route -------------------------------------
// The helper only helps if the route actually calls it after a verified
// create, right after the agent stamp (the agent patch upserts the row the
// metadata patch then completes).
const routeSource = await readFile(new URL('../app/api/sandbox/create/route.ts', import.meta.url), 'utf8')
assert.match(
  routeSource,
  /if \(created\) \{\s*\n\s*patchNemoClawRegistryAgent\(sandboxName, agent\)\s*\n\s*const routePatch = patchNemoClawRegistryRouteMetadata\(sandboxName\)/,
  'create route must complete registry route metadata immediately after stamping the agent on a verified create',
)
assert.match(
  routeSource,
  /planRouteMetadataPatch\(current, sandboxName, onboardSession\)/,
  'the IO wrapper must delegate decisions to planRouteMetadataPatch',
)
assert.match(
  routeSource,
  /onboard-session\.json/,
  'the IO wrapper must read the onboarding session as the no-sibling fallback',
)

console.log('openclaw-create-route-metadata-check: all assertions passed')
