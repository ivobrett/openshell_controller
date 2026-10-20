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

// Saved-image Quick Deploy: only local nemoclaw-sandbox-local:<tag> images, never a registry ref.
const localRe = src.match(/const LOCAL_SANDBOX_IMAGE_REF = (\/.*\/[a-z]*)\n/)
assert.ok(localRe, 'LOCAL_SANDBOX_IMAGE_REF not found')
const LOCAL = eval(localRe[1])
assert.ok(LOCAL.test('nemoclaw-sandbox-local:openclaw-2026.10.5-from-ivos-openclaw'))
assert.ok(LOCAL.test('nemoclaw-sandbox-local:quickdeploy-ivos-openclaw-6315265961ef'))
for (const bad of ['ghcr.io/nvidia/nemoclaw/openclaw-sandbox:latest', 'nemoclaw-sandbox-local', 'nemoclaw-sandbox-local:x;rm -rf /', 'evil.io/nemoclaw-sandbox-local:x', '6315265961ef']) {
  assert.ok(!LOCAL.test(bad), `${bad} must be rejected as a Quick Deploy image`)
}
assert.match(src, /\["image", "inspect", "--format", "\{\{\.Id\}\}", image\]/, 'requested image must be checked to exist locally')
assert.match(src, /let sourceImage = source\.image\n\s+if \(requestedSourceImage\)/, 'saved image overrides the running image only when requested')
assert.match(src, /localImages: await listLocalSandboxImages\(\)/, 'GET must list saved images for the UI')

const panel = readFileSync(new URL('../app/components/ConfigurationPanel.tsx', import.meta.url), 'utf8')
assert.match(panel, /sourceSandboxName, sourceImage \}\)/, 'Quick Deploy form must send sourceImage')
assert.match(panel, /Source sandbox&apos;s running image \(default\)/)

console.log('quick-deploy saved-image check: ok')

// Quick Deploy clones must carry their OWN NemoClaw lifecycle identity
// (sha256 of the new OpenShell sandbox id), never the source's.
const reg = src.match(/function registerNemoClawImageRedeploy[\s\S]*?\n}\n/)
assert.ok(reg, 'registerNemoClawImageRedeploy not found')
assert.match(reg[0], /delete inheritable\.lifecycleLiveIdentityFingerprint/, 'source identity fingerprint must not be inherited')
assert.match(reg[0], /\.\.\.inheritable,/)
assert.doesNotMatch(reg[0], /\.\.\.sourceEntry,/, 'spreading the raw source entry re-introduces the identity bug')
assert.match(src, /createHash\("sha256"\)\.update\(id\)\.digest\("hex"\)/, 'fingerprint = sha256(OpenShell sandbox id), as NemoClaw computes it')
assert.match(src, /registerNemoClawImageRedeploy\(source\.name, sandboxName, await readLiveSandboxIdentityFingerprint\(sandboxName\)\)/)
console.log('quick-deploy registry identity check: ok')
