// Guards for sandbox -> MCP broker reachability.
//
// 2026-10-10 (Oracle BYOVPS): agents kept reporting "can't access the MCP
// server". Two causes, both locked in here:
//   1. The manifest advertised https://host.docker.internal:3000 — an https URL
//      for the controller's plain-HTTP listener, derived from the TLS reverse
//      proxy's forwarded scheme. No client could complete a handshake.
//   2. Access was granted by approving whatever one probe request proposed, so
//      it covered one program and one address per sandbox (curl allowed, the
//      agent's own MCP client denied) and vanished on recreate.

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

import {
  MCP_BROKER_CLIENT_BINARIES,
  MCP_BROKER_POLICY_PRESET,
  SANDBOX_HOST_BRIDGE,
  buildMcpBrokerPolicyPreset,
} from '../app/lib/mcpBrokerPolicyPreset.mjs'

const read = (relative) => readFile(new URL(`../${relative}`, import.meta.url), 'utf8')

// --- the preset ---
const preset = buildMcpBrokerPolicyPreset('http://host.openshell.internal:3000/api/mcp/broker')
assert.ok(preset, 'a host-bridge broker URL must produce a preset')
assert.match(preset, new RegExp(`name: ${MCP_BROKER_POLICY_PRESET}\\n`))
assert.match(preset, /host: host\.openshell\.internal\n\s+port: 3000\n/)
assert.match(preset, /allow: \{ method: POST, path: "\/api\/mcp\/broker\/\*\*" \}/)
assert.doesNotMatch(preset, /allowed_ips/, 'NemoClaw rejects user-authored allowed_ips')
assert.doesNotMatch(preset, /path: "\/\*\*"/, 'only broker paths may be opened, not the whole controller')
for (const binary of ['/usr/bin/curl', '/usr/local/bin/node', '/usr/bin/python3.13', '/opt/hermes/.venv/bin/python']) {
  assert.ok(MCP_BROKER_CLIENT_BINARIES.includes(binary), `${binary} must be allowed to reach the broker`)
  assert.ok(preset.includes(`{ path: ${binary} }`))
}
assert.match(buildMcpBrokerPolicyPreset('http://host.openshell.internal:3210/api/mcp/broker/'), /port: 3210\n/)

// URLs a preset must not be generated for (the caller falls back to probe-and-approve).
assert.equal(buildMcpBrokerPolicyPreset('https://host.openshell.internal:3000/api/mcp/broker'), null)
assert.equal(buildMcpBrokerPolicyPreset('http://host.docker.internal:3000/api/mcp/broker'), null,
  'NemoClaw refuses presets naming any private host other than the bridge')
assert.equal(buildMcpBrokerPolicyPreset('http://example.com:3000/api/mcp/broker'), null)
assert.equal(buildMcpBrokerPolicyPreset('http://host.openshell.internal:3000/a"\n  evil: true'), null)
assert.equal(buildMcpBrokerPolicyPreset('not a url'), null)

// --- the advertised URL ---
const brokerUrl = await read('app/lib/mcpBrokerUrl.ts')
assert.equal(SANDBOX_HOST_BRIDGE, 'host.openshell.internal')
assert.match(brokerUrl, /publicOrigin\.hostname = SANDBOX_HOST_BRIDGE/, 'local controller URLs must be rewritten to the sandbox host bridge')
assert.match(brokerUrl, /publicOrigin\.protocol = "http:"/, 'the bridge URL must be plain HTTP: server.mjs does not serve TLS')
assert.doesNotMatch(brokerUrl, /publicOrigin\.hostname = "host\.docker\.internal"/)

// --- the grant ---
const permissions = await read('app/lib/sandboxPermissions.ts')
const sync = permissions.slice(permissions.indexOf('export async function syncBrokerNetworkAccess'))
assert.ok(sync.indexOf('applyBrokerPolicyPreset(') < sync.indexOf('probeBrokerEndpoint('),
  'the preset must be tried before the single-binary probe-and-approve fallback')
assert.match(permissions, /removeSandboxPolicyPreset\(resolved\.name, MCP_BROKER_POLICY_PRESET\)/, 'revoking MCP access must remove the preset')

// --- the manifest quick check ---
const manifest = await read('app/lib/sandboxMcpManifest.ts')
assert.match(manifest, /curl -sS --max-time 20/, 'the quick check must use curl')
assert.doesNotMatch(manifest, /node - <<'NODE'/)

// --- the documented manual preset stays in step with the generated one ---
const manual = await read('scripts/inter-sandbox/network-policy-mcp-broker.yaml')
for (const binary of MCP_BROKER_CLIENT_BINARIES) assert.ok(manual.includes(`{ path: ${binary} }`), `manual preset is missing ${binary}`)
assert.match(manual, /host: host\.openshell\.internal/)
