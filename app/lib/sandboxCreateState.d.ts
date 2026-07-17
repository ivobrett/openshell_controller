// Type companion for sandboxCreateState.mjs (plain ESM so tests can import it
// without TS tooling, matching the policy.mjs / filterInventory.mjs pattern).

export type SandboxCreateInFlight = {
  // Intended agent for the sandbox being created ("hermes" | "openclaw" |
  // "custom" | ...). Undefined when the blueprint doesn't imply a specific
  // agent, in which case telemetry keeps its own image/registry resolution.
  agent?: string
  startedAt: number
}

export function markSandboxCreateInFlight(name: string, agent?: string): void
export function clearSandboxCreateInFlight(name: string): void
export function getSandboxCreateInFlight(name: string): SandboxCreateInFlight | undefined
export function applyInFlightPresentation(
  name: string,
  phase: string,
  agent: string,
): { phase: string; agent: string }
