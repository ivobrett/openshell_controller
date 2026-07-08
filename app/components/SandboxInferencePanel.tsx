"use client"

import { useCallback, useEffect, useState } from "react"
import { Button } from "@/app/components/ui/button"
import { Input } from "@/app/components/ui/input"
import { Alert, AlertDescription } from "@/app/components/ui/alert"
import { Card } from "@/app/components/ui/card"
import type { SandboxInventoryItem } from "../hooks/inventoryModel"

type ProviderSummary = {
  id: string | null
  name: string | null
  type: string | null
}

type InferenceRouteStatus = {
  configured: boolean
  provider: string | null
  model: string | null
  version: string | null
  timeout: string | null
}

type OllamaModel = {
  id?: string
  name: string
  sizeLabel: string | null
  parameterSize: string | null
  quantization: string | null
  hostLabel?: string | null
  hostKind?: string | null
}

type SandboxInferenceRoute = {
  id: string
  provider: string
  model: string
  enabled: boolean
  label: string
}

type VerifiedInferenceRoute = {
  id?: string
  provider: string | null
  model: string | null
  label?: string | null
  source?: string | null
  lastVerifiedAt?: string | null
}

type VerifiedSandboxInferenceRoute = SandboxInferenceRoute & {
  scope: string
  source: string
  lastVerifiedAt: string | null
}

type SandboxInferenceConfig = {
  sandboxId: string
  provider: string
  primaryModel: string
  models: string[]
  routes: SandboxInferenceRoute[]
  primaryRouteId: string
  updatedAt: string | null
}

function OllamaHostBadge({ label }: { label?: string | null }) {
  if (!label) return null
  return <span className="shrink-0 rounded-sm border border-border bg-muted px-1.5 py-0.5 text-[9px] font-mono uppercase tracking-wider text-muted-foreground">[{label}]</span>
}

function ollamaModelKey(item: OllamaModel) {
  return item.id || `${item.hostLabel || "LOCAL"}:${item.name}`
}

function makeRoute(provider: string, model: string, label = ""): SandboxInferenceRoute {
  return { id: `${provider}::${model}`, provider, model, enabled: true, label }
}

function routeKey(route: Pick<SandboxInferenceRoute, "provider" | "model">) {
  return `${route.provider}::${route.model}`
}

function dedupeRoutes(routes: SandboxInferenceRoute[]) {
  return Array.from(new Map(routes
    .filter((route) => route.provider.trim() && route.model.trim())
    .map((route) => {
      const id = routeKey(route)
      return [id, { ...route, id }]
    })).values())
}

function sourceScope(source: string | null | undefined) {
  switch (source) {
    case "gateway": return "Sandbox"
    case "system": return "System"
    case "sandbox": return "Sandbox Config"
    default: return "Verified"
  }
}

function verifiedRouteFromStatus(route: InferenceRouteStatus | undefined, label: string, source: "gateway" | "system") {
  return route?.configured && route.provider && route.model
    ? { ...makeRoute(route.provider, route.model, label), scope: sourceScope(source), source, lastVerifiedAt: null }
    : null
}

function normalizeVerifiedRoute(route: VerifiedInferenceRoute): VerifiedSandboxInferenceRoute | null {
  const provider = typeof route.provider === "string" ? route.provider.trim() : ""
  const model = typeof route.model === "string" ? route.model.trim() : ""
  if (!provider || !model) return null
  const source = typeof route.source === "string" && route.source.trim() ? route.source.trim() : "saved"
  return { ...makeRoute(provider, model, typeof route.label === "string" ? route.label.trim() : ""), scope: sourceScope(source), source, lastVerifiedAt: typeof route.lastVerifiedAt === "string" && route.lastVerifiedAt.trim() ? route.lastVerifiedAt : null }
}

function dedupeVerifiedRoutes(routes: Array<VerifiedSandboxInferenceRoute | null>) {
  return Array.from(new Map(routes
    .filter((route): route is VerifiedSandboxInferenceRoute => Boolean(route))
    .map((route) => [route.id, route])).values())
}

const inputCls = "w-full rounded-md border border-input bg-background px-3 py-2 text-sm font-mono text-foreground focus:outline-none focus:ring-1 focus:ring-ring"

export default function SandboxInferencePanel({
  sandbox,
  embedded = false,
  showHeader = true,
}: {
  sandbox: SandboxInventoryItem
  embedded?: boolean
  showHeader?: boolean
}) {
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [applying, setApplying] = useState(false)
  const [message, setMessage] = useState("")
  const [isError, setIsError] = useState(false)
  const [providers, setProviders] = useState<ProviderSummary[]>([])
  const [verifiedRoutes, setVerifiedRoutes] = useState<VerifiedSandboxInferenceRoute[]>([])
  const [routes, setRoutes] = useState<SandboxInferenceRoute[]>([])
  const [primaryRouteId, setPrimaryRouteId] = useState("")
  const [draftProvider, setDraftProvider] = useState("")
  const [draftModel, setDraftModel] = useState("")
  const [draftLabel, setDraftLabel] = useState("")
  const [updatedAt, setUpdatedAt] = useState<string | null>(null)
  const [ollamaModels, setOllamaModels] = useState<OllamaModel[]>([])
  const [ollamaLoading, setOllamaLoading] = useState(false)

  const draftProviderIsOllama = draftProvider.toLowerCase().includes("ollama")
  const anyOllamaRoute = routes.some((route) => route.provider.toLowerCase().includes("ollama"))
  const shouldPollOllama = draftProviderIsOllama || anyOllamaRoute

  function setMsg(text: string, error = false) { setIsError(error); setMessage(text) }

  const loadOllamaModels = useCallback(async () => {
    try {
      setOllamaLoading(true)
      const response = await fetch("/api/ollama/models", { cache: "no-store" })
      const data = await response.json()
      setOllamaModels(data.available && Array.isArray(data.models) ? data.models : [])
    } finally {
      setOllamaLoading(false)
    }
  }, [])

  const load = useCallback(async () => {
    try {
      setLoading(true)
      setMessage("")
      const [inferenceResponse, configResponse] = await Promise.all([
        fetch("/api/inference", { cache: "no-store" }),
        fetch(`/api/sandbox/${encodeURIComponent(sandbox.id)}/inference`, { cache: "no-store" }),
      ])
      const inferenceData = await inferenceResponse.json()
      const configData = await configResponse.json()
      if (!inferenceResponse.ok) throw new Error(inferenceData.error || "Failed to load providers")
      if (!configResponse.ok) throw new Error(configData.error || "Failed to load sandbox inference config")

      const nextProviders = Array.isArray(inferenceData.providers) ? inferenceData.providers : []
      const config = configData.config as SandboxInferenceConfig
      const gatewayRoute = inferenceData.gateway as InferenceRouteStatus | undefined
      const systemRoute = inferenceData.system as InferenceRouteStatus | undefined
      const explicitVerifiedRoutes = Array.isArray(inferenceData.verifiedRoutes)
        ? inferenceData.verifiedRoutes.map((route: VerifiedInferenceRoute) => normalizeVerifiedRoute(route))
        : []
      const hasExplicitVerifiedRoutes = explicitVerifiedRoutes.some(Boolean)
      const nextVerifiedRoutes = dedupeVerifiedRoutes(hasExplicitVerifiedRoutes
        ? explicitVerifiedRoutes
        : [
            verifiedRouteFromStatus(gatewayRoute, "Active sandbox route", "gateway"),
            verifiedRouteFromStatus(systemRoute, "Active system route", "system"),
          ])
      const fallbackRoute = gatewayRoute?.configured && gatewayRoute.provider && gatewayRoute.model
        ? makeRoute(gatewayRoute.provider, gatewayRoute.model, "Gateway default")
        : nextVerifiedRoutes[0]
      const fallbackProvider = fallbackRoute?.provider || nextProviders[0]?.name || ""
      const fallbackModel = fallbackRoute?.model || ""
      const nextRoutes = dedupeRoutes(Array.isArray(config?.routes) && config.routes.length > 0
        ? config.routes
        : fallbackProvider && fallbackModel
          ? [makeRoute(fallbackProvider, fallbackModel, "Gateway default")]
          : [])

      setProviders(nextProviders)
      setVerifiedRoutes(nextVerifiedRoutes)
      setRoutes(nextRoutes)
      setPrimaryRouteId(config?.primaryRouteId || nextRoutes[0]?.id || "")
      setDraftProvider(fallbackProvider)
      setDraftModel("")
      setDraftLabel("")
      setUpdatedAt(config?.updatedAt || null)
    } catch (error) {
      setMsg(error instanceof Error ? error.message : "Failed to load sandbox inference config", true)
    } finally {
      setLoading(false)
    }
  }, [sandbox.id])

  useEffect(() => { load() }, [load])

  useEffect(() => {
    if (!shouldPollOllama) return
    loadOllamaModels()
    const interval = window.setInterval(loadOllamaModels, 10000)
    return () => window.clearInterval(interval)
  }, [shouldPollOllama, loadOllamaModels])

  function addRoute(provider = draftProvider, model = draftModel, label = draftLabel) {
    const cleanProvider = provider.trim()
    const cleanModel = model.trim()
    if (!cleanProvider || !cleanModel) { setMsg("Choose a provider and model before adding a route.", true); return }
    const nextRoute = makeRoute(cleanProvider, cleanModel, label.trim())
    setRoutes((current) => {
      const next = dedupeRoutes([...current, nextRoute])
      if (!primaryRouteId) setPrimaryRouteId(nextRoute.id)
      return next
    })
    setDraftModel(""); setDraftLabel(""); setMessage("")
  }

  function updateRoute(id: string, updates: Partial<SandboxInferenceRoute>) {
    setRoutes((current) => {
      let replacementId = id
      const next = current.map((route) => {
        if (route.id !== id) return route
        const updated = { ...route, ...updates }
        replacementId = routeKey(updated)
        return { ...updated, id: replacementId }
      })
      if (primaryRouteId === id) setPrimaryRouteId(replacementId)
      return dedupeRoutes(next)
    })
  }

  function removeRoute(id: string) {
    setRoutes((current) => {
      const next = current.filter((route) => route.id !== id)
      if (primaryRouteId === id) setPrimaryRouteId(next[0]?.id || "")
      return next
    })
  }

  async function save() {
    try {
      setSaving(true); setMessage("")
      const cleanRoutes = dedupeRoutes(routes)
      if (cleanRoutes.length === 0) throw new Error("Add at least one provider/model route.")
      const primary = cleanRoutes.find((route) => route.id === primaryRouteId) || cleanRoutes[0]
      const response = await fetch(`/api/sandbox/${encodeURIComponent(sandbox.id)}/inference`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: primary.provider,
          primaryModel: primary.model,
          models: cleanRoutes.map((route) => route.model),
          routes: cleanRoutes,
          primaryRouteId: primary.id,
        }),
      })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || "Failed to save sandbox inference config")
      const config = data.config as SandboxInferenceConfig
      setRoutes(config.routes)
      setPrimaryRouteId(config.primaryRouteId)
      setUpdatedAt(config.updatedAt)
      setMsg(`Saved ${config.routes.length} inference route${config.routes.length === 1 ? "" : "s"} for ${sandbox.name}.`)
    } catch (error) {
      setMsg(error instanceof Error ? error.message : "Failed to save sandbox inference config", true)
    } finally {
      setSaving(false)
    }
  }

  async function applyToContainer() {
    try {
      setApplying(true); setMessage("")
      const cleanRoutes = dedupeRoutes(routes)
      if (cleanRoutes.length === 0) throw new Error("Add at least one provider/model route before applying.")
      await save()
      const response = await fetch(`/api/sandbox/${encodeURIComponent(sandbox.id)}/inference/apply`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sandboxName: sandbox.name }),
      })
      const data = await response.json()
      if (!response.ok) throw new Error(data.note ? `${data.error}\n\n${data.note}` : data.error || "Failed to apply routes")
      setMsg(`${data.routesApplied} route${data.routesApplied === 1 ? "" : "s"} applied to ${sandbox.name}. ${data.note}`)
    } catch (error) {
      setMsg(error instanceof Error ? error.message : "Failed to apply routes", true)
    } finally {
      setApplying(false)
    }
  }

  return (
    <div className={embedded ? "" : "space-y-0"}>
      {showHeader && (
        <div className="flex items-center justify-between gap-4 border-b border-border pb-4 mb-5">
          <div>
            <h4 className="text-sm font-semibold uppercase tracking-wider">
              {sandbox.name} — Inference Routes
            </h4>
            <p className="mt-1 text-xs text-muted-foreground">
              Enable multiple endpoint/model routes for this sandbox.
            </p>
          </div>
          <Button onClick={load} disabled={loading || saving} variant="outline" size="sm">Refresh</Button>
        </div>
      )}

      {loading ? (
        <p className="py-8 text-xs uppercase tracking-wider text-muted-foreground">Loading inference routes…</p>
      ) : (
        <div className={`${showHeader ? "" : ""} space-y-5`}>
          {!showHeader && (
            <div className="flex justify-end">
              <Button onClick={load} disabled={loading || saving} variant="outline" size="sm">Refresh</Button>
            </div>
          )}
          <Card className="p-4">
            <div className="flex items-center justify-between gap-4">
              <h5 className="text-xs uppercase tracking-wider font-semibold">Verified Working Routes</h5>
              <span className="text-[10px] uppercase tracking-wider text-primary">{verifiedRoutes.length} Available</span>
            </div>
            {verifiedRoutes.length === 0 ? (
              <p className="mt-3 text-xs text-muted-foreground">No verified routes reported by the main inference config.</p>
            ) : (
              <div className="mt-3 grid grid-cols-1 gap-2 md:grid-cols-2">
                {verifiedRoutes.map((route) => (
                  <button
                    key={`${route.source}-${route.id}`}
                    type="button"
                    onClick={() => addRoute(route.provider, route.model, route.label)}
                    className="rounded-md border border-border bg-background p-3 text-left hover:border-primary transition-colors"
                  >
                    <div className="flex items-center justify-between gap-3">
                      <span className="text-[10px] uppercase tracking-wider text-muted-foreground">{route.scope}</span>
                      <span className="text-[10px] uppercase tracking-wider text-primary">Add</span>
                    </div>
                    <div className="mt-2 text-xs font-mono">{route.provider}</div>
                    <div className="mt-1 break-all text-[11px] font-mono text-muted-foreground">{route.model}</div>
                    {route.label && <div className="mt-2 text-[10px] uppercase tracking-wider text-muted-foreground">{route.label}</div>}
                  </button>
                ))}
              </div>
            )}
          </Card>

          <div className="grid grid-cols-1 lg:grid-cols-[minmax(180px,240px)_minmax(0,1fr)_minmax(160px,220px)_auto] gap-3 items-end">
            <div className="space-y-1.5">
              <label className="text-[10px] uppercase tracking-wider text-muted-foreground">Endpoint</label>
              <select value={draftProvider} onChange={(event) => setDraftProvider(event.target.value)} className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm font-mono text-foreground focus:outline-none focus:ring-1 focus:ring-ring">
                <option value="">Select provider</option>
                {providers.map((item) => item.name ? <option key={item.name} value={item.name}>{item.name}</option> : null)}
              </select>
            </div>
            <div className="space-y-1.5">
              <label className="text-[10px] uppercase tracking-wider text-muted-foreground">Model</label>
              <Input value={draftModel} onChange={(event) => setDraftModel(event.target.value)} placeholder="model id" className="font-mono" />
            </div>
            <div className="space-y-1.5">
              <label className="text-[10px] uppercase tracking-wider text-muted-foreground">Label</label>
              <Input value={draftLabel} onChange={(event) => setDraftLabel(event.target.value)} placeholder="optional" className="font-mono" />
            </div>
            <Button onClick={() => addRoute()} variant="outline" size="sm">Add Route</Button>
          </div>

          {draftProviderIsOllama && (
            <Card className="p-4">
              <div className="flex items-center justify-between gap-4">
                <h5 className="text-xs uppercase tracking-wider font-semibold">Ollama Models</h5>
                <Button type="button" variant="outline" size="sm" onClick={loadOllamaModels} disabled={ollamaLoading}>
                  {ollamaLoading ? "Polling…" : "Poll"}
                </Button>
              </div>
              {ollamaModels.length === 0 ? (
                <p className="mt-3 text-xs text-muted-foreground">No local Ollama models reported.</p>
              ) : (
                <div className="mt-3 grid grid-cols-1 md:grid-cols-2 gap-2">
                  {ollamaModels.map((item) => (
                    <button key={ollamaModelKey(item)} type="button" onClick={() => addRoute(draftProvider, item.name, "Ollama")} className="rounded-md border border-border bg-background p-3 text-left hover:border-primary transition-colors">
                      <div className="flex min-w-0 items-center gap-2 text-xs font-mono"><span className="truncate">{item.name}</span><OllamaHostBadge label={item.hostLabel} /></div>
                      <div className="mt-1 text-[11px] text-muted-foreground">
                        {[item.parameterSize, item.quantization, item.sizeLabel].filter(Boolean).join(" · ") || "local model"}
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </Card>
          )}

          <div className="space-y-2">
            <h5 className="text-xs uppercase tracking-wider font-semibold">Enabled Routes</h5>
            {routes.length === 0 ? (
              <Card className="p-4">
                <p className="text-xs text-muted-foreground">No routes enabled for this sandbox.</p>
              </Card>
            ) : (
              <div className="space-y-2">
                {routes.map((route) => (
                  <div key={route.id} className="grid grid-cols-1 lg:grid-cols-[auto_minmax(160px,220px)_minmax(0,1fr)_minmax(140px,200px)_auto] gap-3 rounded-md border border-border bg-muted/20 p-3 items-center">
                    <label className="flex items-center gap-2 text-xs text-muted-foreground">
                      <input type="radio" checked={primaryRouteId === route.id} onChange={() => setPrimaryRouteId(route.id)} />
                      Default
                    </label>
                    <span className="text-xs font-mono">{route.provider}</span>
                    <input value={route.model} onChange={(event) => updateRoute(route.id, { model: event.target.value })} className={inputCls + " text-xs"} />
                    <input value={route.label} onChange={(event) => updateRoute(route.id, { label: event.target.value })} placeholder="label" className={inputCls + " text-xs"} />
                    <div className="flex items-center justify-end gap-3">
                      <label className="flex items-center gap-2 text-xs text-muted-foreground">
                        <input type="checkbox" checked={route.enabled} onChange={(event) => updateRoute(route.id, { enabled: event.target.checked })} />
                        Enabled
                      </label>
                      <Button type="button" variant="outline" size="sm" onClick={() => removeRoute(route.id)}>Remove</Button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="flex items-center gap-3 flex-wrap">
            <Button onClick={save} disabled={saving} size="sm">
              {saving ? "Saving…" : "Save Sandbox Routes"}
            </Button>
            <Button onClick={applyToContainer} disabled={saving || applying} variant="outline" size="sm">
              {applying ? "Applying…" : "Apply to Running Container"}
            </Button>
            {updatedAt && <span className="text-[11px] text-muted-foreground">Updated {new Date(updatedAt).toLocaleString()}</span>}
          </div>

          {message && (
            <Alert variant={isError ? "destructive" : "default"}>
              <AlertDescription className="text-xs whitespace-pre-wrap">{message}</AlertDescription>
            </Alert>
          )}
        </div>
      )}
    </div>
  )
}
