"use client"

import { useEffect, useMemo, useState } from "react"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/app/components/ui/select"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/app/components/ui/collapsible"
import { Input } from "@/app/components/ui/input"
import { Button } from "@/app/components/ui/button"
import { ChevronDown, Server } from "lucide-react"
import { cn } from "@/app/lib/utils"

type ControllerNodeRecord = {
  id: string
  name: string
  host: string
  url: string
  role: "local" | "controller-node"
  status: "configured" | "local"
}

const SELECTED_CONTROLLER_NODE_KEY = "openshell-control-selected-node"

export function NodeSwitcher() {
  const [controllerNodes, setControllerNodes] = useState<ControllerNodeRecord[]>([])
  const [selectedNodeId, setSelectedNodeId] = useState("local")
  const [open, setOpen] = useState(false)
  const [friendlyNameDraft, setFriendlyNameDraft] = useState("")
  const [friendlyNameSaving, setFriendlyNameSaving] = useState(false)
  const [friendlyNameMessage, setFriendlyNameMessage] = useState("")

  const selectedNode = useMemo(
    () => controllerNodes.find((n) => n.id === selectedNodeId) || controllerNodes[0] || null,
    [controllerNodes, selectedNodeId],
  )

  useEffect(() => {
    const stored = window.localStorage.getItem(SELECTED_CONTROLLER_NODE_KEY)
    if (stored) setSelectedNodeId(stored)
  }, [])

  useEffect(() => {
    let cancelled = false
    const load = () => {
      fetch("/api/controller-node/registry", { cache: "no-store" })
        .then((r) => r.json())
        .then((data) => {
          if (cancelled) return
          const nodes: ControllerNodeRecord[] = Array.isArray(data.nodes) ? data.nodes : []
          setControllerNodes(nodes)
          if (nodes.length > 1) setOpen(true)
          setSelectedNodeId((cur) => (nodes.some((n) => n.id === cur) ? cur : nodes[0]?.id || "local"))
        })
        .catch(() => { if (!cancelled) setControllerNodes([]) })
    }
    load()
    window.addEventListener("controller-nodes-changed", load)
    return () => { cancelled = true; window.removeEventListener("controller-nodes-changed", load) }
  }, [])

  useEffect(() => {
    if (!selectedNode) return
    setFriendlyNameDraft(selectedNode.name)
    window.localStorage.setItem(SELECTED_CONTROLLER_NODE_KEY, selectedNode.id)
  }, [selectedNode])

  async function saveFriendlyName() {
    if (!selectedNode || friendlyNameSaving) return
    try {
      setFriendlyNameSaving(true)
      setFriendlyNameMessage("")
      const r = await fetch("/api/controller-node/registry", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "rename", nodeId: selectedNode.id, name: friendlyNameDraft }),
      })
      const data = await r.json()
      if (!r.ok) throw new Error(data.error || "Failed to save node name")
      setControllerNodes(Array.isArray(data.nodes) ? data.nodes : [])
      setFriendlyNameMessage("Saved")
    } catch (err) {
      setFriendlyNameMessage(err instanceof Error ? err.message : "Failed to save")
    } finally {
      setFriendlyNameSaving(false)
    }
  }

  if (controllerNodes.length === 0) return null

  const hasRemoteNodes = controllerNodes.some((n) => n.role === "controller-node")

  return (
    <div className="mt-3 space-y-2">
      <div className="flex items-center gap-2">
        <Server className="h-3 w-3 text-muted-foreground shrink-0" />
        <span className={cn(
          "text-[10px] font-mono uppercase tracking-wider px-1.5 py-0.5 rounded-full",
          hasRemoteNodes
            ? "bg-primary/15 text-primary"
            : "bg-muted text-muted-foreground",
        )}>
          {hasRemoteNodes ? "multi-node" : "local"}
        </span>
      </div>

      {controllerNodes.length > 1 && (
        <div className="space-y-1">
          <span className="text-[10px] uppercase tracking-wider text-muted-foreground">Managed Node</span>
          <Select value={selectedNodeId} onValueChange={setSelectedNodeId}>
            <SelectTrigger className="h-8 text-xs font-mono">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {controllerNodes.map((n) => (
                <SelectItem key={n.id} value={n.id} className="text-xs font-mono">
                  {n.name} — {n.host}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}

      {selectedNode && (
        <Collapsible open={open} onOpenChange={setOpen}>
          <CollapsibleTrigger asChild>
            <button className="flex w-full items-center justify-between text-[10px] text-muted-foreground hover:text-foreground transition-colors">
              <span className="truncate font-mono">{selectedNode.name} / {selectedNode.host}</span>
              <ChevronDown className={cn("h-3 w-3 shrink-0 transition-transform", open && "rotate-180")} />
            </button>
          </CollapsibleTrigger>
          <CollapsibleContent className="space-y-2 pt-2">
            <p className="truncate text-[10px] font-mono text-muted-foreground">{selectedNode.url}</p>
            <div className="space-y-1.5">
              <span className="text-[10px] uppercase tracking-wider text-muted-foreground">Friendly Name</span>
              <Input
                value={friendlyNameDraft}
                onChange={(e) => setFriendlyNameDraft(e.target.value)}
                className="h-7 text-xs font-mono"
              />
              <div className="flex items-center justify-between gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={saveFriendlyName}
                  disabled={friendlyNameSaving || !friendlyNameDraft.trim()}
                  className="h-6 px-2 text-[10px]"
                >
                  {friendlyNameSaving ? "Saving…" : "Save name"}
                </Button>
                {friendlyNameMessage && (
                  <span className="text-[10px] text-muted-foreground">{friendlyNameMessage}</span>
                )}
              </div>
            </div>
          </CollapsibleContent>
        </Collapsible>
      )}
    </div>
  )
}
