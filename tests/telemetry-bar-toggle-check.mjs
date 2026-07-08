import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'

const root = process.cwd()
const dashboardPagePath = path.join(root, 'app/(shell)/page.tsx')
const helpPagePath = path.join(root, 'app/(shell)/help/page.tsx')
const helpPanelPath = path.join(root, 'app/components/HelpPanel.tsx')

const [dashboardPageSource, helpPageSource, helpPanelSource] = await Promise.all([
  readFile(dashboardPagePath, 'utf8'),
  readFile(helpPagePath, 'utf8'),
  readFile(helpPanelPath, 'utf8'),
])
const pageSource = dashboardPageSource + '\n' + helpPageSource

assert.match(pageSource, /useState\(false\)/, 'telemetry bar must be disabled by default')
assert.match(pageSource, /TELEMETRY_BAR_ENABLED_KEY/, 'telemetry bar preference must have a persistent storage key')
assert.match(pageSource, /telemetryBarEnabled && <LiveTelemetryBar \/>/, 'live telemetry bar must only mount when enabled')
assert.match(pageSource, /localStorage\.setItem\(TELEMETRY_BAR_ENABLED_KEY/, 'telemetry bar preference must persist when toggled')
assert.match(helpPanelSource, /Enable Telemetry Bar - EXPERIMENTAL/, 'Help must expose the requested telemetry bar checkbox label')
assert.match(helpPanelSource, /The telemetry bar is setup for vLLM tokens per second and does not currently work with other endpoints\./, 'Help must include the requested experimental caveat')
assert.match(helpPanelSource, /type="checkbox"[\s\S]*checked=\{telemetryBarEnabled\}/, 'Help checkbox must reflect telemetry bar enabled state')

console.log('telemetry bar toggle checks passed')
