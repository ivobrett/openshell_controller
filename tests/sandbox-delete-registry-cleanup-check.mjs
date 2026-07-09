// Source guards for the NemoClaw registry cleanup in the sandbox delete route.
//
// `openshell sandbox delete` only removes the sandbox at the gateway; the
// ~/.nemoclaw/sandboxes.json row survives. On NemoClaw v0.0.78+ stale rows
// are actively harmful: the installer's strict pre-upgrade backup iterates
// REGISTERED sandboxes and fails on any row whose sandbox is not running, so
// every deleted-but-not-deregistered sandbox re-arms installer Gate A on the
// next upgrade (docs/runbooks/live-vps-upgrades.md). The delete route must
// remove the row once the gateway confirms deletion — and only then.

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const source = await readFile(new URL('../app/api/sandbox/delete/route.ts', import.meta.url), 'utf8')

assert.match(
  source,
  /function removeNemoClawRegistryEntry\(sandboxName: string\)/,
  'delete route must define the registry cleanup helper',
)
assert.match(
  source,
  /if \(deleted\) \{\s*\n\s*registryCleanup = removeNemoClawRegistryEntry\(target\.sandboxName\)/,
  'registry cleanup must run only after the gateway confirms the sandbox is gone',
)
assert.match(
  source,
  /if \(current\.defaultSandbox === sandboxName\)/,
  'cleanup must repair defaultSandbox when it pointed at the deleted sandbox',
)
assert.match(
  source,
  /const tempPath = `\$\{NEMOCLAW_REGISTRY_FILE\}\.tmp\.\$\{process\.pid\}\.\$\{Date\.now\(\)\}`/,
  'registry writes must stay atomic (temp file + rename)',
)
// Best effort: a cleanup failure must not turn a successful delete into an
// HTTP error — the helper returns {ok:false} and the route only warns.
assert.match(
  source,
  /registry-cleanup:warning/,
  'cleanup failures must be logged as warnings, not thrown',
)

console.log('sandbox-delete-registry-cleanup-check: all assertions passed')
