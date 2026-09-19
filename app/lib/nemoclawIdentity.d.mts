export type NemoClawRegistryData = {
  // agentVersion/hermesAuthMethod are FORK additions: app/api/telemetry/real/route.ts
  // falls back to them when the registry leaves `agent` null. Upstream's own
  // resolveSandboxAgent ignores them, which is fine — they are optional.
  sandboxes?: Record<
    string,
    { name?: string; agent?: string | null; agentVersion?: string | null; hermesAuthMethod?: string | null }
  >
}

export type NemoClawListJsonIdentity = {
  agentsByName: Record<string, string>
  defaultSandboxNames: string[]
}

export function normalizeAgentIdentifier(agent: unknown): string | null
export function parseNemoclawListJson(output: string): NemoClawListJsonIdentity | null
export function parseDefaultSandboxNames(output: string): Set<string>
export function resolveSandboxAgent(
  name: string,
  id: string | null,
  listJsonIdentity: NemoClawListJsonIdentity | null,
  registry: NemoClawRegistryData | null
): string
