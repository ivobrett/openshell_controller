"use client"
import Link from "next/link"
import { cn } from "@/app/lib/utils"
import { useAuth } from "@/app/components/providers/AuthProvider"
import type { SandboxInventoryItem } from "@/app/hooks/inventoryModel"
import type { McpServerAccess } from "@/app/hooks/models"

const BASELINE_IDS = ["memory", "inter-sandbox-chat"]
const BASELINE_LABELS: Record<string, string> = {
  "memory": "MEM",
  "inter-sandbox-chat": "CHAT",
}

function sandboxCanAccess(sandbox: SandboxInventoryItem, server: McpServerAccess) {
  if (!server.enabled || server.accessMode === "disabled") return false
  if (server.accessMode === "allow_all") return true
  return server.allowedSandboxIds.includes(sandbox.id) || server.allowedSandboxIds.includes(sandbox.name)
}

function Chip({ label, lit }: { label: string; lit: boolean }) {
  return (
    <span
      className={cn(
        "inline-flex items-center h-5 px-1.5 rounded text-[9px] font-mono font-semibold uppercase tracking-wider border transition-colors",
        lit ? "border-primary text-primary" : "border-muted text-muted-foreground opacity-50",
      )}
    >
      {label}
    </span>
  )
}

interface CapabilityChipsProps {
  sandbox: SandboxInventoryItem
  mcpServers: McpServerAccess[]
}

export function CapabilityChips({ sandbox, mcpServers }: CapabilityChipsProps) {
  const { me } = useAuth()

  const allowedServers = mcpServers.filter((s) => sandboxCanAccess(sandbox, s))
  const allowedIds = new Set(allowedServers.map((s) => s.id))
  const extras = allowedServers.filter((s) => !BASELINE_IDS.includes(s.id))

  const tooltip = "MCP capabilities — manage in the MCP tab"
  const href = `/sandboxes/${encodeURIComponent(sandbox.name)}?tab=mcp`

  const chips = (
    <span className="inline-flex items-center gap-1" title={tooltip}>
      {BASELINE_IDS.map((id) => (
        <Chip key={id} label={BASELINE_LABELS[id]} lit={allowedIds.has(id)} />
      ))}
      {extras.length > 0 && (
        <span
          className="inline-flex items-center h-5 px-1.5 rounded text-[9px] font-mono border border-muted text-muted-foreground"
          title={extras.map((s) => s.name).join(", ")}
        >
          +{extras.length}
        </span>
      )}
    </span>
  )

  if (me.role === "operator") {
    return (
      <Link href={href} onClick={(e) => e.stopPropagation()}>
        {chips}
      </Link>
    )
  }
  return chips
}
