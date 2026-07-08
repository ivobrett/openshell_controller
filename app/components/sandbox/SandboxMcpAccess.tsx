"use client"

import { useState } from "react"
import { queryClient } from "@/app/lib/queryClient"
import { useMcpServers, useInventory } from "@/app/hooks/queries"
import type { SandboxInventoryItem } from "@/app/hooks/inventoryModel"
import type { McpServerAccess } from "@/app/hooks/models"

// Extracted verbatim from SandboxList.tsx:981-1054 (+ the access-mutation
// helpers at 472-579). Kept on the legacy utility classes intentionally —
// the Phase 6 restyle migrates this to ui primitives + the §13.1.3 grouping.

export function sandboxCanAccessMcpServer(sandbox: SandboxInventoryItem, server: McpServerAccess) {
  if (!server.enabled || server.accessMode === "disabled") return false
  if (server.accessMode === "allow_all") return true
  return server.allowedSandboxIds.includes(sandbox.id) || server.allowedSandboxIds.includes(sandbox.name)
}

/** POST /api/mcp update-access; returns the fresh server list. */
async function postMcpAccess(
  serverId: string,
  body: Partial<Pick<McpServerAccess, "enabled" | "accessMode" | "allowedSandboxIds">>,
): Promise<McpServerAccess[]> {
  const response = await fetch("/api/mcp", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "update-access", serverId, ...body }),
  })
  const data = await response.json()
  if (!response.ok) throw new Error(data.error || "Failed to update MCP access")
  queryClient.invalidateQueries({ queryKey: ["mcp", "servers"] })
  return Array.isArray(data.servers) ? data.servers : []
}

/** Issue the broker config so the agent picks up the new server access. */
export async function syncMcpManifest(sandbox: SandboxInventoryItem): Promise<string> {
  const response = await fetch(`/api/sandbox/${encodeURIComponent(sandbox.id)}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sandboxName: sandbox.name }),
  })
  const data = await response.json()
  if (!response.ok) throw new Error(data.error || "Failed to issue MCP broker config")
  return data.note || "MCP broker config issued."
}

/** Grant a server to a sandbox, then re-issue the manifest. */
export async function enableMcpForSandbox(sandbox: SandboxInventoryItem, server: McpServerAccess) {
  const current = new Set(server.allowedSandboxIds)
  current.add(sandbox.id)
  await postMcpAccess(server.id, {
    enabled: true,
    accessMode: server.accessMode === "allow_all" ? "allow_all" : "allow_only",
    allowedSandboxIds: Array.from(current),
  })
  return syncMcpManifest(sandbox)
}

interface SandboxMcpAccessProps {
  sandbox: SandboxInventoryItem
}

export function SandboxMcpAccess({ sandbox }: SandboxMcpAccessProps) {
  const mcpQuery = useMcpServers()
  const mcpServers = mcpQuery.data ?? []
  const { sandboxes } = useInventory()
  const [mcpMessage, setMcpMessage] = useState("")
  const [mcpUpdatingServerId, setMcpUpdatingServerId] = useState<string | null>(null)
  const [mcpSyncing, setMcpSyncing] = useState(false)

  const updateMcpServerAccess = async (
    server: McpServerAccess,
    body: Partial<Pick<McpServerAccess, "enabled" | "accessMode" | "allowedSandboxIds">>,
    success: string,
  ) => {
    try {
      setMcpUpdatingServerId(server.id)
      setMcpMessage("")
      await postMcpAccess(server.id, body)
      setMcpMessage(success)
    } catch (error) {
      setMcpMessage(error instanceof Error ? error.message : "Failed to update MCP access")
    } finally {
      setMcpUpdatingServerId(null)
    }
  }

  const issueManifest = async () => {
    try {
      setMcpSyncing(true)
      setMcpMessage(`Issuing MCP broker config for ${sandbox.name}...`)
      const note = await syncMcpManifest(sandbox)
      setMcpMessage(note)
    } catch (error) {
      setMcpMessage(error instanceof Error ? error.message : "Failed to issue MCP broker config")
    } finally {
      setMcpSyncing(false)
    }
  }

  const enableForSandbox = async (server: McpServerAccess) => {
    try {
      setMcpUpdatingServerId(server.id)
      setMcpMessage("")
      await enableMcpForSandbox(sandbox, server)
      setMcpMessage(`${server.name} enabled for ${sandbox.name}.`)
    } catch (error) {
      setMcpMessage(error instanceof Error ? error.message : "Failed to update MCP access")
    } finally {
      setMcpUpdatingServerId(null)
    }
  }

  const revokeForSandbox = async (server: McpServerAccess) => {
    const current = new Set(server.allowedSandboxIds)
    current.delete(sandbox.id)
    current.delete(sandbox.name)
    // An allow_all server grants access via mode alone (allowedSandboxIds is
    // typically empty), so switching it to allow_only would silently revoke
    // every OTHER sandbox too. Re-add all peers first. (Ported from the
    // pre-refactor SandboxList revoke path — restores the load-bearing branch.)
    if (server.accessMode === "allow_all") {
      for (const item of sandboxes) {
        if (item.id !== sandbox.id) current.add(item.id)
      }
    }
    try {
      setMcpUpdatingServerId(server.id)
      setMcpMessage("")
      await postMcpAccess(server.id, {
        accessMode: "allow_only",
        allowedSandboxIds: Array.from(current),
      })
      await syncMcpManifest(sandbox)
      setMcpMessage(`${server.name} revoked from ${sandbox.name}.`)
    } catch (error) {
      setMcpMessage(error instanceof Error ? error.message : "Failed to update MCP access")
    } finally {
      setMcpUpdatingServerId(null)
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-4 rounded-sm border border-[var(--border-subtle)] bg-[var(--background-tertiary)] p-4 max-sm:flex-col max-sm:items-start">
        <div>
          <h4 className="text-xs font-semibold uppercase tracking-wider text-[var(--foreground-hex)]">Sandbox Manifest</h4>
          <p className="mt-1 text-xs text-[var(--foreground-dim)]">
            Writes <span className="font-mono text-[var(--foreground-hex)]">/sandbox/openshell_control_mcp.md</span> with broker URL and sandbox token only.
          </p>
        </div>
        <button
          type="button"
          disabled={mcpSyncing}
          onClick={issueManifest}
          className="action-button px-3 py-2 max-sm:w-full"
        >
          {mcpSyncing ? "Issuing..." : "Issue Broker Config"}
        </button>
      </div>
      {mcpMessage && (
        <div className="rounded-sm border border-[var(--border-subtle)] bg-[var(--background-tertiary)] p-3 text-xs text-[var(--foreground-dim)]">
          {mcpMessage}
        </div>
      )}
      {mcpServers.length === 0 ? (
        <div className="rounded-sm border border-[var(--border-subtle)] bg-[var(--background-tertiary)] p-4 text-xs text-[var(--foreground-dim)]">
          No MCP servers are installed yet.
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
          {mcpServers.map((server) => {
            const hasAccess = sandboxCanAccessMcpServer(sandbox, server)
            const updating = mcpUpdatingServerId === server.id
            return (
              <div key={server.id} className="rounded-sm border border-[var(--border-subtle)] bg-[var(--background-tertiary)] p-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h4 className="truncate text-sm font-mono font-semibold text-[var(--foreground-hex)]">{server.name}</h4>
                    <p className="mt-1 break-all font-mono text-[11px] text-[var(--foreground-dim)]">{server.command} {server.args.join(" ")}</p>
                  </div>
                  <span className={`status-chip px-2 py-1 ${hasAccess ? "bg-[var(--status-running-bg)] text-[var(--status-running)]" : "bg-[var(--status-pending-bg)] text-[var(--status-pending)]"}`}>
                    {hasAccess ? "allowed" : "blocked"}
                  </span>
                </div>
                <div className="mt-4 flex gap-2 max-sm:flex-col">
                  <button
                    type="button"
                    disabled={updating || hasAccess}
                    onClick={() => enableForSandbox(server)}
                    className="action-button flex-1 px-3 py-2"
                  >
                    Enable
                  </button>
                  <button
                    type="button"
                    disabled={updating || !server.enabled}
                    onClick={() => updateMcpServerAccess(server, { enabled: false }, `${server.name} disabled globally.`)}
                    className="action-button flex-1 px-3 py-2"
                  >
                    Disable
                  </button>
                  <button
                    type="button"
                    disabled={updating || !hasAccess}
                    onClick={() => revokeForSandbox(server)}
                    className="action-button flex-1 px-3 py-2"
                  >
                    Revoke
                  </button>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
