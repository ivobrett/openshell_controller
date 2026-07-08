import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'

const root = process.cwd()
const instancesPath = path.join(root, 'app/lib/openclawInstances.ts')
const routePath = path.join(root, 'app/api/openshell/dashboard/open/route.ts')
// §5.6 (Phase 4): the dashboard-open flow moved out of SandboxList. The "Open
// dashboard" control now synchronously opens /launch/dashboard in a new tab
// (app/lib/launchDashboard.ts), and that page performs the sandbox-aware fetch
// to /api/openshell/dashboard/open (app/launch/dashboard/page.tsx).
const launchPagePath = path.join(root, 'app/launch/dashboard/page.tsx')
const launchHelperPath = path.join(root, 'app/lib/launchDashboard.ts')

const instancesSource = await readFile(instancesPath, 'utf8')
assert.match(
  instancesSource,
  /buildSandboxOpenClawInstanceId/,
  'openclaw instance registry should synthesize per-sandbox dashboard instance ids'
)
assert.doesNotMatch(
  instancesSource,
  /: \{ 'my-assistant': DEFAULT_INSTANCE_ID \}/,
  'my-assistant must not silently collapse to the default host dashboard'
)
assert.match(
  instancesSource,
  /OPENCLAW_SANDBOX_INSTANCE_MAP_JSON/,
  'openclaw instance registry should allow additive sandbox->instance JSON mappings'
)
assert.match(
  instancesSource,
  /getOpenClawDashboardPortForSandbox/,
  'openclaw instance registry should allocate stable local tunnel ports per sandbox'
)
assert.match(
  instancesSource,
  /export function resolveOpenClawInstanceForSandbox\(sandboxId\?: string \| null\)/,
  'openclaw instance registry should expose sandbox-aware instance resolution'
)
assert.match(
  instancesSource,
  /getOpenClawInstanceIdForSandbox\(sandboxId\?: string \| null\)/,
  'openclaw instance registry should expose sandbox mapping lookup'
)

const routeSource = await readFile(routePath, 'utf8')
assert.match(
  routeSource,
  /const sandboxId = requestUrl\.searchParams\.get\('sandboxId'\)/,
  'dashboard open route must accept sandboxId'
)
assert.match(
  routeSource,
  /resolveOpenClawInstanceForSandbox\(sandboxId\)/,
  'dashboard open route must resolve instances from sandbox context when instanceId is absent'
)
assert.match(
  routeSource,
  /sandboxInstanceId: mappedSandboxInstanceId/,
  'dashboard open route response should expose mapped sandbox instance metadata'
)
assert.match(
  routeSource,
  /sandboxId,\s*\n\s*sandboxInstanceId: mappedSandboxInstanceId,\s*\n\s*instanceId: instance\.id/,
  'dashboard open route response should include sandboxId alongside resolved instance metadata'
)
assert.match(
  routeSource,
  /bootstrapUrl: probe\.bootstrapUrl/,
  'dashboard open route should return explicit bootstrap URL metadata'
)
assert.match(
  routeSource,
  /bootstrapTokenPresent: probe\.bootstrapTokenPresent/,
  'dashboard open route should expose whether the bootstrap contract is tokenized'
)

const launchPageSource = await readFile(launchPagePath, 'utf8')
const launchHelperSource = await readFile(launchHelperPath, 'utf8')
assert.match(
  launchPageSource,
  /query\.set\("sandboxId", sandboxId\)/,
  'launch page must pass the sandbox name when opening the dashboard'
)
assert.match(
  launchPageSource,
  /fetch\(`\/api\/openshell\/dashboard\/open\?\$\{query\.toString\(\)\}`/,
  'launch page should call the sandbox-aware dashboard open route'
)
assert.match(
  launchHelperSource,
  /\/launch\/dashboard\?sandboxId=/,
  'open-dashboard control should open the launch page synchronously in a new tab'
)
assert.match(
  launchHelperSource,
  /"_blank"/,
  'open-dashboard control should open in a new tab so the click is never popup-blocked'
)

console.log('openclaw-dashboard-instance-resolution-check: PASS sandbox-aware dashboard resolution assertions')
