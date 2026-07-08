"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import { Button } from "@/app/components/ui/button"
import { Alert, AlertDescription } from "@/app/components/ui/alert"
import { Card } from "@/app/components/ui/card"

type InferenceRoute = {
  configured: boolean
  provider: string | null
  model: string | null
  version: string | null
  timeout: string | null
}

type ProviderSummary = {
  id: string | null
  name: string | null
  type: string | null
  credentialKeys: string[]
  configKeys: string[]
}

type InferenceResponse = {
  gateway: InferenceRoute
  system: InferenceRoute
  providers: ProviderSummary[]
}

type OllamaModel = {
  id?: string
  name: string
  model: string
  baseUrl?: string | null
  modifiedAt: string | null
  sizeLabel: string | null
  family: string | null
  parameterSize: string | null
  quantization: string | null
  hostLabel?: string | null
  hostKind?: string | null
}

const providerTypeOptions = [
  { value: "openai", label: "OpenAI compatible" },
  { value: "vllm", label: "vLLM" },
  { value: "anthropic", label: "Anthropic" },
  { value: "generic", label: "Generic" },
]

const OLLAMA_PROVIDER_NAME = "ollama-local"
const OLLAMA_BASE_URL = "http://127.0.0.1:11434/v1"
const DEFAULT_VLLM_CONTAINER = "vllm-bigboy"
const DEFAULT_VLLM_IMAGE = "nvcr.io/nvidia/vllm:26.03.post1-py3"
const DEFAULT_VLLM_MODEL = "vllm-local"
const DEFAULT_VLLM_MAX_MODEL_LEN = "32768"
const DEFAULT_VLLM_YARN_FACTOR = "1.0"
const DEFAULT_VLLM_ORIGINAL_CONTEXT = "32768"

const inputCls = "w-full rounded-md border border-input bg-background px-3 py-2 text-xs font-mono text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
const inputClsSm = "w-full rounded-md border border-input bg-muted/30 px-3 py-2 text-sm font-mono text-foreground focus:outline-none focus:ring-1 focus:ring-ring"

function isVllmEndpoint(name: string, baseUrl: string) {
  return [name, baseUrl].some((value) => /vllm/i.test(value))
}

function shellQuote(value: string) {
  const trimmed = value.trim()
  if (!trimmed) return "''"
  return /^[A-Za-z0-9_./:@%+=,-]+$/.test(trimmed) ? trimmed : `'${trimmed.replace(/'/g, "'\\''")}'`
}

function commandLine(parts: string[]) {
  return parts.filter(Boolean).join(" \\\n  ")
}

function emptyRoute(): InferenceRoute {
  return { configured: false, provider: null, model: null, version: null, timeout: null }
}

function FieldLabel({ children }: { children: React.ReactNode }) {
  return <label className="text-[10px] uppercase tracking-wider text-muted-foreground">{children}</label>
}

function OllamaHostBadge({ label }: { label?: string | null }) {
  if (!label) return null
  return <span className="shrink-0 rounded-sm border border-border bg-muted px-1.5 py-0.5 text-[9px] font-mono uppercase tracking-wider text-muted-foreground">[{label}]</span>
}

function ollamaModelKey(item: OllamaModel) {
  return item.id || `${item.hostLabel || "LOCAL"}:${item.name}`
}

function ollamaSourceSummary(models: OllamaModel[]) {
  return Array.from(new Set(models.map((item) => item.hostLabel).filter(Boolean))).join(" + ")
}

function ollamaProbeSummary(labels: unknown) {
  return Array.isArray(labels) ? labels.filter((item): item is string => typeof item === "string" && Boolean(item)).join(" + ") : ""
}

function ollamaOpenAiBaseUrl(item: OllamaModel) {
  const baseUrl = typeof item.baseUrl === "string" ? item.baseUrl.trim().replace(/\/+$/, "") : ""
  return baseUrl ? `${baseUrl}/v1` : OLLAMA_BASE_URL
}

function ollamaProviderName(item: OllamaModel) {
  return item.hostKind === "win" ? "ollama-win" : OLLAMA_PROVIDER_NAME
}

function VllmAdvancedConfiguration({
  model,
  port,
}: {
  model: string
  port: string
}) {
  const [containerName, setContainerName] = useState(DEFAULT_VLLM_CONTAINER)
  const [image, setImage] = useState(DEFAULT_VLLM_IMAGE)
  const [gpuDevice, setGpuDevice] = useState("0")
  const [hostPort, setHostPort] = useState("8000")
  const [containerPort, setContainerPort] = useState("8000")
  const [tensorParallelSize, setTensorParallelSize] = useState("1")
  const [maxModelLen, setMaxModelLen] = useState(DEFAULT_VLLM_MAX_MODEL_LEN)
  const [gpuMemoryUtilization, setGpuMemoryUtilization] = useState("0.85")
  const [dtype, setDtype] = useState("bfloat16")
  const [kvCacheDtype, setKvCacheDtype] = useState("fp8")
  const [maxNumBatchedTokens, setMaxNumBatchedTokens] = useState("8192")
  const [maxNumSeqs, setMaxNumSeqs] = useState("")
  const [toolCallParser, setToolCallParser] = useState("hermes")
  const [allowLongMaxModelLen, setAllowLongMaxModelLen] = useState(false)
  const [enableYarnScaling, setEnableYarnScaling] = useState(false)
  const [yarnFactor, setYarnFactor] = useState(DEFAULT_VLLM_YARN_FACTOR)
  const [originalContext, setOriginalContext] = useState(DEFAULT_VLLM_ORIGINAL_CONTEXT)
  const [enableChunkedPrefill, setEnableChunkedPrefill] = useState(true)
  const [enableAutoToolChoice, setEnableAutoToolChoice] = useState(true)
  const [calculateKvScales, setCalculateKvScales] = useState(false)
  const [copied, setCopied] = useState(false)
  const [applying, setApplying] = useState(false)
  const [restarting, setRestarting] = useState(false)
  const [restartMessage, setRestartMessage] = useState("")
  const [restartIsError, setRestartIsError] = useState(false)

  useEffect(() => {
    if (port && hostPort === "8000") setHostPort(port)
    if (port && containerPort === "8000") setContainerPort(port)
  }, [containerPort, hostPort, port])

  const maxInputWithDefaultOutput = useMemo(() => {
    const parsed = Number.parseInt(maxModelLen, 10)
    return Number.isFinite(parsed) ? Math.max(0, parsed - 4096) : 0
  }, [maxModelLen])

  const hfOverridesJson = useMemo(() => {
    const factor = Number.parseFloat(yarnFactor)
    const originalMaxPositionEmbeddings = Number.parseInt(originalContext, 10)
    const maxPositionEmbeddings = Number.parseInt(maxModelLen, 10)
    return JSON.stringify({
      max_position_embeddings: Number.isFinite(maxPositionEmbeddings) && maxPositionEmbeddings > 0
        ? maxPositionEmbeddings
        : Number.parseInt(DEFAULT_VLLM_MAX_MODEL_LEN, 10),
      rope_scaling: {
        type: "yarn",
        factor: Number.isFinite(factor) && factor > 0 ? factor : Number.parseFloat(DEFAULT_VLLM_YARN_FACTOR),
        original_max_position_embeddings: Number.isFinite(originalMaxPositionEmbeddings) && originalMaxPositionEmbeddings > 0
          ? originalMaxPositionEmbeddings
          : Number.parseInt(DEFAULT_VLLM_ORIGINAL_CONTEXT, 10),
      },
    })
  }, [maxModelLen, originalContext, yarnFactor])

  const runCommand = useMemo(() => {
    const dockerArgs = [
      "docker run -d",
      `--name ${shellQuote(containerName || DEFAULT_VLLM_CONTAINER)}`,
      "--runtime nvidia",
      `--gpus ${shellQuote(`"device=${gpuDevice || "0"}"`)}`,
      "--ipc=host",
      "--shm-size=64g",
      "--ulimit memlock=-1",
      "--ulimit stack=67108864",
      `-e CUDA_VISIBLE_DEVICES=${shellQuote(gpuDevice || "0")}`,
      "-e PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True",
      allowLongMaxModelLen ? "-e VLLM_ALLOW_LONG_MAX_MODEL_LEN=1" : "",
      `-v "$HOME/.cache/huggingface:/root/.cache/huggingface"`,
      `-p ${shellQuote(hostPort || "8000")}:${shellQuote(containerPort || "8000")}`,
      "--restart unless-stopped",
      shellQuote(image || DEFAULT_VLLM_IMAGE),
      "python3 -m vllm.entrypoints.openai.api_server",
      `--model ${shellQuote(model || DEFAULT_VLLM_MODEL)}`,
      "--host 0.0.0.0",
      `--port ${shellQuote(containerPort || "8000")}`,
      `--tensor-parallel-size ${shellQuote(tensorParallelSize || "1")}`,
      enableYarnScaling ? `--hf-overrides ${shellQuote(hfOverridesJson)}` : "",
      `--max-model-len ${shellQuote(maxModelLen || DEFAULT_VLLM_MAX_MODEL_LEN)}`,
      `--gpu-memory-utilization ${shellQuote(gpuMemoryUtilization || "0.85")}`,
      `--dtype ${shellQuote(dtype || "bfloat16")}`,
      kvCacheDtype && kvCacheDtype !== "auto" ? `--kv-cache-dtype ${shellQuote(kvCacheDtype)}` : "",
      maxNumBatchedTokens ? `--max-num-batched-tokens ${shellQuote(maxNumBatchedTokens)}` : "",
      maxNumSeqs ? `--max-num-seqs ${shellQuote(maxNumSeqs)}` : "",
      enableChunkedPrefill ? "--enable-chunked-prefill" : "",
      enableAutoToolChoice ? "--enable-auto-tool-choice" : "",
      enableAutoToolChoice && toolCallParser ? `--tool-call-parser ${shellQuote(toolCallParser)}` : "",
      calculateKvScales && kvCacheDtype.startsWith("fp8") ? "--calculate-kv-scales" : "",
    ]
    return commandLine(dockerArgs)
  }, [
    allowLongMaxModelLen,
    calculateKvScales,
    containerName,
    containerPort,
    dtype,
    enableAutoToolChoice,
    enableChunkedPrefill,
    enableYarnScaling,
    gpuDevice,
    gpuMemoryUtilization,
    hfOverridesJson,
    hostPort,
    image,
    kvCacheDtype,
    maxModelLen,
    maxNumBatchedTokens,
    maxNumSeqs,
    model,
    tensorParallelSize,
    toolCallParser,
  ])

  async function copyRunCommand() {
    try {
      await navigator.clipboard.writeText(runCommand)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1600)
    } catch {
      setCopied(false)
    }
  }

  function setRMsg(text: string, error = false) { setRestartIsError(error); setRestartMessage(text) }

  async function applyVllmContainer() {
    const target = containerName.trim() || DEFAULT_VLLM_CONTAINER
    if (!window.confirm(`Recreate vLLM container '${target}' with this configuration?`)) return
    try {
      setApplying(true); setRMsg("")
      const response = await fetch("/api/inference/vllm/apply", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          containerName: target, image, gpuDevice, hostPort, containerPort,
          model: model || DEFAULT_VLLM_MODEL, tensorParallelSize, maxModelLen,
          gpuMemoryUtilization, dtype, kvCacheDtype, maxNumBatchedTokens, maxNumSeqs,
          toolCallParser, allowLongMaxModelLen, enableYarnScaling, yarnFactor,
          originalContext, enableChunkedPrefill, enableAutoToolChoice, calculateKvScales,
        }),
      })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || "Failed to apply vLLM configuration")
      setRMsg(`Recreated ${data.container || target}. Wait for the model to finish loading before sending requests.`)
    } catch (error) {
      setRMsg(error instanceof Error ? error.message : "Failed to apply vLLM configuration", true)
    } finally {
      setApplying(false)
    }
  }

  async function restartVllmContainer() {
    const target = containerName.trim() || DEFAULT_VLLM_CONTAINER
    if (!window.confirm(`Restart vLLM container '${target}'?`)) return
    try {
      setRestarting(true); setRMsg("")
      const response = await fetch("/api/inference/vllm/restart", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ containerName: target }),
      })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || "Failed to restart vLLM container")
      setRMsg(`Restarted ${data.container || target}. Wait for the model to finish loading before sending requests.`)
    } catch (error) {
      setRMsg(error instanceof Error ? error.message : "Failed to restart vLLM container", true)
    } finally {
      setRestarting(false)
    }
  }

  const selectCls = "w-full rounded-md border border-input bg-background px-3 py-2 text-xs font-mono text-foreground focus:outline-none focus:ring-1 focus:ring-ring"

  return (
    <div className="rounded-md border border-border bg-muted/30 p-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h3 className="text-xs uppercase tracking-wider font-semibold">vLLM Advanced Configuration</h3>
          <p className="mt-1 text-xs text-muted-foreground">Input budget at 4096 output tokens: {maxInputWithDefaultOutput.toLocaleString()} tokens.</p>
        </div>
        <div className="flex items-center gap-2">
          <Button type="button" onClick={applyVllmContainer} disabled={applying || restarting} size="sm">
            {applying ? "Applying" : "Apply"}
          </Button>
          <Button type="button" onClick={restartVllmContainer} disabled={restarting || applying} size="sm">
            {restarting ? "Restarting" : "Restart"}
          </Button>
          <Button type="button" onClick={copyRunCommand} variant="outline" size="sm">
            {copied ? "Copied" : "Copy"}
          </Button>
        </div>
      </div>

      <div className="mt-4 grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="space-y-2">
          <FieldLabel>Container</FieldLabel>
          <input value={containerName} onChange={(event) => setContainerName(event.target.value)} className={inputCls} />
        </div>
        <div className="space-y-2 md:col-span-2">
          <FieldLabel>Image</FieldLabel>
          <input value={image} onChange={(event) => setImage(event.target.value)} className={inputCls} />
        </div>
        <div className="space-y-2">
          <FieldLabel>GPU Device</FieldLabel>
          <input value={gpuDevice} onChange={(event) => setGpuDevice(event.target.value)} className={inputCls} />
        </div>
        <div className="space-y-2">
          <FieldLabel>Host Port</FieldLabel>
          <input value={hostPort} onChange={(event) => setHostPort(event.target.value)} inputMode="numeric" className={inputCls} />
        </div>
        <div className="space-y-2">
          <FieldLabel>Container Port</FieldLabel>
          <input value={containerPort} onChange={(event) => setContainerPort(event.target.value)} inputMode="numeric" className={inputCls} />
        </div>
        <div className="space-y-2">
          <FieldLabel>Max Model Len</FieldLabel>
          <input value={maxModelLen} onChange={(event) => setMaxModelLen(event.target.value)} inputMode="numeric" className={inputCls} />
        </div>
        <div className="space-y-2">
          <FieldLabel>GPU Memory</FieldLabel>
          <input value={gpuMemoryUtilization} onChange={(event) => setGpuMemoryUtilization(event.target.value)} inputMode="decimal" className={inputCls} />
        </div>
        <div className="space-y-2">
          <FieldLabel>Tensor Parallel</FieldLabel>
          <input value={tensorParallelSize} onChange={(event) => setTensorParallelSize(event.target.value)} inputMode="numeric" className={inputCls} />
        </div>
        <div className="space-y-2">
          <FieldLabel>dtype</FieldLabel>
          <select value={dtype} onChange={(event) => setDtype(event.target.value)} className={selectCls}>
            <option value="bfloat16">bfloat16</option>
            <option value="float16">float16</option>
            <option value="auto">auto</option>
          </select>
        </div>
        <div className="space-y-2">
          <FieldLabel>KV Cache dtype</FieldLabel>
          <select value={kvCacheDtype} onChange={(event) => setKvCacheDtype(event.target.value)} className={selectCls}>
            <option value="fp8">fp8</option>
            <option value="fp8_e4m3">fp8_e4m3</option>
            <option value="fp8_e5m2">fp8_e5m2</option>
            <option value="auto">auto</option>
          </select>
        </div>
        <div className="space-y-2">
          <FieldLabel>Tool Parser</FieldLabel>
          <select value={toolCallParser} onChange={(event) => setToolCallParser(event.target.value)} className={selectCls}>
            <option value="hermes">hermes</option>
            <option value="llama3_json">llama3_json</option>
            <option value="mistral">mistral</option>
            <option value="">none</option>
          </select>
        </div>
        <div className="space-y-2">
          <FieldLabel>Max Batched Tokens</FieldLabel>
          <input value={maxNumBatchedTokens} onChange={(event) => setMaxNumBatchedTokens(event.target.value)} inputMode="numeric" className={inputCls} />
        </div>
        <div className="space-y-2">
          <FieldLabel>Max Seqs</FieldLabel>
          <input value={maxNumSeqs} onChange={(event) => setMaxNumSeqs(event.target.value)} inputMode="numeric" placeholder="auto" className={inputCls} />
        </div>
        <div className="space-y-2">
          <FieldLabel>YaRN Factor</FieldLabel>
          <input value={yarnFactor} onChange={(event) => setYarnFactor(event.target.value)} inputMode="decimal" disabled={!enableYarnScaling} className={inputCls + " disabled:opacity-50"} />
        </div>
        <div className="space-y-2">
          <FieldLabel>Original Context</FieldLabel>
          <input value={originalContext} onChange={(event) => setOriginalContext(event.target.value)} inputMode="numeric" disabled={!enableYarnScaling} className={inputCls + " disabled:opacity-50"} />
        </div>
      </div>

      <div className="mt-4 grid grid-cols-1 md:grid-cols-3 gap-3">
        {[
          { label: "YaRN/RoPE scaling", checked: enableYarnScaling, onChange: setEnableYarnScaling },
          { label: "Allow long max len", checked: allowLongMaxModelLen, onChange: setAllowLongMaxModelLen },
          { label: "Chunked prefill", checked: enableChunkedPrefill, onChange: setEnableChunkedPrefill },
          { label: "Auto tool choice", checked: enableAutoToolChoice, onChange: setEnableAutoToolChoice },
          { label: "Calculate KV scales", checked: calculateKvScales, onChange: setCalculateKvScales },
        ].map(({ label, checked, onChange }) => (
          <label key={label} className="flex items-center gap-2 text-xs text-foreground">
            <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
            {label}
          </label>
        ))}
      </div>

      <textarea readOnly value={runCommand} className="mt-4 min-h-[240px] w-full rounded-md border border-border bg-background p-3 text-[11px] font-mono leading-5 text-foreground focus:outline-none" />

      {restartMessage && (
        <Alert variant={restartIsError ? "destructive" : "default"} className="mt-3">
          <AlertDescription className="text-xs">{restartMessage}</AlertDescription>
        </Alert>
      )}
    </div>
  )
}

export default function InferenceEndpointPanel() {
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState("")
  const [isError, setIsError] = useState(false)
  const [providers, setProviders] = useState<ProviderSummary[]>([])
  const [gateway, setGateway] = useState<InferenceRoute>(emptyRoute)
  const [system, setSystem] = useState<InferenceRoute>(emptyRoute)
  const [name, setName] = useState("vllm-local")
  const [type, setType] = useState("openai")
  const [model, setModel] = useState("vllm-local")
  const [baseUrl, setBaseUrl] = useState("http://host.docker.internal:8000/v1")
  const [credentialKey, setCredentialKey] = useState("OPENAI_API_KEY")
  const [apiKey, setApiKey] = useState("")
  const [route, setRoute] = useState<"gateway" | "system">("gateway")
  const [timeout, setTimeoutValue] = useState("0")
  const [noVerify, setNoVerify] = useState(true)
  const [ollamaModels, setOllamaModels] = useState<OllamaModel[]>([])
  const [ollamaLoading, setOllamaLoading] = useState(false)
  const [ollamaMessage, setOllamaMessage] = useState("")
  const [deletingProvider, setDeletingProvider] = useState<string | null>(null)

  function setMsg(text: string, error = false) { setIsError(error); setMessage(text) }

  const activeProvider = useMemo(
    () => providers.find((provider) => provider.name === gateway.provider) ?? null,
    [providers, gateway.provider]
  )
  const isOllamaEndpoint = name.toLowerCase().includes("ollama") || baseUrl.includes("11434")
  const isVllmEndpointSelected = type === "vllm"
  const vllmPort = useMemo(() => {
    try {
      return new URL(baseUrl).port || "8000"
    } catch {
      return "8000"
    }
  }, [baseUrl])

  async function load() {
    try {
      setLoading(true); setMsg("")
      const response = await fetch("/api/inference", { cache: "no-store" })
      const data = await response.json() as InferenceResponse & { error?: string }
      if (!response.ok) throw new Error(data.error || "Failed to load inference configuration")
      setGateway(data.gateway ?? emptyRoute())
      setSystem(data.system ?? emptyRoute())
      setProviders(Array.isArray(data.providers) ? data.providers : [])
      if (data.gateway?.provider) setName(data.gateway.provider)
      if (data.gateway?.model) setModel(data.gateway.model)
      if (data.gateway?.provider?.toLowerCase().includes("ollama")) {
        setType("openai"); setBaseUrl(OLLAMA_BASE_URL); setCredentialKey("OLLAMA_API_KEY")
      }
      if (data.gateway?.provider && isVllmEndpoint(data.gateway.provider, "")) setType("vllm")
    } catch (error) {
      setMsg(error instanceof Error ? error.message : "Failed to load inference configuration", true)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [])

  const loadOllamaModels = useCallback(async ({ silent = false }: { silent?: boolean } = {}) => {
    try {
      setOllamaLoading(true)
      if (!silent) setOllamaMessage("")
      const response = await fetch("/api/ollama/models", { cache: "no-store" })
      const data = await response.json()
      if (!data.available) {
        setOllamaModels([])
        setOllamaMessage(data.error || "Ollama is not reachable")
        return
      }
      const models = Array.isArray(data.models) ? data.models : []
      const sources = ollamaSourceSummary(models)
      const checked = ollamaProbeSummary(data.checkedHostLabels)
      setOllamaModels(models)
      setOllamaMessage(models.length > 0
        ? `${models.length} Ollama model${models.length === 1 ? "" : "s"} available${sources ? ` from ${sources}` : ""}${checked && checked !== sources ? `. Checked ${checked}.` : ""} Click one to load the Ollama endpoint preset.`
        : (checked ? `Checked ${checked}; no Ollama models reported.` : "Ollama is reachable but has no models installed."))
      if (models[0]?.name) setModel((current) => current || models[0].name)
    } catch (error) {
      setOllamaModels([])
      setOllamaMessage(error instanceof Error ? error.message : "Failed to fetch Ollama models")
    } finally {
      setOllamaLoading(false)
    }
  }, [])

  useEffect(() => {
    loadOllamaModels({ silent: true })
    const interval = window.setInterval(() => loadOllamaModels({ silent: true }), 10000)
    return () => window.clearInterval(interval)
  }, [loadOllamaModels])

  function applyOllamaModelPreset(item: OllamaModel) {
    setName(ollamaProviderName(item)); setType("openai"); setModel(item.name)
    setBaseUrl(ollamaOpenAiBaseUrl(item)); setCredentialKey("OLLAMA_API_KEY")
    setApiKey(""); setRoute("gateway"); setNoVerify(true)
    setMsg(`Ollama preset loaded for ${item.name}. Save to route sandbox inference through local Ollama.`)
  }

  function selectProvider(provider: ProviderSummary) {
    if (!provider.name) return
    setName(provider.name)
    setType(isVllmEndpoint(provider.name, "") ? "vllm" : provider.type || "openai")
    setCredentialKey(provider.credentialKeys[0] || "OPENAI_API_KEY")
    if (provider.name.toLowerCase().includes("ollama")) {
      setBaseUrl(OLLAMA_BASE_URL); setCredentialKey(provider.credentialKeys[0] || "OLLAMA_API_KEY"); setApiKey("")
    }
    setMsg(`Loaded ${provider.name}. Enter a model and save to make it active.`)
  }

  function useVllmPreset() {
    setName("vllm-local"); setType("vllm"); setModel(DEFAULT_VLLM_MODEL)
    setBaseUrl("http://host.docker.internal:8000/v1"); setCredentialKey("OPENAI_API_KEY")
    setApiKey(""); setRoute("gateway"); setNoVerify(true)
    setMsg("vLLM preset loaded. Adjust the endpoint URL if your server is bound somewhere else, then save.")
  }

  async function saveEndpoint() {
    try {
      setSaving(true); setMsg("")
      const response = await fetch("/api/inference", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, type, model, baseUrl, credentialKey, apiKey, route, timeout: Number(timeout || "0"), noVerify, makeActive: true }),
      })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || "Failed to save inference endpoint")
      setGateway(data.gateway ?? gateway); setSystem(data.system ?? system); setApiKey("")
      setMsg(`Inference endpoint '${name}' saved and routed to ${route === "system" ? "system" : "sandbox"} inference.`)
      await load()
    } catch (error) {
      setMsg(error instanceof Error ? error.message : "Failed to save inference endpoint", true)
    } finally {
      setSaving(false)
    }
  }

  async function deleteProvider(providerName: string | null) {
    if (!providerName) return
    if (!window.confirm(`Delete inference provider '${providerName}'?`)) return
    try {
      setDeletingProvider(providerName); setMsg("")
      const response = await fetch("/api/inference", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: providerName }),
      })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || "Failed to delete inference provider")
      setGateway(data.gateway ?? gateway); setSystem(data.system ?? system)
      setProviders(Array.isArray(data.providers) ? data.providers : [])
      if (name === providerName) setName("")
      setMsg(`Deleted inference provider '${providerName}'.`)
    } catch (error) {
      setMsg(error instanceof Error ? error.message : "Failed to delete inference provider", true)
    } finally {
      setDeletingProvider(null)
    }
  }

  const selectCls = "w-full rounded-md border border-input bg-muted/30 px-3 py-2 text-sm font-mono text-foreground focus:outline-none focus:ring-1 focus:ring-ring"

  return (
    <Card className="p-8">
      <div className="flex items-start justify-between gap-6 border-b border-border pb-5">
        <div>
          <h2 className="text-lg font-semibold text-primary uppercase tracking-wider">
            INFERENCE ENDPOINTS
          </h2>
          <p className="mt-2 max-w-3xl text-sm text-muted-foreground">
            Configure the OpenShell gateway route used by sandboxes through inference.local.
          </p>
        </div>
        <Button onClick={load} disabled={loading || saving} variant="outline" size="sm">Refresh</Button>
      </div>

      {loading ? (
        <div className="py-12 text-xs uppercase tracking-wider text-muted-foreground">Loading inference routes...</div>
      ) : (
        <div className="mt-6 space-y-6">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <div className="rounded-md border border-border bg-muted/30 p-4">
              <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Sandbox Route</p>
              <p className="mt-2 text-sm font-mono text-foreground">{gateway.configured ? gateway.provider : "not configured"}</p>
              <p className="mt-1 text-xs font-mono text-muted-foreground">{gateway.model || "No model selected"}</p>
              {gateway.timeout && <p className="mt-1 text-[11px] text-muted-foreground">Timeout {gateway.timeout}</p>}
            </div>
            <div className="rounded-md border border-border bg-muted/30 p-4">
              <p className="text-[10px] uppercase tracking-wider text-muted-foreground">System Route</p>
              <p className="mt-2 text-sm font-mono text-foreground">{system.configured ? system.provider : "not configured"}</p>
              <p className="mt-1 text-xs font-mono text-muted-foreground">{system.model || "No model selected"}</p>
              {system.timeout && <p className="mt-1 text-[11px] text-muted-foreground">Timeout {system.timeout}</p>}
            </div>
          </div>

          <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_360px] gap-6">
            <section className="space-y-4">
              <div className="rounded-md border border-border bg-muted/30 p-4">
                <div className="flex items-center justify-between gap-4">
                  <div>
                    <h3 className="text-xs uppercase tracking-wider font-semibold">Ollama Models</h3>
                    <p className="mt-1 text-xs text-muted-foreground">{ollamaMessage || "Polling local Ollama every 10 seconds."}</p>
                  </div>
                  <Button type="button" onClick={() => loadOllamaModels()} disabled={ollamaLoading} variant="outline" size="sm">
                    {ollamaLoading ? "Polling..." : "Poll"}
                  </Button>
                </div>
                {ollamaModels.length > 0 ? (
                  <div className="mt-3 grid grid-cols-1 md:grid-cols-2 gap-2">
                    {ollamaModels.map((item) => (
                      <button
                        key={ollamaModelKey(item)}
                        type="button"
                        onClick={() => applyOllamaModelPreset(item)}
                        className={`rounded-md border p-3 text-left transition-colors ${isOllamaEndpoint && model === item.name ? "border-primary bg-primary/5" : "border-border bg-background hover:border-primary"}`}
                      >
                        <div className="flex min-w-0 items-center gap-2 text-xs font-mono text-foreground">
                          <span className="truncate">{item.name}</span>
                          <OllamaHostBadge label={item.hostLabel} />
                        </div>
                        <div className="mt-1 text-[11px] text-muted-foreground">
                          {[item.parameterSize, item.quantization, item.sizeLabel].filter(Boolean).join(" · ") || item.family || "local model"}
                        </div>
                      </button>
                    ))}
                  </div>
                ) : (
                  <p className="mt-3 text-xs text-muted-foreground">No local Ollama models reported.</p>
                )}
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="space-y-2">
                  <FieldLabel>Provider Name</FieldLabel>
                  <input value={name} onChange={(event) => setName(event.target.value)} className={inputClsSm} />
                </div>
                <div className="space-y-2">
                  <FieldLabel>Provider Type</FieldLabel>
                  <select value={type} onChange={(event) => setType(event.target.value)} className={selectCls}>
                    {providerTypeOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                  </select>
                </div>
                <div className="space-y-2 md:col-span-2">
                  <FieldLabel>Model</FieldLabel>
                  {isOllamaEndpoint && ollamaModels.length > 0 ? (
                    <select value={model} onChange={(event) => setModel(event.target.value)} className={selectCls}>
                      {ollamaModels.map((item) => <option key={ollamaModelKey(item)} value={item.name}>{item.hostLabel ? `[${item.hostLabel}] ` : ""}{item.name}</option>)}
                    </select>
                  ) : (
                    <input value={model} onChange={(event) => setModel(event.target.value)} placeholder="provider/model-name" className={inputClsSm} />
                  )}
                </div>
                <div className="space-y-2 md:col-span-2">
                  <FieldLabel>Endpoint URL</FieldLabel>
                  <input value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} placeholder="https://example.com/v1" className={inputClsSm} />
                </div>
                <div className="space-y-2">
                  <FieldLabel>Credential Env Key</FieldLabel>
                  <input value={credentialKey} onChange={(event) => setCredentialKey(event.target.value.toUpperCase())} className={inputClsSm} />
                </div>
                <div className="space-y-2">
                  <FieldLabel>API Key</FieldLabel>
                  <input value={apiKey} onChange={(event) => setApiKey(event.target.value)} type="password" placeholder={activeProvider ? "leave blank to keep stored key" : "stored in OpenShell provider"} className={inputClsSm} />
                </div>
                <div className="space-y-2">
                  <FieldLabel>Route</FieldLabel>
                  <select value={route} onChange={(event) => setRoute(event.target.value as "gateway" | "system")} className={selectCls}>
                    <option value="gateway">Sandbox inference</option>
                    <option value="system">System inference</option>
                  </select>
                </div>
                <div className="space-y-2">
                  <FieldLabel>Timeout Seconds</FieldLabel>
                  <input value={timeout} onChange={(event) => setTimeoutValue(event.target.value)} inputMode="numeric" className={inputClsSm} />
                </div>
              </div>

              <label className="flex items-center gap-3 text-sm text-foreground">
                <input type="checkbox" checked={noVerify} onChange={(event) => setNoVerify(event.target.checked)} />
                Skip provider verification while saving
              </label>

              {isVllmEndpointSelected && (
                <VllmAdvancedConfiguration model={model} port={vllmPort} />
              )}

              <div className="flex flex-wrap items-center gap-3">
                <Button onClick={saveEndpoint} disabled={saving} size="sm">
                  {saving ? "Saving..." : "Save Endpoint"}
                </Button>
                <Button type="button" onClick={useVllmPreset} disabled={saving} variant="outline" size="sm">
                  vLLM Preset
                </Button>
              </div>

              {message && (
                <Alert variant={isError ? "destructive" : "default"}>
                  <AlertDescription className="text-xs whitespace-pre-wrap">{message}</AlertDescription>
                </Alert>
              )}
            </section>

            <section className="space-y-3">
              <h3 className="text-xs uppercase tracking-wider font-semibold">Configured Providers</h3>
              {providers.length === 0 ? (
                <div className="rounded-md border border-border bg-muted/30 p-4 text-xs text-muted-foreground">No providers configured.</div>
              ) : (
                <div className="space-y-2">
                  {providers.map((provider) => (
                    <div key={provider.name || provider.id} className="rounded-md border border-border bg-muted/30 p-3">
                      <button type="button" onClick={() => selectProvider(provider)} className="w-full text-left">
                        <div className="flex items-center justify-between gap-3">
                          <span className="text-sm font-mono text-foreground">{provider.name}</span>
                          {provider.name === gateway.provider && (
                            <span className="text-[10px] uppercase tracking-wider text-primary">active</span>
                          )}
                        </div>
                        <p className="mt-1 text-[11px] text-muted-foreground">{provider.type || "unknown"} · credentials {provider.credentialKeys.length} · config {provider.configKeys.length}</p>
                      </button>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => deleteProvider(provider.name)}
                        disabled={!provider.name || deletingProvider === provider.name}
                        className="mt-3 border-destructive/40 text-destructive hover:bg-destructive/10"
                      >
                        {deletingProvider === provider.name ? "Deleting..." : "Delete"}
                      </Button>
                    </div>
                  ))}
                </div>
              )}
            </section>
          </div>
        </div>
      )}
    </Card>
  )
}
