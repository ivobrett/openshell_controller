// Guards the TEMPORARY shim for NemoClaw #12254 (app/lib/openclawLegacyAuthProfile.ts
// + retireLegacyOpenClawAuthProfile in app/lib/sandboxPrivilegedFiles.ts).
//
// NemoClaw v0.0.128/v0.0.129's nemoclaw-start.sh writes a legacy
// ~/.openclaw/agents/main/agent/auth-profiles.json that OpenClaw 2026.9.1
// rejects (AuthProfileMigrationRequiredError) -> every OpenClaw chat turn fails.
// Upstream fix is PR #12237 (merged 2026-09-24, NOT in v0.0.129). When the
// pinned tag contains it, delete the shim, its call sites and this test.
//
// The behavioural part runs the embedded Python against temp files so the
// "remove ONLY the exact generated entry, only on inference.local" contract
// (mirrors #12237) cannot silently widen.

import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const read = (p) => readFileSync(path.join(ROOT, p), "utf8")
const privileged = read("app/lib/sandboxPrivilegedFiles.ts")
const create = read("app/api/sandbox/create/route.ts")
const restart = read("app/api/sandbox/[sandboxId]/restart/route.ts")
const shim = read("app/lib/openclawLegacyAuthProfile.ts")

// --- wiring ------------------------------------------------------------------
assert.equal(
  (create.match(/created && isOpenClawAgent \? await repairLegacyOpenClawAuthProfile\(sandboxName\)/g) || []).length,
  2,
  "both OpenClaw create paths (blueprint + Quick Deploy) must run the legacy auth-profile repair",
)
assert.match(restart, /repairLegacyOpenClawAuthProfile\(sandboxName, \{ restartGateway: false \}\)[\s\S]*restartSandboxGatewayWithNemoClaw/,
  "Restart runtime must clear the legacy file BEFORE its own native gateway restart")
assert.match(shim, /restartSandboxGatewayWithNemoClaw/, "a removal only takes effect after a native gateway restart (the refusal is cached in-process)")
assert.match(shim, /catch \(error\)/, "the repair must never throw into create")

// --- behaviour: run the embedded Python ------------------------------------
const pySrc = privileged.match(/const RETIRE_LEGACY_AUTH_PROFILE_PY = `([\s\S]*?)`\n/)?.[1]
assert.ok(pySrc, "embedded Python not found")
const py = Function(`return \`${pySrc}\``)()
const tmp = mkdtempSync(path.join(tmpdir(), "legacy-auth-"))
const home = path.join(tmp, ".openclaw")
const agentDir = path.join(home, "agents/main/agent")
mkdirSync(agentDir, { recursive: true })
const script = py.replace('"/sandbox/.openclaw"', JSON.stringify(home))
const file = path.join(agentDir, "auth-profiles.json")
const legacy = { "inference:manual": { type: "api_key", provider: "inference", keyRef: { source: "env", id: "NVIDIA_INFERENCE_API_KEY" }, profileId: "inference:manual" } }
const run = (base) => JSON.parse(execFileSync("python3", ["-c", script], { env: { ...process.env, NEMOCLAW_INFERENCE_BASE_URL: base } }).toString().trim())

writeFileSync(file, JSON.stringify(legacy))
assert.equal(run("https://inference.local/v1").changed, true)
assert.equal(existsSync(file), false, "managed route + only the generated entry -> file removed")

writeFileSync(file, JSON.stringify(legacy))
assert.equal(run("https://integrate.api.nvidia.com/v1").changed, false, "direct routes keep their profile (#12237 contract)")
assert.equal(existsSync(file), true)

writeFileSync(file, JSON.stringify({ ...legacy, "openai:me": { type: "api_key", provider: "openai" } }))
assert.equal(run("https://inference.local").changed, true)
assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { "openai:me": { type: "api_key", provider: "openai" } },
  "user-managed profiles sharing the file must be preserved")

writeFileSync(file, JSON.stringify({ "inference:manual": { ...legacy["inference:manual"], keyRef: { source: "env", id: "SOMETHING_ELSE" } } }))
assert.equal(run("https://inference.local").changed, false, "only the EXACT generated shape may be removed")

console.log("PASS: OpenClaw legacy auth-profile shim (#12254) guards")
