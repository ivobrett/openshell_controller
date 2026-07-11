// Guards the agent display mapping (app/lib/agentDisplay.ts).
//
// Historical failure (2026-07-11): deepagents sandboxes (registry agent
// "langchain-deepagents-code") displayed as "OpenClaw" in the dashboard —
// SandboxTable, the sandbox detail page, and SandboxTypeLogo each carried a
// private mapping whose fallback returned "OpenClaw" for every unknown agent.
// This check pins the shared helper and makes sure the UI call sites use it
// instead of re-growing local copies.
import { readFile } from "node:fs/promises"
import assert from "node:assert"
import path from "node:path"
import { fileURLToPath } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

const [helper, table, detailPage, typeLogo] = await Promise.all([
  readFile(path.join(root, "app/lib/agentDisplay.ts"), "utf8"),
  readFile(path.join(root, "app/components/sandbox/SandboxTable.tsx"), "utf8"),
  readFile(path.join(root, "app/(shell)/sandboxes/[name]/page.tsx"), "utf8"),
  readFile(path.join(root, "app/components/sandbox/SandboxTypeLogo.tsx"), "utf8"),
])

// The helper must know Deep Agents and must not collapse unknown agents to
// "OpenClaw" (unknowns get humanized instead).
assert.match(
  helper,
  /"langchain-deepagents-code":\s*"Deep Agents"/,
  "agentDisplay.ts must map langchain-deepagents-code to 'Deep Agents'",
)
assert.doesNotMatch(
  helper,
  /if\s*\(known\)[\s\S]*return\s*"OpenClaw"\s*$/m,
  "agentDisplay.ts unknown-agent fallback must not return 'OpenClaw'",
)

// UI call sites must import the shared helper and not re-declare a local
// mapping whose default branch claims OpenClaw.
for (const [name, src] of [
  ["SandboxTable.tsx", table],
  ["sandboxes/[name]/page.tsx", detailPage],
]) {
  assert.match(
    src,
    /import \{ displaySandboxAgent \} from "@\/app\/lib\/agentDisplay"/,
    `${name} must import displaySandboxAgent from app/lib/agentDisplay`,
  )
  assert.doesNotMatch(
    src,
    /function displaySandboxAgent/,
    `${name} must not re-declare a local displaySandboxAgent`,
  )
}

// The type logo must derive its label from the shared helper and give
// non-OpenClaw/Hermes/Custom agents their own visual kind.
assert.match(
  typeLogo,
  /import \{ displaySandboxAgent \} from "@\/app\/lib\/agentDisplay"/,
  "SandboxTypeLogo.tsx must import displaySandboxAgent",
)
assert.match(
  typeLogo,
  /"other"/,
  "SandboxTypeLogo.tsx must keep a distinct 'other' agent kind so unknown agents don't render the OpenClaw logo",
)

console.log("agent-display-check: OK")
