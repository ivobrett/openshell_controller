export type ActivityEntry = {
  id: string
  timestamp: string
  type: string
  message: string
  sandboxName?: string
  status?: "success" | "error" | "info" | "warning"
}

export type TelemetryData = {
  cpu: number
  memory: number
  disk: number
  gpuMemoryUsed?: number
  gpuMemoryTotal?: number
  gpuTemperature?: number
  timestamp: string
}

export type McpServerAccess = {
  id: string
  name: string
  summary?: string
  command: string
  args: string[]
  enabled: boolean
  accessMode: "disabled" | "allow_all" | "allow_only"
  allowedSandboxIds: string[]
}

export type NetworkRuleRequest = {
  chunkId: string
  status: string
  rule: string
  binary: string
  confidence: string
  rationale: string
  endpoints: string[]
  binaries: string[]
}

export type PermissionFeed = {
  latest?: { status?: string; chunkId?: string; error?: string } | null
  pending?: NetworkRuleRequest[]
  recent?: NetworkRuleRequest[]
  pendingCount?: number
  rejectedCount?: number
}
