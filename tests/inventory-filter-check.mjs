import assert from 'node:assert/strict'
import { filterInventoryForUser } from '../app/lib/auth/filterInventory.mjs'

// Behavioural guard for the OAuth inventory filter (Phase 1, §3.3). An IdP user
// authorized for only "alpha" must never receive beta/gamma names, IPs, or the
// host-level nemoclaw gateway service/summary lines.

const payload = {
  sandboxes: [
    { id: 'alpha', name: 'alpha', status: 'Running' },
    { id: 'beta', name: 'beta', status: 'Running' },
    { id: 'gamma', name: 'gamma', status: 'Running' },
  ],
  pods: {
    items: [
      { metadata: { name: 'alpha', labels: { 'nemoclaw.ai/sandbox-name': 'alpha' } } },
      { metadata: { name: 'beta', labels: { 'nemoclaw.ai/sandbox-name': 'beta' } } },
      { metadata: { name: 'gamma', labels: { 'nemoclaw.ai/sandbox-id': 'gamma' } } },
    ],
  },
  nemoclaw: {
    available: true,
    defaultSandboxNames: ['alpha', 'beta'],
    serviceLines: ['gateway (running)', 'broker (running)'],
    summaryLines: ['line one about beta', 'line two about gamma'],
  },
  host: { hostname: 'ctrl', address: '10.0.0.1' },
}

const result = filterInventoryForUser(payload, new Set(['alpha']))

// Only alpha survives in both shapes.
assert.deepEqual(result.sandboxes.map((s) => s.name), ['alpha'], 'only alpha in sandboxes[]')
assert.equal(result.pods.items.length, 1, 'only one pod survives')
assert.equal(result.pods.items[0].metadata.name, 'alpha', 'surviving pod is alpha')

// Host-level gateway detail scrubbed.
assert.deepEqual(result.nemoclaw.serviceLines, [], 'serviceLines emptied')
assert.deepEqual(result.nemoclaw.summaryLines, [], 'summaryLines emptied')
assert.deepEqual(result.nemoclaw.defaultSandboxNames, ['alpha'], 'defaultSandboxNames filtered to allowed')
assert.equal(result.nemoclaw.available, true, 'availability flag preserved')

// No beta/gamma leakage ANYWHERE in the serialized result.
const serialized = JSON.stringify(result)
assert.ok(serialized.includes('alpha'), 'result must still contain alpha')
assert.ok(!serialized.includes('beta'), 'result must NOT contain beta anywhere')
assert.ok(!serialized.includes('gamma'), 'result must NOT contain gamma anywhere')

// Input payload must not be mutated (pure function contract).
assert.equal(payload.sandboxes.length, 3, 'original payload sandboxes must be untouched')
assert.equal(payload.nemoclaw.serviceLines.length, 2, 'original nemoclaw serviceLines must be untouched')

// Empty allowed set removes everything.
const none = filterInventoryForUser(payload, new Set())
assert.deepEqual(none.sandboxes, [], 'empty allowed → no sandboxes')
assert.deepEqual(none.pods.items, [], 'empty allowed → no pods')

console.log('inventory-filter-check: PASS OAuth inventory filter scrubs unauthorized sandboxes + host detail')
