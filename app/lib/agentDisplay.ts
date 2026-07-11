// Single source of truth for turning a sandbox `agent` identifier (the
// NemoClaw registry `agent` field, e.g. "openclaw", "hermes",
// "langchain-deepagents-code", or "custom" for bare openshell sandboxes)
// into a human-readable name. Unknown agents display a humanized form of
// their identifier rather than falsely claiming "OpenClaw" — that mislabel
// is exactly what this helper exists to prevent (deepagents sandboxes
// showed as OpenClaw, 2026-07-11).
const AGENT_DISPLAY_NAMES: Record<string, string> = {
  openclaw: "OpenClaw",
  hermes: "Hermes",
  custom: "Custom",
  "langchain-deepagents-code": "Deep Agents",
}

export function displaySandboxAgent(agent?: string | null): string {
  const key = typeof agent === "string" ? agent.trim().toLowerCase() : ""
  if (!key) return "OpenClaw"
  const known = AGENT_DISPLAY_NAMES[key]
  if (known) return known
  return key
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase())
}
