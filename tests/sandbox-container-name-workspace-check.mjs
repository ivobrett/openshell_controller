// Guards for sandbox CONTAINER-NAME resolution across the OpenShell 0.0.101
// workspace-segment rename.
//
// OpenShell changed how it names sandbox containers:
//
//   0.0.85 and earlier:  openshell-<sandbox>-<uuid>
//   0.0.101 and later:   openshell-<workspace>--<sandbox>-<uuid>
//                        e.g. openshell-default--my-first-openclaw-cb37162f-…
//
// The NemoClaw v0.0.96 -> v0.0.108 bump pulled OpenShell 0.0.101 in (its
// blueprint pins min == max == 0.0.101), so every resolver that matched the old
// shape silently stopped finding containers that were demonstrably Up and
// healthy. Observed 2026-08-15 on a fresh box (178.105.141.65):
//
//   [openclaw-remote-expose] ERROR: no running container for sandbox
//   'my-first-openclaw'
//
// …fired the instant you clicked "Enable mobile app gateway access", while
// `docker ps` showed the container running. THREE call sites were affected:
//
//   1. scripts/hermes-remote/lib.sh   find_sandbox_container()
//      — shared by BOTH openclaw-remote/expose.sh and hermes-remote/expose.sh,
//        so OpenClaw mobile access AND Hermes Remote Desktop both broke.
//   2. app/lib/openclawPairing.ts     resolveContainer()
//      — the mobile-app device-pairing path.
//   3. app/api/sandbox/create/route.ts resolveSourceDockerImage()
//      — Quick Deploy's source-image lookup. This one failed SOFTLY (returns
//        null on error), so it degraded silently rather than erroring.
//
// Every fix must satisfy three properties, which this file locks in:
//   (a) match the NEW workspace-qualified layout;
//   (b) STILL match the OLD layout — boxes on 0.0.85 must keep working;
//   (c) stay anchored on the trailing UUID, so a sandbox named `foo` cannot
//       resolve to a container belonging to `foo-bar`.
//
// Note (3) additionally relies on `docker ps --filter name=` being a REGEX
// match, not a substring match. That is verified Docker behaviour (29.7.2) —
// the anchored pattern was tested live against the real container before this
// guard was written.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const here = path.dirname(fileURLToPath(import.meta.url))
const repo = path.join(here, '..')
const read = (rel) => readFileSync(path.join(repo, rel), 'utf8')

const LIB_SH = 'scripts/hermes-remote/lib.sh'
const PAIRING_LIB = 'app/lib/openclawPairing.ts'
const CREATE_ROUTE = 'app/api/sandbox/create/route.ts'

// The optional-workspace prefix every resolver must carry. Written exactly the
// same way in all three call sites so a grep keeps them in sync.
const WORKSPACE_PREFIX = '([a-z0-9][a-z0-9-]*--)?'

// Representative container names for a sandbox called `my-first-openclaw`.
const NEW_LAYOUT = 'openshell-default--my-first-openclaw-cb37162f-ad29-4d4c-8289-9d8883f0787c'
const OLD_LAYOUT = 'openshell-my-first-openclaw-cb37162f-ad29-4d4c-8289-9d8883f0787c'
// A DIFFERENT sandbox whose name merely starts with the one we're looking for.
const SIBLING = 'openshell-default--my-first-openclaw-extra-cb37162f-ad29-4d4c-8289-9d8883f0787c'

// ── 1. The shared shell helper carries the optional workspace segment ────────
{
  const lib = read(LIB_SH)
  const fn = lib.match(/find_sandbox_container\(\)\s*\{([\s\S]*?)\n\}/)
  assert.ok(fn, `find_sandbox_container() not found in ${LIB_SH}`)
  const body = fn[1]

  assert.ok(
    body.includes(WORKSPACE_PREFIX),
    `${LIB_SH}: find_sandbox_container() must accept the optional ` +
      `"<workspace>--" segment that OpenShell 0.0.101 introduced. Without it ` +
      `both openclaw-remote/expose.sh and hermes-remote/expose.sh die with ` +
      `"no running container for sandbox" on every 0.0.101 box.`,
  )
  assert.ok(
    /grep -E/.test(body),
    `${LIB_SH}: the match must use grep -E — the pattern is an ERE`,
  )
  assert.ok(
    body.includes('[0-9a-f]{8}-'),
    `${LIB_SH}: anchor on the start of the trailing UUID so a sandbox named ` +
      `'foo' cannot match a container belonging to 'foo-bar'`,
  )
  assert.ok(
    !/grep\s+"\^openshell-\$\{name\}-"/.test(body),
    `${LIB_SH}: the pre-0.0.101 bare "^openshell-\${name}-" grep is back — ` +
      `that is the exact regression this guard exists to prevent`,
  )
}

// ── 2. The TS pairing resolver carries the same pattern ─────────────────────
{
  const src = read(PAIRING_LIB)
  assert.ok(
    src.includes(WORKSPACE_PREFIX),
    `${PAIRING_LIB}: resolveContainer() must accept the optional ` +
      `"<workspace>--" segment (OpenShell 0.0.101), or mobile-app pairing ` +
      `fails with "no running container for sandbox"`,
  )
  assert.ok(
    src.includes('[0-9a-f]{8}-'),
    `${PAIRING_LIB}: anchor on the trailing UUID to avoid prefix collisions`,
  )
  assert.ok(
    !/startsWith\(`openshell-\$\{sandboxName\}-`\)/.test(src),
    `${PAIRING_LIB}: the pre-0.0.101 startsWith() check is back — it does not ` +
      `match openshell-<workspace>--<sandbox>-<uuid>`,
  )
}

// ── 3. Quick Deploy's docker filter is anchored, not a substring ─────────────
{
  const src = read(CREATE_ROUTE)
  const fn = src.match(/resolveSourceDockerImage[\s\S]*?\n\}/)
  assert.ok(fn, `resolveSourceDockerImage() not found in ${CREATE_ROUTE}`)
  const body = fn[0]

  assert.ok(
    body.includes(WORKSPACE_PREFIX),
    `${CREATE_ROUTE}: resolveSourceDockerImage() must accept the optional ` +
      `"<workspace>--" segment. This one fails SOFTLY (catch -> null), so a ` +
      `regression here degrades Quick Deploy silently instead of erroring.`,
  )
  assert.ok(
    /name=\^openshell-/.test(body),
    `${CREATE_ROUTE}: the docker name filter must be ANCHORED (^). Docker ` +
      `treats --filter name= as a regex; the old unanchored substring form ` +
      `matches nothing once the workspace segment is present.`,
  )
}

// ── 4. Behavioural: the shared pattern satisfies (a), (b) and (c) ───────────
{
  const patternFor = (name) =>
    new RegExp(`^openshell-${WORKSPACE_PREFIX}${name}-[0-9a-f]{8}-`)

  const p = patternFor('my-first-openclaw')

  assert.ok(p.test(NEW_LAYOUT), 'must match the 0.0.101 workspace-qualified name')
  assert.ok(p.test(OLD_LAYOUT), 'must still match the pre-0.0.101 name (0.0.85 boxes)')
  assert.ok(
    !patternFor('my-first').test(NEW_LAYOUT),
    'sandbox "my-first" must NOT resolve to the "my-first-openclaw" container',
  )
  assert.ok(
    !p.test(SIBLING),
    'sandbox "my-first-openclaw" must NOT resolve to the "my-first-openclaw-extra" container',
  )
  // Sanity: a totally unrelated container never matches.
  assert.ok(!p.test('openshell-default--other-sandbox-cb37162f-ad29-4d4c-8289-9d8883f0787c'))
  assert.ok(!p.test('admin-311174_main-stack-traefik-1'))
}

console.log('sandbox-container-name-workspace-check: OK')
