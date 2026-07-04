import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'

const root = process.cwd()

const [nemoclawCliSource, routeSource, panelSource, sandboxListSource] = await Promise.all([
  readFile(path.join(root, 'app/lib/nemoclawCli.ts'), 'utf8'),
  readFile(path.join(root, 'app/api/sandbox/[sandboxId]/shields/route.ts'), 'utf8'),
  readFile(path.join(root, 'app/components/ShieldsPanel.tsx'), 'utf8'),
  readFile(path.join(root, 'app/components/SandboxList.tsx'), 'utf8'),
])

// Library: shields helpers must go through the shared runNemoClaw invocation
// (NEMOCLAW_BIN discovery + NO_COLOR env) and parse the text status output —
// NemoClaw v0.0.73 has no --json on shields.
assert.match(nemoclawCliSource, /export async function getShieldsStatus/, 'nemoclawCli must export getShieldsStatus')
assert.match(nemoclawCliSource, /export async function runShieldsAction/, 'nemoclawCli must export runShieldsAction')
assert.match(nemoclawCliSource, /export async function getShieldsAudit/, 'nemoclawCli must export getShieldsAudit')
assert.match(nemoclawCliSource, /Shields:\\s\*NOT CONFIGURED/, 'status parser must recognise the NOT CONFIGURED posture')
assert.match(nemoclawCliSource, /shields-audit\.jsonl/, 'audit trail must read the host-side shields-audit.jsonl')
assert.match(nemoclawCliSource, /shields-timer-\$\{sandboxName\}\.json/, 'status must best-effort read the detached timer restoreAt')
assert.match(nemoclawCliSource, /"--timeout", options\.timeout/, 'shields down must pass --timeout through to nemoclaw')
assert.match(nemoclawCliSource, /"--reason", options\.reason/, 'shields down must pass --reason through to nemoclaw')
assert.match(nemoclawCliSource, /SHIELDS_TIMEOUT_PATTERN/, 'shields down timeout must be validated before reaching the CLI')

// Route: per-sandbox GET (status + audit) and POST (up | down with bounded window).
assert.match(routeSource, /export async function GET/, 'shields route must expose GET status')
assert.match(routeSource, /export async function POST/, 'shields route must expose POST actions')
assert.match(routeSource, /action !== "up" && action !== "down"/, 'shields route must only accept up/down actions')
assert.match(routeSource, /validateSandboxName/, 'shields route must validate the sandbox name')
// Changing posture is OPERATOR-ONLY: shields down applies a permissive sandbox
// policy, so multi-user OAuth identities must not be able to lower shields.
assert.match(routeSource, /import \{ isOperator \} from "@\/app\/lib\/auth\/context"/, 'shields route must use the shared operator check')
assert.match(routeSource, /if \(!\(await isOperator\(request\)\)\) \{\s*\n\s*return NextResponse\.json\(\s*\n?\s*\{ ok: false, error: "Operator session required/, 'shields POST must reject non-operator sessions before acting')

// Panel: posture badge, bounded down-window selector, audit trail, and the
// permissive-policy warning (shields down widens sandbox egress).
assert.match(panelSource, /SHIELDS UP/, 'panel must render the UP posture badge')
assert.match(panelSource, /NOT CONFIGURED/, 'panel must render the default mutable posture')
assert.match(panelSource, /PERMISSIVE sandbox policy/, 'panel must warn that shields down applies a permissive policy')
assert.match(panelSource, /cannot be extended/, 'panel must state the fail-locked window semantics')
assert.match(panelSource, /auto-relock/, 'panel must surface the auto-relock countdown')
assert.match(panelSource, /Audit trail/i, 'panel must render the shields audit trail')
assert.match(panelSource, /api\/auth\/me/, 'panel must resolve the operator identity for admin-only controls')
assert.match(panelSource, /Only the operator \(admin\) can raise or lower shields/, 'panel must show a read-only note to non-admin users')

// Mounting: OpenClaw only. Hermes `shields up` is broken in NemoClaw v0.0.73
// (config-lock parent-dir perm mismatch), so the panel is not offered for
// Hermes until upstream fixes it.
assert.match(sandboxListSource, /selectedSandboxIsOpenClaw && \(\s*<DrawerSection\s*title="Shields"/, 'SandboxList must mount ShieldsPanel for openclaw sandboxes only')
assert.doesNotMatch(sandboxListSource, /selectedSandboxIsHermes\) && \(\s*<DrawerSection\s*title="Shields"/, 'ShieldsPanel must NOT be mounted for hermes (shields up broken on v0.0.73)')
assert.match(sandboxListSource, /shields: false,/, 'shields drawer must default closed')

console.log('shields-panel-check: PASS shields lib/route/panel assertions')
