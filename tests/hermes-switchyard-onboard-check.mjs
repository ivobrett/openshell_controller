import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'

const root = process.cwd()
const createRouteSource = await readFile(path.join(root, 'app/api/sandbox/create/route.ts'), 'utf8')
const libSource = await readFile(path.join(root, 'app/lib/hermesSwitchyard.ts'), 'utf8')
const providersSource = await readFile(path.join(root, 'app/lib/hermesSwitchyardProviders.ts'), 'utf8')
const configPanelSource = await readFile(path.join(root, 'app/components/ConfigurationPanel.tsx'), 'utf8')

assert.match(libSource, /\["--switchyard-config", filePath\]/, 'Hermes onboard must pass --switchyard-config <file>')
assert.match(createRouteSource, /agent !== "hermes" \|\| command\.mode !== "cli-onboard"/, 'Switchyard args must only be added to Hermes CLI onboarding')
assert.match(createRouteSource, /withHermesSwitchyardConfig\(\s*buildNemoClawCreateCommand\(gpuMode, agent, sandboxName\),/, 'Switchyard must wrap the unchanged onboard command')
assert.match(createRouteSource, /parseHermesSwitchyardRequest\(body\?\.switchyard\)/, 'create route must read the optional switchyard request field')
assert.match(createRouteSource, /Switchyard adaptive routing is supported only for Hermes sandboxes/, 'create route must reject Switchyard for OpenClaw')
assert.match(createRouteSource, /clearSandboxCreateInFlight\(inFlightSandboxName\)\n\s*\/\/[^\n]*\n\s*switchyardFile\?\.cleanup\(\)/, 'temporary Switchyard config must outlive onboard retries and be removed when the request ends')
assert.match(createRouteSource, /blueprint !== "nemoclaw-hermes"/, 'create route must reject Switchyard outside the Fresh Hermes blueprint')
assert.match(libSource, /mode: 0o600, flag: "wx"/, 'Switchyard config file must be private and freshly created')
assert.doesNotMatch(libSource, /apiKey|base_url|baseUrl/, 'Switchyard config must stay secret-free and endpoint-free')
for (const provider of ['nvidia-prod', 'openai-api', 'anthropic-prod', 'gemini-api', 'openrouter-api']) {
  assert.match(providersSource, new RegExp(`id: "${provider}"`), `Switchyard providers must include ${provider}`)
}
assert.doesNotMatch(providersSource, /from "node:/, 'provider list must stay client-safe')
assert.match(configPanelSource, /selectedBlueprint === 'nemoclaw-hermes' && switchyardEnabled/, 'UI must only send Switchyard routing for Hermes')
assert.match(configPanelSource, /useBaseline && !switchyardRequested/, 'Switchyard must bypass the baseline clone, which never runs onboard')
assert.match(configPanelSource, /createInference, switchyard, policy/, 'UI must send switchyard in the create request')

console.log('hermes switchyard onboard checks passed')
