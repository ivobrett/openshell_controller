"use client"
import { useEffect, useMemo, useState } from "react"
import { Button } from "@/app/components/ui/button"
import { Input } from "@/app/components/ui/input"
import { Alert, AlertDescription } from "@/app/components/ui/alert"
import { Badge as ShadBadge } from "@/app/components/ui/badge"
import { Card } from "@/app/components/ui/card"
import { SECURITY_PRESETS, getSecurityPreset, type OpenShellPolicyShape, type SecurityPresetId } from "../lib/securityPresets"

type LandlockCompatibility = "best_effort" | "hard_requirement"
type EndpointProtocol = "" | "rest"
type EndpointTls = "" | "terminate" | "passthrough"
type EndpointEnforcement = "" | "enforce" | "audit"
type EndpointAccess = "" | "read-only" | "read-write" | "full"
type CreateInferenceMode = "auto" | "vllm" | "nvidia" | "compatible"
type CreateGpuMode = "none" | "auto" | "required"

interface NetworkRule { method: string; path: string }
interface NetworkEndpoint { host: string; port: string; protocol: EndpointProtocol; tls: EndpointTls; enforcement: EndpointEnforcement; access: EndpointAccess; rules: NetworkRule[] }
interface NetworkBinary { path: string }
interface NetworkPolicyBlock { key: string; name: string; endpoints: NetworkEndpoint[]; binaries: NetworkBinary[] }
type OpenShellPolicy = OpenShellPolicyShape

type BaselineStatus = { name: string; available: boolean }

type BlueprintOption = {
  id: string
  label: string
  description: string
  type: "blueprint" | "custom" | "image"
  source: string
  supportsTailscale?: boolean
  baseline?: BaselineStatus
}

interface ConfigurationPanelProps {
  sandboxId: string
  mode?: 'existing' | 'create'
  onCreateSuccess?: (sandboxId: string) => void | Promise<void>
  embedded?: boolean
  showHeader?: boolean
}

function FieldHelp({ text }: { text: string }) {
  return <span className="ml-2 inline-flex align-middle group relative"><span className="w-4 h-4 rounded-full border border-muted-foreground text-[10px] text-muted-foreground flex items-center justify-center cursor-help">?</span><span className="pointer-events-none absolute left-0 top-6 z-50 hidden w-80 rounded-md border border-border bg-popover p-2 text-[11px] text-popover-foreground shadow-lg group-hover:block">{text}</span></span>
}
function PolicyBadge({ children, tone }: { children: React.ReactNode; tone: "dynamic" | "static" | "danger" }) {
  const cls = tone === "dynamic" ? "text-primary border-primary" : tone === "danger" ? "text-destructive border-destructive" : "text-yellow-500 border-yellow-500"
  return <ShadBadge variant="outline" className={`text-[10px] uppercase tracking-wider ${cls}`}>{children}</ShadBadge>
}
function TextListEditor({ label, tooltipText, value, onChange, placeholder }: { label: string; tooltipText: string; value: string[]; onChange: (v: string[]) => void; placeholder: string }) {
  return <div className="space-y-1.5"><label className="text-xs uppercase tracking-wider text-muted-foreground">{label}<FieldHelp text={tooltipText} /></label><textarea value={value.join("\n")} onChange={(e) => onChange(e.target.value.split("\n").map(s => s.trim()).filter(Boolean))} placeholder={placeholder} rows={4} className="w-full rounded-md border border-input bg-background px-3 py-2 text-xs font-mono text-foreground focus:outline-none focus:ring-1 focus:ring-ring" /></div>
}

const defaultPolicy: OpenShellPolicy = {
  version: 1,
  filesystem_policy: { include_workdir: true, read_only: ["/usr", "/lib", "/etc", "/proc", "/dev/urandom"], read_write: ["/sandbox", "/tmp", "/dev/null"] },
  landlock: { compatibility: "best_effort" },
  process: { run_as_user: "sandbox", run_as_group: "sandbox" },
  network_policies: {},
}

function normalizeFromApi(data: any): OpenShellPolicy {
  const current = data?.currentConfig || data?.policy || data || {}
  return {
    version: Number(current.version ?? 1),
    filesystem_policy: {
      include_workdir: Boolean(current.filesystem_policy?.include_workdir ?? true),
      read_only: Array.isArray(current.filesystem_policy?.read_only) ? current.filesystem_policy.read_only : defaultPolicy.filesystem_policy.read_only,
      read_write: Array.isArray(current.filesystem_policy?.read_write) ? current.filesystem_policy.read_write : defaultPolicy.filesystem_policy.read_write,
    },
    landlock: { compatibility: current.landlock?.compatibility === "hard_requirement" ? "hard_requirement" : "best_effort" },
    process: { run_as_user: String(current.process?.run_as_user ?? "sandbox"), run_as_group: String(current.process?.run_as_group ?? "sandbox") },
    network_policies: current.network_policies && typeof current.network_policies === "object" ? current.network_policies : {},
  }
}
function policyBlocksFromPolicy(policy: OpenShellPolicy): NetworkPolicyBlock[] {
  return Object.entries(policy.network_policies).map(([key, value]) => ({ key, name: value.name || key, endpoints: (value.endpoints || []).map((ep) => ({ host: ep.host || "", port: String(ep.port ?? "443"), protocol: ep.protocol === "rest" ? "rest" : "", tls: ep.tls === "terminate" || ep.tls === "passthrough" ? ep.tls : "", enforcement: ep.enforcement === "enforce" || ep.enforcement === "audit" ? ep.enforcement : "", access: ep.access === "read-only" || ep.access === "read-write" || ep.access === "full" ? ep.access : "", rules: Array.isArray(ep.rules) ? ep.rules.map((r) => ({ method: r.allow?.method || "GET", path: r.allow?.path || "/**" })) : [] })), binaries: (value.binaries || []).map((b) => ({ path: b.path || "" })) }))
}
function blocksToPolicy(blocks: NetworkPolicyBlock[]): OpenShellPolicy["network_policies"] {
  const out: OpenShellPolicy["network_policies"] = {}
  for (const block of blocks) {
    const key = block.key.trim(); if (!key) continue
    out[key] = { name: block.name.trim() || key, endpoints: block.endpoints.filter((ep) => ep.host.trim() && ep.port.trim()).map((ep) => ({ host: ep.host.trim(), port: Number(ep.port), ...(ep.protocol ? { protocol: ep.protocol } : {}), ...(ep.tls ? { tls: ep.tls } : {}), ...(ep.enforcement ? { enforcement: ep.enforcement } : {}), ...(ep.access ? { access: ep.access } : {}), ...(!ep.access && ep.rules.length ? { rules: ep.rules.filter((r) => r.method.trim() && r.path.trim()).map((r) => ({ allow: { method: r.method.trim(), path: r.path.trim() } })) } : {}) })), binaries: block.binaries.filter((b) => b.path.trim()).map((b) => ({ path: b.path.trim() })) }
  }
  return out
}

const selectCls = "w-full rounded-md border border-input bg-background px-3 py-2 text-xs font-mono text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
const inputCls = "w-full rounded-md border border-input bg-background px-3 py-2 text-xs font-mono text-foreground focus:outline-none focus:ring-1 focus:ring-ring"

export default function ConfigurationPanel({ sandboxId, mode = 'existing', onCreateSuccess, embedded = false, showHeader = true }: ConfigurationPanelProps) {
  const [policy, setPolicy] = useState<OpenShellPolicy>(defaultPolicy)
  const [blocks, setBlocks] = useState<NetworkPolicyBlock[]>([])
  const [loading, setLoading] = useState(mode === 'existing')
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState("")
  const [isError, setIsError] = useState(false)
  const [selectedPreset, setSelectedPreset] = useState<SecurityPresetId | ''>('')
  const [blueprints, setBlueprints] = useState<BlueprintOption[]>([])
  const [selectedBlueprint, setSelectedBlueprint] = useState<string>('redeploy-image')
  const [sandboxName, setSandboxName] = useState<string>('')
  const [enableTailscale, setEnableTailscale] = useState<boolean>(false)
  const [createGpuMode, setCreateGpuMode] = useState<CreateGpuMode>("none")
  const [quickDeployAgent, setQuickDeployAgent] = useState<'openclaw' | 'hermes' | 'custom'>('openclaw')
  const [useBaseline, setUseBaseline] = useState<boolean>(true)
  const [createInferenceMode, setCreateInferenceMode] = useState<CreateInferenceMode>("auto")
  const [createInferenceModel, setCreateInferenceModel] = useState<string>("")
  const [createInferenceEndpointUrl, setCreateInferenceEndpointUrl] = useState<string>("")
  const [createNvidiaApiKey, setCreateNvidiaApiKey] = useState<string>("")
  const [restoreFromBackup, setRestoreFromBackup] = useState<boolean>(false)
  const [restoreArchive, setRestoreArchive] = useState<File | null>(null)
  const [restorePath, setRestorePath] = useState<string>('/sandbox')
  const [restoreReplace, setRestoreReplace] = useState<boolean>(true)

  useEffect(() => {
    if (mode === 'create') {
      setLoading(false)
      fetch('/api/sandbox/create', { cache: 'no-store' }).then((res) => res.json()).then((data) => { if (Array.isArray(data?.blueprints)) setBlueprints(data.blueprints) }).catch(() => {})
      return
    }
    let active = true
    ;(async () => {
      try {
        setLoading(true)
        const res = await fetch(`/api/sandbox/${encodeURIComponent(sandboxId)}/config`, { cache: "no-store" })
        const data = await res.json()
        if (!res.ok) throw new Error(data.error || "Failed to fetch configuration")
        const normalized = normalizeFromApi(data)
        if (!active) return
        setPolicy(normalized)
        setBlocks(policyBlocksFromPolicy(normalized))
      } catch (err) {
        if (!active) return
        setMessage(err instanceof Error ? err.message : "Failed to fetch configuration")
        setIsError(true)
      } finally {
        if (active) setLoading(false)
      }
    })()
    return () => { active = false }
  }, [sandboxId, mode])

  const assembledPolicy = useMemo(() => ({ ...policy, network_policies: blocksToPolicy(blocks) }), [policy, blocks])
  const activePreset = selectedPreset ? getSecurityPreset(selectedPreset) : null
  const activeBlueprint = blueprints.find((bp) => bp.id === selectedBlueprint)
  const isNemoClawOnboardBlueprint = selectedBlueprint === 'nemoclaw-blueprint' || selectedBlueprint === 'nemoclaw-hermes' || selectedBlueprint === 'nemoclaw-deepagents-code'
  const freshBlueprintAgent: 'openclaw' | 'hermes' = selectedBlueprint === 'nemoclaw-hermes' ? 'hermes' : 'openclaw'
  const freshBaseline = isNemoClawOnboardBlueprint ? activeBlueprint?.baseline : undefined
  const canUseBaseline = Boolean(freshBaseline?.available)

  function applyPreset(presetId: SecurityPresetId) {
    const preset = getSecurityPreset(presetId); if (!preset) return
    setSelectedPreset(presetId); setPolicy(preset.policy); setBlocks(policyBlocksFromPolicy(preset.policy))
    setMessage(`${preset.label} applied. Review before saving.`); setIsError(false)
  }

  async function savePolicy() {
    try {
      setSaving(true); setMessage(""); setIsError(false)
      if (mode === 'create') {
        if (!sandboxName.trim()) throw new Error('sandbox name is required')
        if (restoreFromBackup && !restoreArchive) throw new Error('backup archive is required when restore from backup is enabled')
        const createInference = {
          mode: createInferenceMode,
          model: createInferenceModel.trim(),
          endpointUrl: createInferenceEndpointUrl.trim(),
          apiKey: (createInferenceMode === 'nvidia' || createInferenceMode === 'compatible') ? createNvidiaApiKey.trim() : '',
        }
        const baselineActive = isNemoClawOnboardBlueprint && canUseBaseline && useBaseline
        const effectiveBlueprint = baselineActive ? 'redeploy-image' : selectedBlueprint
        const effectiveAgent =
          effectiveBlueprint === 'redeploy-image'
            ? (baselineActive ? freshBlueprintAgent : quickDeployAgent)
            : undefined
        const sourceSandboxName = baselineActive ? freshBaseline?.name : undefined
        const res = await fetch('/api/sandbox/create', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ blueprint: effectiveBlueprint, sandboxName: sandboxName.trim(), enableTailscale, gpuMode: createGpuMode, createInference, policy: assembledPolicy, preset: selectedPreset || null, agent: effectiveAgent, sourceSandboxName }) })
        const data = await res.json()
        if (!res.ok) throw new Error([data.error, data.verification?.summary, data.verification?.error, data.stdout, data.stderr].filter(Boolean).join('\n\n'))
        const createdSandboxId = data.verification?.details?.id || data.verification?.details?.name || data.sandboxName
        let restoreNote = ''
        if (restoreFromBackup && restoreArchive && createdSandboxId) {
          setMessage(`Sandbox '${data.sandboxName}' created. Restoring backup archive…`)
          const form = new FormData()
          form.set('archive', restoreArchive)
          form.set('targetPath', restorePath.trim() || '/sandbox')
          form.set('replace', restoreReplace ? 'true' : 'false')
          const restoreRes = await fetch(`/api/sandbox/${encodeURIComponent(createdSandboxId)}/restore`, {
            method: 'POST',
            body: form,
          })
          const restoreData = await restoreRes.json()
          if (!restoreRes.ok) throw new Error([`Sandbox '${data.sandboxName}' was created, but backup restore failed.`, restoreData.error].filter(Boolean).join('\n\n'))
          restoreNote = restoreData.note || `Restored ${restoreArchive.name} into ${restorePath.trim() || '/sandbox'}.`
        }
        setMessage([
          `Sandbox '${data.sandboxName}' created.`,
          restoreNote,
          data.verification?.summary,
          data.note,
        ].filter(Boolean).join('\n\n'))
        if (createdSandboxId && onCreateSuccess) {
          await onCreateSuccess(createdSandboxId)
        }
        return
      }
      const res = await fetch(`/api/sandbox/${encodeURIComponent(sandboxId)}/config`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ policy: assembledPolicy, preset: selectedPreset || null, mode }) })
      const data = await res.json(); if (!res.ok) throw new Error(data.error || "Failed to save policy")
      setMessage('Policy saved. Dynamic network policy can apply live; static sections require sandbox recreation.')
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Failed to save policy"); setIsError(true)
    } finally { setSaving(false) }
  }

  function updateBlock(idx: number, next: NetworkPolicyBlock) { setBlocks((prev) => prev.map((b, i) => (i === idx ? next : b))) }
  function addBlock() { setBlocks((prev) => [...prev, { key: `policy_${prev.length + 1}`, name: `policy-${prev.length + 1}`, endpoints: [{ host: "", port: "443", protocol: "", tls: "", enforcement: "", access: "read-only", rules: [] }], binaries: [{ path: "" }] }]) }

  const radioCard = (active: boolean) =>
    `flex items-start gap-3 rounded-md border p-3 text-sm cursor-pointer ${active ? "border-primary bg-primary/5" : "border-border bg-muted/30"}`

  return (
    <div className={embedded ? "" : "space-y-0 mt-6"}>
      {showHeader && (
        <div className="flex items-center justify-between mb-6 pb-4 border-b border-border">
          <h4 className="text-sm font-semibold uppercase tracking-wider">
            {mode === 'create' ? 'New Sandbox' : `${sandboxId} — OpenShell Policy`}
          </h4>
          <Button onClick={savePolicy} disabled={saving} size="sm">
            {saving ? "Working…" : mode === 'create' ? 'Create Sandbox' : 'Save Policy'}
          </Button>
        </div>
      )}
      {loading ? <p className="text-sm text-muted-foreground">Loading policy…</p> : <div className="space-y-8">
        {mode === 'create' && (
          <section className="space-y-4 rounded-md border border-border bg-muted/20 p-4">
            <div>
              <h5 className="text-xs uppercase tracking-wider font-semibold">Create Sandbox</h5>
              <p className="text-xs text-muted-foreground mt-1">Choose a template and enter a sandbox name.</p>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {blueprints.map((bp) => (
                <button key={bp.id} type="button" onClick={() => setSelectedBlueprint(bp.id)} className={`rounded-md border p-4 text-left ${selectedBlueprint === bp.id ? "border-primary bg-primary/5" : "border-border bg-background"}`}>
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-sm font-semibold uppercase tracking-wider">{bp.label}</span>
                    <PolicyBadge tone={bp.type === 'blueprint' ? 'dynamic' : 'static'}>{bp.type}</PolicyBadge>
                  </div>
                  <p className="text-xs text-muted-foreground mt-2">{bp.description}</p>
                </button>
              ))}
            </div>
            <div>
              <label className="text-xs uppercase tracking-wider text-muted-foreground">Sandbox Name<FieldHelp text="Lowercase letters, numbers, and hyphens only." /></label>
              <input value={sandboxName} onChange={(e) => setSandboxName(e.target.value)} placeholder={selectedBlueprint === 'nemoclaw-hermes' ? 'my-hermes' : selectedBlueprint === 'nemoclaw-deepagents-code' ? 'my-deepagents-code' : selectedBlueprint === 'nemoclaw-blueprint' ? 'my-assistant' : selectedBlueprint === 'redeploy-image' ? 'my-assistant-copy' : 'custom-sandbox'} className={`mt-2 ${inputCls}`} />
            </div>
            <Card className="p-4 space-y-4">
              <div>
                <h6 className="text-xs font-semibold uppercase tracking-wider">GPU Passthrough</h6>
                <p className="mt-1 text-xs text-muted-foreground">Choose whether new sandboxes should request NVIDIA GPU devices.</p>
              </div>
              <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
                <label className={radioCard(createGpuMode === 'none')}>
                  <input type="radio" name="create-gpu-mode" checked={createGpuMode === 'none'} onChange={() => setCreateGpuMode('none')} className="mt-0.5 h-4 w-4" />
                  <span><span className="block text-xs font-mono uppercase tracking-wider">No GPU</span><span className="mt-1 block text-[11px] text-muted-foreground">Passes --no-gpu to NemoClaw and avoids CDI setup.</span></span>
                </label>
                <label className={radioCard(createGpuMode === 'auto')}>
                  <input type="radio" name="create-gpu-mode" checked={createGpuMode === 'auto'} onChange={() => setCreateGpuMode('auto')} className="mt-0.5 h-4 w-4" />
                  <span><span className="block text-xs font-mono uppercase tracking-wider">Auto</span><span className="mt-1 block text-[11px] text-muted-foreground">Let NemoClaw/OpenShell infer GPU intent.</span></span>
                </label>
                <label className={radioCard(createGpuMode === 'required')}>
                  <input type="radio" name="create-gpu-mode" checked={createGpuMode === 'required'} onChange={() => setCreateGpuMode('required')} className="mt-0.5 h-4 w-4" />
                  <span><span className="block text-xs font-mono uppercase tracking-wider">Require GPU</span><span className="mt-1 block text-[11px] text-muted-foreground">Requires NVIDIA CDI devices or gateway GPU support.</span></span>
                </label>
              </div>
            </Card>
            {isNemoClawOnboardBlueprint && freshBaseline && (
              <Card className="p-4 space-y-3">
                <label className="flex items-start gap-3">
                  <input
                    type="checkbox"
                    checked={canUseBaseline && useBaseline}
                    onChange={(e) => setUseBaseline(e.target.checked)}
                    disabled={!canUseBaseline}
                    className="mt-0.5 h-4 w-4"
                  />
                  <span className="flex-1">
                    <span className="block text-xs font-semibold uppercase tracking-wider">
                      Use prebuilt baseline {canUseBaseline ? '(fast — ~30s)' : '(not available on this host)'}
                    </span>
                    <span className="mt-1 block text-[11px] text-muted-foreground font-mono">{freshBaseline.name}</span>
                    <span className="mt-1 block text-[11px] text-muted-foreground">
                      {canUseBaseline
                        ? `Skips the 12-15 min Docker rebuild by cloning the prebuilt ${freshBlueprintAgent}-baseline sandbox. Uncheck to rebuild the image layers from source.`
                        : `No prebuilt ${freshBlueprintAgent}-baseline sandbox is running on this host. The manidae-cloud install scripts pre-create one — without it, a full rebuild will run.`}
                    </span>
                  </span>
                </label>
              </Card>
            )}
            {selectedBlueprint === 'redeploy-image' && (
              <Card className="p-4 space-y-4">
                <p className="text-xs text-muted-foreground">Quick Deploy clones the running image of an existing sandbox and skips the Docker rebuild. Use Fresh NemoClaw Image when you need to rebuild the image layers.</p>
                <div>
                  <h6 className="text-xs font-semibold uppercase tracking-wider">Agent</h6>
                  <p className="mt-1 text-xs text-muted-foreground">Pick which kind of running sandbox to clone from. The newest matching one is used as the source.</p>
                </div>
                <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
                  <label className={radioCard(quickDeployAgent === 'openclaw')}>
                    <input type="radio" name="quick-deploy-agent" checked={quickDeployAgent === 'openclaw'} onChange={() => setQuickDeployAgent('openclaw')} className="mt-0.5 h-4 w-4" />
                    <span><span className="block text-xs font-mono uppercase tracking-wider">OpenClaw</span><span className="mt-1 block text-[11px] text-muted-foreground">Clone the most recent OpenClaw sandbox.</span></span>
                  </label>
                  <label className={radioCard(quickDeployAgent === 'hermes')}>
                    <input type="radio" name="quick-deploy-agent" checked={quickDeployAgent === 'hermes'} onChange={() => setQuickDeployAgent('hermes')} className="mt-0.5 h-4 w-4" />
                    <span><span className="block text-xs font-mono uppercase tracking-wider">Hermes</span><span className="mt-1 block text-[11px] text-muted-foreground">Clone the most recent Hermes sandbox.</span></span>
                  </label>
                  <label className={radioCard(quickDeployAgent === 'custom')}>
                    <input type="radio" name="quick-deploy-agent" checked={quickDeployAgent === 'custom'} onChange={() => setQuickDeployAgent('custom')} className="mt-0.5 h-4 w-4" />
                    <span><span className="block text-xs font-mono uppercase tracking-wider">Custom</span><span className="mt-1 block text-[11px] text-muted-foreground">Clone the most recent Custom sandbox. Bare image, no NemoClaw runtime.</span></span>
                  </label>
                </div>
              </Card>
            )}
            {activeBlueprint?.supportsTailscale && (
              <label className="flex items-center gap-3 text-sm font-mono">
                <input type="checkbox" checked={enableTailscale} onChange={(e) => setEnableTailscale(e.target.checked)} /> Enable Tailscale
              </label>
            )}
            {enableTailscale && (
              <Alert>
                <AlertDescription className="text-sm">Tailscale-enabled creation requires NVIDIA_INFERENCE_API_KEY (or legacy NVIDIA_API_KEY) in the dashboard process environment.</AlertDescription>
              </Alert>
            )}
            {isNemoClawOnboardBlueprint && <Card className="p-4 space-y-4">
              <div>
                <h6 className="text-xs font-semibold uppercase tracking-wider">Inference at Create</h6>
                <p className="mt-1 text-xs text-muted-foreground">Choose the provider NemoClaw should use while onboarding this sandbox.</p>
              </div>
              <div className="grid grid-cols-1 gap-3 md:grid-cols-4">
                {(["auto", "vllm", "nvidia", "compatible"] as CreateInferenceMode[]).map((mode) => (
                  <label key={mode} className={radioCard(createInferenceMode === mode)}>
                    <input type="checkbox" checked={createInferenceMode === mode} onChange={() => setCreateInferenceMode(mode)} className="mt-0.5 h-4 w-4" />
                    <span>
                      <span className="block text-xs font-mono uppercase tracking-wider">{mode === 'auto' ? 'Auto' : mode === 'vllm' ? 'Use vLLM in experimental mode' : mode === 'nvidia' ? 'NVIDIA hosted API' : 'OpenAI-compatible endpoint'}</span>
                      <span className="mt-1 block text-[11px] text-muted-foreground">{mode === 'auto' ? 'Let NemoClaw choose.' : mode === 'vllm' ? 'Sets NEMOCLAW_EXPERIMENTAL and vLLM.' : mode === 'nvidia' ? 'Uses NemoClaw build provider and requires an nvapi-* key.' : 'Sets NEMOCLAW_PROVIDER=custom, endpoint URL, and compatible API key.'}</span>
                    </span>
                  </label>
                ))}
              </div>
              {createInferenceMode !== 'auto' && (
                <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                  <div className="space-y-1.5">
                    <label className="text-[10px] uppercase tracking-wider text-muted-foreground">Model</label>
                    <input value={createInferenceModel} onChange={(e) => setCreateInferenceModel(e.target.value)} placeholder={createInferenceMode === 'vllm' ? 'auto-detect from vLLM' : 'model name'} className={inputCls} />
                  </div>
                  {createInferenceMode === 'compatible' && (
                    <div className="space-y-1.5">
                      <label className="text-[10px] uppercase tracking-wider text-muted-foreground">Endpoint URL</label>
                      <input value={createInferenceEndpointUrl} onChange={(e) => setCreateInferenceEndpointUrl(e.target.value)} placeholder="https://integrate.api.nvidia.com/v1" className={inputCls} />
                    </div>
                  )}
                  {(createInferenceMode === 'nvidia' || createInferenceMode === 'compatible') && (
                    <div className="space-y-1.5">
                      <label className="text-[10px] uppercase tracking-wider text-muted-foreground">Provider API Key</label>
                      <input type="password" value={createNvidiaApiKey} onChange={(e) => setCreateNvidiaApiKey(e.target.value)} placeholder={createInferenceMode === 'nvidia' ? 'nvapi-...' : 'endpoint token or blank for no auth'} className={inputCls} />
                    </div>
                  )}
                </div>
              )}
            </Card>}
            <Card className="p-4 space-y-4">
              <label className="flex items-start gap-3">
                <input type="checkbox" checked={restoreFromBackup} onChange={(e) => setRestoreFromBackup(e.target.checked)} className="mt-0.5 h-4 w-4" />
                <span><span className="block text-xs font-semibold uppercase tracking-wider">Restore from Backup</span><span className="mt-1 block text-xs text-muted-foreground">After the sandbox reaches Ready, restore a .tar.gz archive into it.</span></span>
              </label>
              {restoreFromBackup && <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                <div className="space-y-1.5"><label className="text-[10px] uppercase tracking-wider text-muted-foreground">Backup Archive</label><input type="file" accept=".tar.gz,.tgz,application/gzip,application/x-gzip" onChange={(e) => setRestoreArchive(e.target.files?.[0] || null)} className="block w-full text-xs text-muted-foreground file:mr-3 file:rounded-md file:border file:border-border file:bg-muted file:px-3 file:py-1.5 file:text-xs file:font-mono file:uppercase file:text-foreground" /></div>
                <div className="space-y-1.5"><label className="text-[10px] uppercase tracking-wider text-muted-foreground">Restore Target</label><input value={restorePath} onChange={(e) => setRestorePath(e.target.value)} placeholder="/sandbox" className={inputCls} /></div>
                <label className="md:col-span-2 flex items-start gap-3 rounded-md border border-border bg-muted/30 p-3"><input type="checkbox" checked={restoreReplace} onChange={(e) => setRestoreReplace(e.target.checked)} className="mt-0.5 h-4 w-4" /><span><span className="block text-xs font-mono uppercase tracking-wider">Replace target contents</span><span className="mt-1 block text-[11px] text-muted-foreground">Recommended for cloning from a backup into a fresh sandbox.</span></span></label>
              </div>}
            </Card>
          </section>
        )}
        <section className="space-y-4">
          <div className="flex items-center justify-between gap-4 flex-wrap">
            <div>
              <h5 className="text-xs uppercase tracking-wider font-semibold">Security Presets</h5>
              <p className="text-xs text-muted-foreground mt-1">Use a canned profile for new sandboxes or switch an existing sandbox policy baseline on the fly.</p>
            </div>
            <div className="min-w-[260px]">
              <select value={selectedPreset} onChange={(e) => { const value = e.target.value as SecurityPresetId | ''; setSelectedPreset(value); if (value) applyPreset(value) }} className={selectCls}>
                <option value="">Select preset…</option>
                {SECURITY_PRESETS.map((preset) => <option key={preset.id} value={preset.id}>{preset.label}</option>)}
              </select>
            </div>
          </div>
          {activePreset && (
            <Card className="p-4 space-y-3">
              <div className="flex items-center gap-3 flex-wrap">
                <span className="text-sm font-semibold uppercase tracking-wider">{activePreset.label}</span>
              </div>
              <p className="text-sm text-muted-foreground">{activePreset.summary}</p>
            </Card>
          )}
        </section>
        <section className="space-y-4">
          <div className="flex items-center gap-3">
            <h5 className="text-xs uppercase tracking-wider font-semibold">Filesystem Policy</h5>
            <PolicyBadge tone="static">Static</PolicyBadge>
          </div>
          <label className="flex items-center gap-3 text-sm font-mono">
            <input type="checkbox" checked={policy.filesystem_policy.include_workdir} onChange={(e) => setPolicy({ ...policy, filesystem_policy: { ...policy.filesystem_policy, include_workdir: e.target.checked } })} />
            Include workdir<FieldHelp text="Automatically adds the agent working directory to read_write. Static: changing this requires recreating the sandbox." />
          </label>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <TextListEditor label="Read-only paths" tooltipText="Absolute paths the sandbox can read but not modify. Paths not listed are inaccessible." value={policy.filesystem_policy.read_only} onChange={(v) => setPolicy({ ...policy, filesystem_policy: { ...policy.filesystem_policy, read_only: v } })} placeholder="/usr\n/lib\n/etc" />
            <TextListEditor label="Read-write paths" tooltipText="Absolute paths the sandbox can read and write. Keep this scoped; broad paths are rejected." value={policy.filesystem_policy.read_write} onChange={(v) => setPolicy({ ...policy, filesystem_policy: { ...policy.filesystem_policy, read_write: v } })} placeholder="/sandbox\n/tmp" />
          </div>
        </section>
        <section className="space-y-4">
          <div className="flex items-center gap-3">
            <h5 className="text-xs uppercase tracking-wider font-semibold">Network Policies</h5>
            <PolicyBadge tone="dynamic">Dynamic</PolicyBadge>
          </div>
          <Button type="button" variant="outline" size="sm" onClick={addBlock}>Add policy block</Button>
        </section>
        {mode === 'existing' && (
          <section className="space-y-3">
            <h5 className="text-xs uppercase tracking-wider font-semibold">Policy JSON</h5>
            <pre className="overflow-auto rounded-md border border-border bg-muted p-4 text-[11px] leading-5">{JSON.stringify(assembledPolicy, null, 2)}</pre>
          </section>
        )}
        <Button onClick={savePolicy} disabled={saving} size="sm">
          {saving ? "Working…" : mode === 'create' ? 'Create Sandbox' : 'Save Policy'}
        </Button>
        {message && (
          <Alert variant={isError ? "destructive" : "default"}>
            <AlertDescription className="text-sm whitespace-pre-wrap">{message}</AlertDescription>
          </Alert>
        )}
      </div>}
    </div>
  )
}
