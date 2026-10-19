// Quick Deploy must never hand OpenShell a bare Docker image ID.
//
// 2026-10-19 (Oracle): ivos-openclaw's image had lost its tag
// (ghcr.io/nvidia/nemoclaw/openclaw-sandbox:<none>), so `docker ps` reported
// `6315265961ef`. The controller passed `--from 6315265961ef`; OpenShell's
// Docker driver tried to pull it from a registry ("denied") and the clone went
// straight to Error. resolveSourcePodImageFromRef now tags such images locally
// (nemoclaw-sandbox-local:quickdeploy-<source>-<id>) before create.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const src = readFileSync(new URL('../app/api/sandbox/create/route.ts', import.meta.url), 'utf8')

const reSrc = src.match(/const BARE_IMAGE_ID = (\/.*\/[a-z]*)\n/)
assert.ok(reSrc, 'BARE_IMAGE_ID regex not found in create route')
const BARE_IMAGE_ID = eval(reSrc[1])

for (const id of ['6315265961ef', 'sha256:6315265961efa2ccf23fb84f8e74025059f823f9710085a1e044902c5d0837be']) {
  assert.ok(BARE_IMAGE_ID.test(id), `${id} should be treated as a bare image ID`)
}
for (const ref of ['nemoclaw-sandbox-local:ivos-hermes-1791537124426', 'ghcr.io/nvidia/nemoclaw/openclaw-sandbox@sha256:6315265961efa2ccf23fb84f8e74025059f823f9710085a1e044902c5d0837be', 'openshell/sandbox-from:123', 'deadbeefcafe:latest']) {
  assert.ok(!BARE_IMAGE_ID.test(ref), `${ref} is a named reference and must pass through unchanged`)
}

const fromRef = src.match(/async function resolveSourcePodImageFromRef[\s\S]*?\n}\n/)
assert.ok(fromRef, 'resolveSourcePodImageFromRef not found')
assert.match(fromRef[0], /image: await ensureNamedSourceImage\(sourceName, sourceImage\)/,
  'Quick Deploy must name (tag) the source image before returning it')
assert.match(src, /\["tag", image, tag\]/, 'ensureNamedSourceImage must docker-tag the bare ID')
assert.match(src, /nemoclaw-sandbox-local:quickdeploy-\$\{sourceName\}-\$\{short\}/)

console.log('quick-deploy-untagged-image-check: ok')
