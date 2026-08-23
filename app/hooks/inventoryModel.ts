export interface SandboxInventoryItem {
  id: string
  name: string
  namespace: string
  ip: string
  status: "running" | "pending" | "stopped" | "unknown" | "error"
  ready: boolean
  sshHostAlias?: string
  isDefault?: boolean
  agent?: string
}

export interface NemoClawSummary {
  available: boolean
  defaultSandboxNames: string[]
  serviceLines: string[]
  summaryLines: string[]
  source: "nemoclaw-cli" | "none"
}

export interface InventoryResponse {
  sandboxes?: any[]
  pods?: { items?: any[] }
  nemoclaw?: NemoClawSummary | null
  /**
   * Set when the host has no managed NemoClaw gateway yet AND has never had a
   * sandbox — a fresh box awaiting its first create, which is what actually
   * registers the gateway. Expected state, not a fault; see the FRESH-BOX
   * GATEWAY GAP note in app/api/telemetry/real/route.ts.
   */
  awaitingFirstSandbox?: boolean
}

function normalizeStatus(status: unknown): SandboxInventoryItem["status"] {
  const value = typeof status === "string" ? status.toLowerCase() : "unknown"
  if (value === "running" || value === "pending" || value === "stopped" || value === "error") return value
  return "unknown"
}

function mapSandboxSummary(sandbox: any): SandboxInventoryItem {
  const status = normalizeStatus(sandbox.status)
  return {
    id: sandbox.id || sandbox.name || "unknown",
    name: sandbox.name || "Unknown Sandbox",
    namespace: sandbox.namespace || "openshell",
    ip: sandbox.sshHostAlias || "N/A",
    status,
    ready: status === "running",
    sshHostAlias: sandbox.sshHostAlias || undefined,
    isDefault: Boolean(sandbox.isDefault),
    agent: typeof sandbox.agent === "string" && sandbox.agent ? sandbox.agent : "openclaw",
  }
}

function mapPodItem(pod: any): SandboxInventoryItem {
  const status = normalizeStatus(pod.status?.phase)
  return {
    id: pod.metadata?.labels?.["nemoclaw.ai/sandbox-id"] || pod.metadata?.name || "unknown",
    name: pod.metadata?.labels?.["nemoclaw.ai/sandbox-name"] || pod.metadata?.name || "Unknown Sandbox",
    namespace: pod.metadata?.namespace || "unknown",
    ip: pod.status?.podIP || "N/A",
    status,
    ready: pod.status?.conditions?.find((c: any) => c.type === "Ready")?.status === "True",
    sshHostAlias: pod.status?.podIP || undefined,
    isDefault: pod.metadata?.labels?.["nemoclaw.ai/default"] === "true",
    agent: pod.metadata?.labels?.["nemoclaw.ai/agent"] || "openclaw",
  }
}

export function normalizeFromResponse(data: InventoryResponse): SandboxInventoryItem[] {
  if (Array.isArray(data?.sandboxes)) {
    return data.sandboxes.map(mapSandboxSummary)
  }
  return (data?.pods?.items || [])
    .filter((pod: any) => Boolean(pod?.metadata?.name))
    .map(mapPodItem)
}
