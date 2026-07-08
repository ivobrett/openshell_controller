"use client"

import { useEffect, useMemo, useState } from "react"
import { Button } from "@/app/components/ui/button"
import { Badge } from "@/app/components/ui/badge"
import { Alert, AlertDescription } from "@/app/components/ui/alert"
import { Card } from "@/app/components/ui/card"

type McpTransport = "stdio" | "http"

type McpCatalogEntry = {
  id: string
  name: string
  summary: string
  websiteUrl?: string
  transport: McpTransport
  command: string
  args: string[]
  env: Record<string, string>
  tags: string[]
}

type McpServerInstall = McpCatalogEntry & {
  installedAt: string
  updatedAt: string
  source: "catalog" | "custom" | "registry"
  enabled: boolean
  accessMode: "disabled" | "allow_all" | "allow_only"
  allowedSandboxIds: string[]
}

type McpResponse = {
  catalog: McpCatalogEntry[]
  servers: McpServerInstall[]
  config: Record<string, unknown>
  error?: string
}

type McpRegistry = {
  id: string
  name: string
  baseUrl: string
  description: string
  addedAt: string
}

type McpPreflightResult = {
  ok: boolean
  checkedAt: string
  toolCount: number
  tools: string[]
  durationMs: number
  error?: string
  diagnosis: {
    summary: string
    likelyCauses: string[]
    suggestedFixes: string[]
    confidence: "low" | "medium" | "high"
  }
}

type McpPreflightRepairResult = {
  attempted: boolean
  ok: boolean
  provider: "openai-compatible"
  model: string
  baseUrl: string
  summary: string
  changes: Array<{
    type: "file" | "launch"
    path?: string
    summary: string
  }>
  error?: string
}

type McpInstallSuggestion = {
  name?: string
  summary?: string
  transport?: McpTransport
  command?: string
  args?: string[]
  env?: Record<string, string>
  uploadRuntime?: string
  uploadEntryMode?: "file" | "python-module" | "console-script" | ""
  uploadEntrypoint?: string
  notes?: string
}

type StagedMcpUpload = {
  id: string
  name: string
  summary: string
  runtime: string
  entryMode: "file" | "python-module" | "console-script"
  entrypoint: string
  uploadRoot: string
  projectRoot: string
  selectedBundle?: string
}

type McpSandbox = {
  id: string
  name: string
  status: string
}

type McpConfigurationPanelProps = {
  sandboxes?: McpSandbox[]
}

const REGISTRY_PAGE_SIZE = 4
const WIZARD_STEPS = ["upload", "preflight", "review", "install"] as const
type WizardStep = typeof WIZARD_STEPS[number]
const WIZARD_STEP_LABELS: Record<WizardStep, string> = {
  upload: "Upload Server Files",
  preflight: "Preflight Check",
  review: "Review",
  install: "Install",
}

const inputCls = "w-full rounded-md border border-input bg-background px-3 py-2 text-sm font-mono text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
const selectCls = "w-full rounded-md border border-input bg-background px-3 py-2 text-sm font-mono text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
const textareaCls = "w-full rounded-md border border-input bg-background px-3 py-2 text-sm font-mono text-foreground focus:outline-none focus:ring-1 focus:ring-ring resize-y"

function FieldLabel({ children }: { children: React.ReactNode }) {
  return <label className="text-[10px] uppercase tracking-wider text-muted-foreground">{children}</label>
}

function FieldHint({ children }: { children: React.ReactNode }) {
  return (
    <span
      title={typeof children === "string" ? children : undefined}
      className="inline-flex h-4 w-4 items-center justify-center rounded-full border border-border text-[10px] text-muted-foreground"
    >
      ?
    </span>
  )
}

function parseLines(value: string) {
  return value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
}

function parseEnv(value: string) {
  return Object.fromEntries(
    parseLines(value)
      .map((line) => { const [key, ...rest] = line.split("="); return [key?.trim() || "", rest.join("=").trim()] })
      .filter(([key]) => Boolean(key)),
  )
}

function envToText(value: Record<string, string>) {
  return Object.entries(value).map(([key, item]) => `${key}=${item}`).join("\n")
}

const DEFAULT_CUSTOM_NAME = "custom-tools"
const DEFAULT_CUSTOM_SUMMARY = "Custom MCP server"
const DEFAULT_CUSTOM_ARGS = "-y\n@modelcontextprotocol/server-memory"
const DEFAULT_UPLOAD_RUNTIME = ""
const DEFAULT_UPLOAD_ENTRY_MODE: "file" | "python-module" | "console-script" = "file"
const DEFAULT_UPLOAD_ENTRYPOINT = ""

export default function McpConfigurationPanel({ sandboxes = [] }: McpConfigurationPanelProps) {
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState("")
  const [isError, setIsError] = useState(false)
  const [catalog, setCatalog] = useState<McpCatalogEntry[]>([])
  const [servers, setServers] = useState<McpServerInstall[]>([])
  const [config, setConfig] = useState<Record<string, unknown>>({ mcpServers: {} })
  const [customName, setCustomName] = useState(DEFAULT_CUSTOM_NAME)
  const [customSummary, setCustomSummary] = useState(DEFAULT_CUSTOM_SUMMARY)
  const [customTransport, setCustomTransport] = useState<McpTransport>("stdio")
  const [customCommand, setCustomCommand] = useState("npx")
  const [customArgs, setCustomArgs] = useState(DEFAULT_CUSTOM_ARGS)
  const [customEnv, setCustomEnv] = useState("")
  const [uploadFiles, setUploadFiles] = useState<File[]>([])
  const [uploadPaths, setUploadPaths] = useState<string[]>([])
  const [uploadArchive, setUploadArchive] = useState<File | null>(null)
  const [uploadRuntime, setUploadRuntime] = useState(DEFAULT_UPLOAD_RUNTIME)
  const [uploadEntryMode, setUploadEntryMode] = useState<"file" | "python-module" | "console-script">(DEFAULT_UPLOAD_ENTRY_MODE)
  const [uploadEntrypoint, setUploadEntrypoint] = useState(DEFAULT_UPLOAD_ENTRYPOINT)
  const [uploadRepair, setUploadRepair] = useState(true)
  const [repairSandboxId, setRepairSandboxId] = useState("")
  const [stagedUpload, setStagedUpload] = useState<StagedMcpUpload | null>(null)
  const [wizardPreflight, setWizardPreflight] = useState<McpPreflightResult | null>(null)
  const [wizardRepair, setWizardRepair] = useState<McpPreflightRepairResult | null>(null)
  const [wizardCandidate, setWizardCandidate] = useState<McpCatalogEntry | null>(null)
  const [wizardDependencyInstall, setWizardDependencyInstall] = useState<{ kind?: string; logs?: string[] } | null>(null)
  const [wizardInstallResult, setWizardInstallResult] = useState<McpServerInstall | null>(null)
  const [installPrompt, setInstallPrompt] = useState("")
  const [installAssistNotes, setInstallAssistNotes] = useState("")
  const [editingServerId, setEditingServerId] = useState<string | null>(null)
  const [editorText, setEditorText] = useState("")
  const [registrySearch, setRegistrySearch] = useState("github")
  const [registryResults, setRegistryResults] = useState<McpCatalogEntry[]>([])
  const [registryLoading, setRegistryLoading] = useState(false)
  const [registryPage, setRegistryPage] = useState(1)
  const [lastRegistrySearch, setLastRegistrySearch] = useState("")
  const [registries, setRegistries] = useState<McpRegistry[]>([])
  const [selectedRegistryId, setSelectedRegistryId] = useState("")
  const [registryName, setRegistryName] = useState("")
  const [registryUrl, setRegistryUrl] = useState("")
  const [registryDescription, setRegistryDescription] = useState("")
  const [registryPrompt, setRegistryPrompt] = useState("")
  const [preflightResults, setPreflightResults] = useState<Record<string, McpPreflightResult>>({})
  const [securityOpen, setSecurityOpen] = useState(true)
  const [openSecurityServers, setOpenSecurityServers] = useState<Record<string, boolean>>({})
  const [repoOpen, setRepoOpen] = useState(true)
  const [catalogOpen, setCatalogOpen] = useState(false)
  const [customOpen, setCustomOpen] = useState(false)
  const [wizardStep, setWizardStep] = useState<WizardStep>("upload")

  function setMsg(text: string, error = false) { setIsError(error); setMessage(text) }

  const installedIds = useMemo(() => new Set(servers.map((server) => server.id)), [servers])
  const enabledCount = servers.filter((server) => server.enabled).length
  const configText = JSON.stringify(config, null, 2)
  const registryPageCount = Math.max(1, Math.ceil(registryResults.length / REGISTRY_PAGE_SIZE))
  const selectedRegistry = registries.find((registry) => registry.id === selectedRegistryId) || registries[0] || null
  const pagedRegistryResults = registryResults.slice(
    (registryPage - 1) * REGISTRY_PAGE_SIZE,
    registryPage * REGISTRY_PAGE_SIZE,
  )
  const wizardStepIndex = WIZARD_STEPS.indexOf(wizardStep)
  const hasUploadBundle = Boolean(uploadArchive || uploadFiles.length > 0)

  async function load() {
    try {
      setLoading(true)
      const [response, registryResponse] = await Promise.all([
        fetch("/api/mcp", { cache: "no-store" }),
        fetch("/api/mcp/registries", { cache: "no-store" }),
      ])
      const data = await response.json() as McpResponse
      const registryData = await registryResponse.json() as { registries?: McpRegistry[]; error?: string }
      if (!response.ok) throw new Error(data.error || "Failed to load MCP configuration")
      if (!registryResponse.ok) throw new Error(registryData.error || "Failed to load MCP registries")
      setCatalog(Array.isArray(data.catalog) ? data.catalog : [])
      setServers(Array.isArray(data.servers) ? data.servers : [])
      setConfig(data.config || { mcpServers: {} })
      const nextRegistries = Array.isArray(registryData.registries) ? registryData.registries : []
      setRegistries(nextRegistries)
      setSelectedRegistryId((current) => current && nextRegistries.some((registry) => registry.id === current) ? current : nextRegistries[0]?.id || "")
      setMsg("")
    } catch (error) {
      setMsg(error instanceof Error ? error.message : "Failed to load MCP configuration", true)
    } finally {
      setLoading(false)
    }
  }

  async function saveRegistry() {
    try {
      setSaving(true)
      const response = await fetch("/api/mcp/registries", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: registryName, baseUrl: registryUrl, description: registryDescription }),
      })
      const data = await response.json() as { registry?: McpRegistry; registries?: McpRegistry[]; error?: string }
      if (!response.ok || !data.registry) throw new Error(data.error || "Failed to save MCP registry")
      const nextRegistries = Array.isArray(data.registries) ? data.registries : []
      setRegistries(nextRegistries)
      setSelectedRegistryId(data.registry.id)
      setRegistryName(""); setRegistryUrl(""); setRegistryDescription(""); setRegistryPrompt("")
      setMsg(`${data.registry.name} registry added.`)
    } catch (error) {
      setMsg(error instanceof Error ? error.message : "Failed to save MCP registry", true)
    } finally {
      setSaving(false)
    }
  }

  async function deleteRegistry(registry: McpRegistry) {
    try {
      setSaving(true)
      const response = await fetch("/api/mcp/registries", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "delete", registryId: registry.id }),
      })
      const data = await response.json() as { registries?: McpRegistry[]; error?: string }
      if (!response.ok) throw new Error(data.error || "Failed to delete MCP registry")
      const nextRegistries = Array.isArray(data.registries) ? data.registries : []
      setRegistries(nextRegistries)
      setSelectedRegistryId((current) => current === registry.id ? nextRegistries[0]?.id || "" : current)
      setRegistryResults([])
      setMsg(`${registry.name} registry deleted.`)
    } catch (error) {
      setMsg(error instanceof Error ? error.message : "Failed to delete MCP registry", true)
    } finally {
      setSaving(false)
    }
  }

  async function assistRegistry() {
    try {
      setSaving(true)
      const response = await fetch("/api/mcp/registries/assist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: registryPrompt || `${registryName} ${registryUrl}`.trim() }),
      })
      const data = await response.json() as { suggestion?: Partial<McpRegistry>; error?: string }
      if (!response.ok || !data.suggestion) throw new Error(data.error || "Failed to generate registry suggestion")
      setRegistryName(data.suggestion.name || registryName)
      setRegistryUrl(data.suggestion.baseUrl || registryUrl)
      setRegistryDescription(data.suggestion.description || registryDescription)
      setMsg("Registry fields drafted from the running LLM endpoint.")
    } catch (error) {
      setMsg(error instanceof Error ? error.message : "Failed to generate registry suggestion", true)
    } finally {
      setSaving(false)
    }
  }

  function applyInstallSuggestion(suggestion: McpInstallSuggestion) {
    if (suggestion.name) setCustomName(suggestion.name)
    if (suggestion.summary) setCustomSummary(suggestion.summary)
    if (suggestion.transport) setCustomTransport(suggestion.transport)
    if (suggestion.command) setCustomCommand(suggestion.command)
    if (Array.isArray(suggestion.args)) setCustomArgs(suggestion.args.join("\n"))
    if (suggestion.env) setCustomEnv(envToText(suggestion.env))
    if (suggestion.uploadRuntime) setUploadRuntime(suggestion.uploadRuntime)
    if (suggestion.uploadEntryMode) setUploadEntryMode(suggestion.uploadEntryMode)
    if (suggestion.uploadEntrypoint) setUploadEntrypoint(suggestion.uploadEntrypoint)
    if (suggestion.notes) setInstallAssistNotes(suggestion.notes)
  }

  async function assistInstall() {
    try {
      setSaving(true)
      const response = await fetch("/api/mcp/install-assist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt: installPrompt,
          current: { name: customName, summary: customSummary, transport: customTransport, command: customCommand, args: parseLines(customArgs), env: parseEnv(customEnv), uploadRuntime, uploadEntryMode, uploadEntrypoint },
        }),
      })
      const data = await response.json() as { suggestion?: McpInstallSuggestion; error?: string }
      if (!response.ok || !data.suggestion) throw new Error(data.error || "Failed to draft MCP install")
      applyInstallSuggestion(data.suggestion)
      setWizardStep("upload")
      setMsg("Install wizard fields drafted from the running LLM endpoint.")
    } catch (error) {
      setMsg(error instanceof Error ? error.message : "Failed to draft MCP install", true)
    } finally {
      setSaving(false)
    }
  }

  function nextWizardStep() { setWizardStep(WIZARD_STEPS[Math.min(WIZARD_STEPS.length - 1, wizardStepIndex + 1)]) }
  function previousWizardStep() { setWizardStep(WIZARD_STEPS[Math.max(0, wizardStepIndex - 1)]) }

  async function postUpdate(body: Record<string, unknown>, success: string) {
    try {
      setSaving(true)
      const response = await fetch("/api/mcp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })
      const data = await response.json() as McpResponse
      if (!response.ok) throw new Error(data.error || "Failed to update MCP configuration")
      setCatalog(Array.isArray(data.catalog) ? data.catalog : catalog)
      setServers(Array.isArray(data.servers) ? data.servers : [])
      setConfig(data.config || { mcpServers: {} })
      setMsg(success)
      return true
    } catch (error) {
      setMsg(error instanceof Error ? error.message : "Failed to update MCP configuration", true)
      return false
    } finally {
      setSaving(false)
    }
  }

  function sandboxAllowed(server: McpServerInstall, sandbox: McpSandbox) {
    return server.allowedSandboxIds.includes(sandbox.id) || server.allowedSandboxIds.includes(sandbox.name)
  }

  function toggleServerSandbox(server: McpServerInstall, sandbox: McpSandbox, allowed: boolean) {
    const current = new Set(server.allowedSandboxIds)
    current.delete(sandbox.id); current.delete(sandbox.name)
    if (allowed) current.add(sandbox.id)
    return postUpdate({ action: "update-access", serverId: server.id, accessMode: "allow_only", allowedSandboxIds: Array.from(current) }, `${server.name} sandbox access updated.`)
  }

  async function syncAccessModeChange(server: McpServerInstall, accessMode: string) {
    await postUpdate({ action: "update-access", serverId: server.id, accessMode }, `${server.name} availability updated.`)
  }

  async function setServerEnabled(server: McpServerInstall, enabled: boolean) {
    await postUpdate({ action: "update-access", serverId: server.id, enabled }, `${server.name} ${enabled ? "enabled" : "disabled"}.`)
  }

  function editableServerJson(server: McpServerInstall) {
    return JSON.stringify({ id: server.id, name: server.name, summary: server.summary, websiteUrl: server.websiteUrl || "", transport: server.transport, command: server.command, args: server.args, env: server.env, tags: server.tags, enabled: server.enabled, accessMode: server.accessMode, allowedSandboxIds: server.allowedSandboxIds, source: server.source }, null, 2)
  }

  function serverPayloadFromJson(text: string, fallbackId = "uploaded-server") {
    const parsed = JSON.parse(text)
    const firstMcpEntry = parsed?.mcpServers && typeof parsed.mcpServers === "object" ? Object.entries(parsed.mcpServers)[0] : null
    const id = firstMcpEntry?.[0] || parsed?.id || parsed?.name || fallbackId
    const body = firstMcpEntry?.[1] && typeof firstMcpEntry[1] === "object" ? firstMcpEntry[1] as Record<string, unknown> : parsed
    const command = typeof body?.command === "string" ? body.command : typeof body?.url === "string" ? body.url : typeof parsed?.command === "string" ? parsed.command : typeof parsed?.url === "string" ? parsed.url : ""
    const transport = body?.url || parsed?.transport === "http" ? "http" : "stdio"
    return {
      action: "install", id, name: parsed?.name || id, summary: parsed?.summary || "Uploaded MCP server",
      websiteUrl: parsed?.websiteUrl || "", transport, command,
      args: Array.isArray(body?.args) ? body.args : Array.isArray(parsed?.args) ? parsed.args : [],
      env: typeof body?.env === "object" && body.env ? body.env : typeof body?.headers === "object" && body.headers ? body.headers : parsed?.env || {},
      tags: Array.isArray(parsed?.tags) ? parsed.tags : ["uploaded"],
      source: parsed?.source || "custom", enabled: typeof parsed?.enabled === "boolean" ? parsed.enabled : true,
      accessMode: parsed?.accessMode, allowedSandboxIds: parsed?.allowedSandboxIds,
    }
  }

  function chooseUploadDirectory(fileList: FileList | null) {
    const files = Array.from(fileList || [])
    setUploadFiles(files)
    setUploadPaths(files.map((file) => { const f = file as File & { webkitRelativePath?: string }; return f.webkitRelativePath || file.name }))
    if (files.length > 0) setUploadArchive(null)
    resetWizardPreflightState()
  }

  function chooseUploadArchive(file: File | null) {
    setUploadArchive(file)
    if (file) { setUploadFiles([]); setUploadPaths([]) }
    resetWizardPreflightState()
  }

  function resetWizardPreflightState() {
    setStagedUpload(null); setWizardPreflight(null); setWizardRepair(null)
    setWizardCandidate(null); setWizardDependencyInstall(null); setWizardInstallResult(null)
  }

  function resetWizardWorkflow() {
    setCustomName(DEFAULT_CUSTOM_NAME); setCustomSummary(DEFAULT_CUSTOM_SUMMARY); setCustomArgs(DEFAULT_CUSTOM_ARGS)
    setCustomEnv(""); setUploadRuntime(DEFAULT_UPLOAD_RUNTIME); setUploadEntryMode(DEFAULT_UPLOAD_ENTRY_MODE)
    setUploadEntrypoint(DEFAULT_UPLOAD_ENTRYPOINT); setRepairSandboxId(""); setUploadRepair(true)
    setUploadFiles([]); setUploadPaths([]); setUploadArchive(null)
    resetWizardPreflightState(); setWizardStep("upload")
  }

  function cancelWizardWorkflow() { resetWizardWorkflow(); setMsg("MCP server install canceled.") }

  function summarizePreflight(preflight: McpPreflightResult) {
    if (preflight.ok) return `${preflight.diagnosis.summary}${preflight.tools.length > 0 ? ` Tools: ${preflight.tools.join(", ")}.` : ""}`
    const causes = preflight.diagnosis.likelyCauses.length > 0 ? `\nLikely: ${preflight.diagnosis.likelyCauses.join(" ")}` : ""
    const fixes = preflight.diagnosis.suggestedFixes.length > 0 ? `\nTry: ${preflight.diagnosis.suggestedFixes.join(" ")}` : ""
    return `${preflight.diagnosis.summary}\n${preflight.error || "MCP tool discovery failed."}${causes}${fixes}`
  }

  function summarizeRepair(repair?: McpPreflightRepairResult | null) {
    if (!repair?.attempted) return ""
    const changeSummary = repair.changes.length > 0 ? `\nChanged: ${repair.changes.map((change) => change.path ? `${change.path}: ${change.summary}` : change.summary).join(" ")}` : ""
    const route = repair.model ? `\nRepair model: ${repair.model}` : ""
    const error = repair.error ? `\nRepair error: ${repair.error}` : ""
    return `\nLLM repair ${repair.ok ? "applied" : "did not apply changes"}: ${repair.summary}${changeSummary}${route}${error}`
  }

  async function preflightServer(server: McpServerInstall) {
    try {
      setSaving(true)
      const response = await fetch("/api/mcp/preflight", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ serverId: server.id }) })
      const data = await response.json() as { preflight?: McpPreflightResult; error?: string }
      if (!response.ok || !data.preflight) throw new Error(data.error || "Failed to preflight MCP server")
      setPreflightResults((current) => ({ ...current, [server.id]: data.preflight as McpPreflightResult }))
      setMsg(`${server.name} preflight ${data.preflight.ok ? "passed" : "failed"}.\n${summarizePreflight(data.preflight)}`)
    } catch (error) {
      setMsg(error instanceof Error ? error.message : "Failed to preflight MCP server", true)
    } finally {
      setSaving(false)
    }
  }

  function appendWizardMetadata(form: FormData) {
    form.set("id", customName); form.set("name", customName); form.set("summary", customSummary)
    form.set("args", customArgs); form.set("env", customEnv)
    form.set("repair", uploadRepair ? "true" : "false")
    if (repairSandboxId) form.set("sandboxId", repairSandboxId)
  }

  async function stageUploadServer() {
    try {
      if (!uploadArchive && uploadFiles.length === 0) { setMsg("Choose a server directory or archive before uploading."); return false }
      setSaving(true)
      const form = new FormData()
      form.set("mode", "stage")
      appendWizardMetadata(form)
      if (uploadArchive) { form.set("archive", uploadArchive) }
      else { uploadFiles.forEach((file, index) => { form.append("files", file); form.append("paths", uploadPaths[index] || file.name) }) }
      const response = await fetch("/api/mcp/upload", { method: "POST", body: form })
      const data = await response.json() as { stagedUpload?: StagedMcpUpload; error?: string }
      if (!response.ok || !data.stagedUpload) throw new Error(data.error || "Failed to upload MCP server files")
      setStagedUpload(data.stagedUpload)
      setUploadRuntime(data.stagedUpload.runtime); setUploadEntryMode(data.stagedUpload.entryMode); setUploadEntrypoint(data.stagedUpload.entrypoint)
      setWizardPreflight(null); setWizardRepair(null); setWizardCandidate(null); setWizardDependencyInstall(null); setWizardInstallResult(null)
      setMsg(`${data.stagedUpload.name} files uploaded. Continue to preflight when ready.`)
      return true
    } catch (error) {
      setMsg(error instanceof Error ? error.message : "Failed to upload MCP server files", true)
      return false
    } finally {
      setSaving(false)
    }
  }

  async function startWizardPreflightChecks() {
    try {
      if (!stagedUpload) { setMsg("Upload server files before starting preflight checks."); return }
      setSaving(true)
      const form = new FormData()
      form.set("mode", "preflight")
      appendWizardMetadata(form)
      const response = await fetch("/api/mcp/upload", { method: "POST", body: form })
      const data = await response.json() as {
        stagedUpload?: StagedMcpUpload; candidate?: McpCatalogEntry
        dependencyInstall?: { kind?: string; logs?: string[] }
        preflight?: McpPreflightResult; repair?: McpPreflightRepairResult; error?: string
      }
      if (!response.ok || !data.preflight || !data.candidate) throw new Error(data.error || "Failed to preflight MCP server")
      setStagedUpload(data.stagedUpload || stagedUpload)
      if (data.stagedUpload) { setUploadRuntime(data.stagedUpload.runtime); setUploadEntryMode(data.stagedUpload.entryMode); setUploadEntrypoint(data.stagedUpload.entrypoint) }
      setWizardCandidate(data.candidate); setWizardDependencyInstall(data.dependencyInstall || null)
      setWizardPreflight(data.preflight); setWizardRepair(data.repair || null)
      const installKind = data.dependencyInstall?.kind || "generic"
      const installLogCount = data.dependencyInstall?.logs?.filter(Boolean).length || 0
      setMsg(`Preflight ${data.preflight.ok ? "passed" : "found failures"}. ${installKind === "generic" ? "No dependency bootstrap was needed." : `${installKind} dependencies bootstrapped${installLogCount > 0 ? ` with ${installLogCount} install step${installLogCount === 1 ? "" : "s"}` : ""}.`}${summarizeRepair(data.repair)}\n${summarizePreflight(data.preflight)}`)
    } catch (error) {
      setMsg(error instanceof Error ? error.message : "Failed to preflight MCP server", true)
    } finally {
      setSaving(false)
    }
  }

  async function installStagedUpload() {
    try {
      if (!stagedUpload || !wizardCandidate) { setMsg("Run preflight before installing this MCP server."); return }
      setSaving(true)
      const form = new FormData()
      form.set("mode", "install-staged"); appendWizardMetadata(form)
      form.set("command", wizardCandidate.command); form.set("commandArgs", wizardCandidate.args.join("\n"))
      form.set("installEnv", envToText(wizardCandidate.env)); form.set("preflightOk", wizardPreflight?.ok ? "true" : "false")
      const response = await fetch("/api/mcp/upload", { method: "POST", body: form })
      const data = await response.json() as McpResponse & { server?: McpServerInstall; error?: string }
      if (!response.ok || !data.server) throw new Error(data.error || "Failed to install staged MCP server")
      setCatalog(Array.isArray(data.catalog) ? data.catalog : catalog)
      setServers(Array.isArray(data.servers) ? data.servers : [])
      setConfig(data.config || { mcpServers: {} })
      setWizardInstallResult(data.server)
      if (wizardPreflight) setPreflightResults((current) => ({ ...current, [data.server!.id]: wizardPreflight }))
      setMsg(`${data.server.name} installed${data.server.enabled ? "." : " disabled because preflight did not pass."}`)
      resetWizardWorkflow()
    } catch (error) {
      setMsg(error instanceof Error ? error.message : "Failed to install staged MCP server", true)
    } finally {
      setSaving(false)
    }
  }

  async function handleWizardNext() {
    if (wizardStep === "upload") {
      const staged = stagedUpload ? true : await stageUploadServer()
      if (staged) nextWizardStep()
      return
    }
    if (wizardStep === "preflight") {
      if (!wizardPreflight) { setMsg("Start preflight checks before reviewing this MCP server."); return }
      nextWizardStep(); return
    }
    if (wizardStep === "review") nextWizardStep()
  }

  function startEditingServer(server: McpServerInstall) {
    setEditingServerId(server.id); setEditorText(editableServerJson(server))
  }

  async function saveEditedServer() {
    try {
      const payload = serverPayloadFromJson(editorText, editingServerId || "edited-server")
      await postUpdate(payload, `${String(payload.name || payload.id)} updated.`)
      setEditingServerId(null); setEditorText("")
    } catch (error) {
      setMsg(error instanceof Error ? error.message : "Failed to save MCP server JSON", true)
    }
  }

  async function searchRegistry() {
    const query = registrySearch.trim()
    if (!selectedRegistry) { setMsg("Add an MCP Registry before searching."); return }
    try {
      setRegistryLoading(true); setRegistryResults([]); setRegistryPage(1); setLastRegistrySearch(query)
      const params = new URLSearchParams({ search: query, limit: "24", baseUrl: selectedRegistry.baseUrl })
      const response = await fetch(`/api/mcp/registry?${params}`, { cache: "no-store" })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || "Failed to search MCP registry")
      const results = Array.isArray(data.results) ? data.results : []
      setRegistryResults(results)
      setMsg(results.length > 0 ? `Found ${results.length} server${results.length === 1 ? "" : "s"} in ${selectedRegistry.name}.` : `${selectedRegistry.name} had no matches for that search.`)
    } catch (error) {
      setRegistryResults([])
      setMsg(error instanceof Error ? error.message : "Failed to search MCP registry", true)
    } finally {
      setRegistryLoading(false)
    }
  }

  useEffect(() => { load() }, [])

  const accordionToggle = "flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-border bg-muted text-sm text-foreground"

  return (
    <div className="space-y-6">
      <Card className="overflow-hidden">
        <div className="flex items-start justify-between gap-6 p-6 max-md:flex-col">
          <div>
            <p className="font-mono text-[10px] uppercase tracking-wider text-primary">Model Context Protocol</p>
            <h1 className="mt-1 text-xl font-semibold uppercase tracking-wider">MCP CONFIGURATION</h1>
            <p className="mt-2 max-w-3xl text-sm text-muted-foreground">
              Install MCP server definitions for local tools, files, and remote context providers.
            </p>
          </div>
          <Button onClick={load} disabled={loading || saving} variant="outline" size="sm">Refresh</Button>
        </div>
        <div className="grid grid-cols-1 gap-px bg-border sm:grid-cols-3">
          {[
            { label: "Installed", value: `${servers.length} servers` },
            { label: "Enabled", value: `${enabledCount} active` },
            { label: "Catalog", value: `${catalog.length} presets` },
          ].map(({ label, value }) => (
            <div key={label} className="bg-muted/50 p-4">
              <p className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</p>
              <p className="mt-1 font-mono text-sm text-foreground">{value}</p>
            </div>
          ))}
        </div>
      </Card>

      {message && (
        <Alert variant={isError ? "destructive" : "default"}>
          <AlertDescription className="text-xs whitespace-pre-wrap">{message}</AlertDescription>
        </Alert>
      )}

      {loading ? (
        <Card className="p-8 text-xs uppercase tracking-wider text-muted-foreground">Loading MCP servers...</Card>
      ) : (
        <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1fr)_400px]">
          <section className="space-y-6">
            <Card className="p-6">
              <button
                type="button"
                onClick={() => setSecurityOpen((open) => !open)}
                className="flex w-full items-center justify-between gap-4 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                aria-expanded={securityOpen}
              >
                <div>
                  <h2 className="text-sm font-semibold uppercase tracking-wider">MCP Security</h2>
                  <p className="mt-1 text-xs text-muted-foreground">Control which installed MCP servers are available to sandboxes.</p>
                </div>
                <span className={accordionToggle}>{securityOpen ? "-" : "+"}</span>
              </button>
              {securityOpen && (
                <div className="mt-5 space-y-3 border-t border-border pt-5">
                  {servers.length === 0 ? (
                    <div className="rounded-md border border-border bg-muted/30 p-4 text-xs text-muted-foreground">
                      Install an MCP server before configuring sandbox access.
                    </div>
                  ) : servers.map((server) => {
                    const expanded = openSecurityServers[server.id] !== false
                    return (
                      <div key={server.id} className="rounded-md border border-border bg-muted/30">
                        <button
                          type="button"
                          onClick={() => setOpenSecurityServers((current) => ({ ...current, [server.id]: !expanded }))}
                          className="flex w-full items-start justify-between gap-4 p-4 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                          aria-expanded={expanded}
                        >
                          <span className="min-w-0">
                            <span className="flex items-center gap-2">
                              <span className="truncate text-sm font-mono font-semibold text-foreground">{server.name}</span>
                              <Badge variant="outline" className={server.enabled ? "text-primary border-primary text-[10px]" : "text-muted-foreground text-[10px]"}>
                                {server.enabled ? "enabled" : "disabled"}
                              </Badge>
                            </span>
                            <span className="mt-2 block break-all font-mono text-[11px] text-muted-foreground">{server.command} {server.args.join(" ")}</span>
                          </span>
                          <span className="text-sm text-foreground">{expanded ? "-" : "+"}</span>
                        </button>

                        {expanded && (
                          <div className="border-t border-border p-4">
                            <div className="flex gap-2 max-sm:[&>button]:flex-1">
                              <Button onClick={() => setServerEnabled(server, true)} disabled={saving || server.enabled} variant="outline" size="sm">Enable</Button>
                              <Button onClick={() => setServerEnabled(server, false)} disabled={saving || !server.enabled} variant="outline" size="sm">Disable</Button>
                            </div>
                            <div className="mt-4 grid grid-cols-1 gap-3 lg:grid-cols-[240px_minmax(0,1fr)]">
                              <div className="space-y-2">
                                <FieldLabel>Availability</FieldLabel>
                                <select value={server.accessMode} onChange={(event) => syncAccessModeChange(server, event.target.value)} disabled={saving} className={selectCls + " text-xs uppercase tracking-wider"}>
                                  <option value="disabled">Disabled</option>
                                  <option value="allow_all">Allow All</option>
                                  <option value="allow_only">Allow Only</option>
                                </select>
                              </div>
                              <div className={server.accessMode === "allow_only" ? "space-y-2" : "opacity-50"}>
                                <FieldLabel>Allowed Sandboxes</FieldLabel>
                                {sandboxes.length === 0 ? (
                                  <div className="rounded-md border border-border bg-background p-3 text-xs text-muted-foreground">No sandboxes detected.</div>
                                ) : (
                                  <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
                                    {sandboxes.map((sandbox) => (
                                      <label key={sandbox.id} className="flex items-center justify-between gap-3 rounded-md border border-border bg-background p-3 text-xs">
                                        <span className="min-w-0">
                                          <span className="block truncate font-mono text-foreground">{sandbox.name}</span>
                                          <span className="mt-1 block truncate text-[10px] uppercase tracking-wider text-muted-foreground">{sandbox.status}</span>
                                        </span>
                                        <input type="checkbox" checked={sandboxAllowed(server, sandbox)} disabled={saving || server.accessMode !== "allow_only"} onChange={(event) => toggleServerSandbox(server, sandbox, event.target.checked)} className="h-4 w-4" />
                                      </label>
                                    ))}
                                  </div>
                                )}
                              </div>
                            </div>
                          </div>
                        )}
                      </div>
                    )
                  })}
                </div>
              )}
            </Card>

            <Card className="p-6">
              <button
                type="button"
                onClick={() => setRepoOpen((open) => !open)}
                className="flex w-full items-center justify-between gap-4 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                aria-expanded={repoOpen}
              >
                <div>
                  <h2 className="text-sm font-semibold uppercase tracking-wider">MCP Repo Search and Preconfigured Servers</h2>
                  <p className="mt-1 text-xs text-muted-foreground">Choose a registry, search installable MCP servers, or install a preset.</p>
                </div>
                <span className={accordionToggle}>{repoOpen ? "-" : "+"}</span>
              </button>
              {repoOpen && (
                <div className="mt-5 space-y-5 border-t border-border pt-5">
                  <div className="space-y-3">
                    <div className="flex items-center justify-between gap-3">
                      <FieldLabel>Available Registries</FieldLabel>
                      {selectedRegistry && (
                        <a href={selectedRegistry.baseUrl} target="_blank" rel="noreferrer" className="text-[11px] font-mono uppercase tracking-wider text-primary hover:underline">Open</a>
                      )}
                    </div>
                    {registries.length === 0 ? (
                      <div className="rounded-md border border-border bg-muted/30 p-4 text-xs text-muted-foreground">Add an MCP Registry</div>
                    ) : (
                      <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
                        {registries.map((registry) => {
                          const selected = registry.id === selectedRegistryId
                          return (
                            <button
                              key={registry.id}
                              type="button"
                              onClick={() => { setSelectedRegistryId(registry.id); setRegistryResults([]) }}
                              className={`rounded-md border p-3 text-left transition-colors ${selected ? "border-primary bg-primary/10" : "border-border bg-background hover:border-primary"}`}
                            >
                              <span className="block truncate text-xs font-mono font-semibold text-foreground">{registry.name}</span>
                              <span className="mt-1 block truncate text-[11px] text-muted-foreground">{registry.baseUrl}</span>
                            </button>
                          )
                        })}
                      </div>
                    )}
                    {selectedRegistry && (
                      <Button onClick={() => deleteRegistry(selectedRegistry)} disabled={saving} variant="outline" size="sm">Delete Selected Registry</Button>
                    )}
                  </div>

                  <div className="rounded-md border border-border bg-muted/30 p-4">
                    <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                      <div className="space-y-2">
                        <div className="flex items-center gap-2"><FieldLabel>Registry Name</FieldLabel><FieldHint>Name shown in the registry selector.</FieldHint></div>
                        <input value={registryName} onChange={(event) => setRegistryName(event.target.value)} placeholder="Company MCP Repo" className={inputCls} />
                      </div>
                      <div className="space-y-2">
                        <div className="flex items-center gap-2"><FieldLabel>Registry URL</FieldLabel><FieldHint>Root URL for a registry that exposes /v0/servers.</FieldHint></div>
                        <input value={registryUrl} onChange={(event) => setRegistryUrl(event.target.value)} placeholder="https://registry.example.com" className={inputCls} />
                      </div>
                      <div className="space-y-2 md:col-span-2">
                        <div className="flex items-center gap-2"><FieldLabel>LLM Registry Assist</FieldLabel><FieldHint>Describe a registry and the running LLM endpoint drafts the fields.</FieldHint></div>
                        <textarea value={registryPrompt} onChange={(event) => setRegistryPrompt(event.target.value)} rows={3} placeholder="Add the Acme internal MCP registry at https://mcp.acme.example" className={textareaCls} />
                      </div>
                      <div className="space-y-2 md:col-span-2">
                        <div className="flex items-center gap-2"><FieldLabel>Description</FieldLabel><FieldHint>Short operator-facing note for this registry.</FieldHint></div>
                        <input value={registryDescription} onChange={(event) => setRegistryDescription(event.target.value)} className={inputCls} />
                      </div>
                    </div>
                    <div className="mt-3 flex flex-wrap gap-2">
                      <Button onClick={assistRegistry} disabled={saving || (!registryPrompt.trim() && !registryUrl.trim())} variant="outline" size="sm">Draft With LLM</Button>
                      <Button onClick={saveRegistry} disabled={saving || !registryUrl.trim()} size="sm">Add Registry</Button>
                    </div>
                  </div>

                  <div className="flex gap-3 max-sm:flex-col">
                    <input value={registrySearch} onChange={(event) => setRegistrySearch(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") searchRegistry() }} placeholder="Search GitHub, Slack, filesystem, Postgres..." className={inputCls + " flex-1 min-w-0"} />
                    <Button onClick={searchRegistry} disabled={registryLoading || saving || !selectedRegistry} size="sm">
                      {registryLoading ? "Searching..." : "Search"}
                    </Button>
                  </div>
                  {registryResults.length > 0 && (
                    <>
                      <div className="flex items-center justify-between gap-3 border-t border-border pt-4 max-sm:flex-col max-sm:items-start">
                        <p className="text-xs text-muted-foreground">
                          Showing {((registryPage - 1) * REGISTRY_PAGE_SIZE) + 1}-{Math.min(registryPage * REGISTRY_PAGE_SIZE, registryResults.length)} of {registryResults.length}
                          {lastRegistrySearch ? ` for "${lastRegistrySearch}"` : ""}{selectedRegistry ? ` in ${selectedRegistry.name}` : ""}
                        </p>
                        <div className="flex items-center gap-2">
                          <Button onClick={() => setRegistryPage((page) => Math.max(1, page - 1))} disabled={registryPage === 1} variant="outline" size="sm">Prev</Button>
                          <span className="min-w-16 text-center text-xs font-mono text-muted-foreground">{registryPage} / {registryPageCount}</span>
                          <Button onClick={() => setRegistryPage((page) => Math.min(registryPageCount, page + 1))} disabled={registryPage === registryPageCount} variant="outline" size="sm">Next</Button>
                        </div>
                      </div>
                      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                        {pagedRegistryResults.map((entry, index) => {
                          const installed = installedIds.has(entry.id)
                          return (
                            <div key={`${entry.id}-${entry.command}-${entry.args.join("|")}-${index}`} className="rounded-md border border-border bg-muted/30 flex min-h-44 flex-col p-4">
                              <div className="flex items-start justify-between gap-3">
                                <div className="min-w-0">
                                  <h3 className="truncate text-sm font-semibold text-foreground">{entry.name}</h3>
                                  <p className="mt-2 text-xs leading-5 text-muted-foreground">{entry.summary}</p>
                                </div>
                                <Badge variant="outline" className="text-muted-foreground text-[10px] shrink-0">{entry.transport}</Badge>
                              </div>
                              <div className="mt-3 min-w-0 rounded-md border border-border bg-background p-2 font-mono text-[11px] text-muted-foreground">
                                <span className="text-foreground">{entry.command}</span> {entry.args.join(" ")}
                              </div>
                              <div className="mt-auto flex items-center justify-between gap-3 pt-4">
                                <p className="truncate text-[10px] uppercase tracking-wider text-muted-foreground">{entry.tags.join(" / ")}</p>
                                <Button onClick={() => postUpdate({ action: "install", ...entry, source: "registry" }, installed ? `${entry.name} refreshed from registry.` : `${entry.name} installed from registry.`)} disabled={saving} variant={installed ? "outline" : "default"} size="sm">
                                  {installed ? "Refresh" : "Install"}
                                </Button>
                              </div>
                            </div>
                          )
                        })}
                      </div>
                    </>
                  )}

                  <button type="button" onClick={() => setCatalogOpen((open) => !open)} className="flex w-full items-center justify-between gap-4 border-t border-border pt-5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" aria-expanded={catalogOpen}>
                    <div>
                      <h3 className="text-sm font-semibold uppercase tracking-wider">Preconfigured Servers</h3>
                      <p className="mt-1 text-xs text-muted-foreground">Presets install as MCP command definitions; clients start them when needed.</p>
                    </div>
                    <span className="text-sm text-foreground">{catalogOpen ? "-" : "+"}</span>
                  </button>
                  {catalogOpen && (
                    <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                      {catalog.map((entry) => {
                        const installed = installedIds.has(entry.id)
                        return (
                          <div key={entry.id} className="rounded-md border border-border bg-muted/30 flex min-h-44 flex-col p-4">
                            <div className="flex items-start justify-between gap-3">
                              <div>
                                <h3 className="text-sm font-semibold uppercase tracking-wider text-foreground">{entry.name}</h3>
                                <p className="mt-2 text-xs leading-5 text-muted-foreground">{entry.summary}</p>
                                {entry.websiteUrl && <a href={entry.websiteUrl} target="_blank" rel="noreferrer" className="mt-2 inline-block text-[11px] font-mono uppercase tracking-wider text-primary hover:underline">Setup Guide</a>}
                              </div>
                              <Badge variant="outline" className="text-muted-foreground text-[10px] shrink-0">{entry.transport}</Badge>
                            </div>
                            <div className="mt-3 min-w-0 rounded-md border border-border bg-background p-2 font-mono text-[11px] text-muted-foreground">
                              <span className="text-foreground">{entry.command}</span> {entry.args.join(" ")}
                            </div>
                            <div className="mt-auto flex items-center justify-between gap-3 pt-4">
                              <p className="truncate text-[10px] uppercase tracking-wider text-muted-foreground">{entry.tags.join(" / ")}</p>
                              <Button onClick={() => postUpdate({ action: "install", id: entry.id }, installed ? `${entry.name} refreshed.` : `${entry.name} installed.`)} disabled={saving} variant={installed ? "outline" : "default"} size="sm">
                                {installed ? "Refresh" : "Install"}
                              </Button>
                            </div>
                          </div>
                        )
                      })}
                    </div>
                  )}
                </div>
              )}
            </Card>

            <Card className="p-6">
              <button
                type="button"
                onClick={() => setCustomOpen((open) => !open)}
                className="flex w-full items-center justify-between gap-4 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                aria-expanded={customOpen}
              >
                <div>
                  <h2 className="text-sm font-semibold uppercase tracking-wider">Server Install Wizard</h2>
                  <p className="mt-1 text-xs text-muted-foreground">Install a command, HTTP endpoint, or uploaded MCP bundle with assisted preflight repair.</p>
                </div>
                <span className={accordionToggle}>{customOpen ? "-" : "+"}</span>
              </button>
              {customOpen && (
                <div className="mt-5 border-t border-border pt-5">
                  <div className="mb-5 grid grid-cols-2 gap-2 md:grid-cols-4">
                    {WIZARD_STEPS.map((step) => (
                      <button
                        key={step}
                        type="button"
                        onClick={() => setWizardStep(step)}
                        className={`rounded-md border px-3 py-2 text-xs font-mono uppercase tracking-wider transition-colors ${wizardStep === step ? "border-primary bg-primary/10 text-foreground" : "border-border bg-background text-muted-foreground hover:border-primary"}`}
                      >
                        {WIZARD_STEP_LABELS[step]}
                      </button>
                    ))}
                  </div>

                  {wizardStep === "upload" && (
                    <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                      <div className="space-y-2">
                        <div className="flex items-center gap-2"><FieldLabel>Server Name</FieldLabel><FieldHint>Stable display name and default id for this uploaded MCP server.</FieldHint></div>
                        <input value={customName} onChange={(event) => { setCustomName(event.target.value); resetWizardPreflightState() }} className={inputCls} />
                      </div>
                      <div className="space-y-2">
                        <div className="flex items-center gap-2"><FieldLabel>Summary</FieldLabel><FieldHint>Short note shown in the installed server list.</FieldHint></div>
                        <input value={customSummary} onChange={(event) => { setCustomSummary(event.target.value); resetWizardPreflightState() }} className={inputCls} />
                      </div>
                      <div className="flex flex-wrap items-center gap-3 md:col-span-2">
                        <Button asChild variant="outline" size="sm" className="cursor-pointer">
                          <label>
                            Choose Directory
                            <input type="file" multiple onChange={(event) => chooseUploadDirectory(event.target.files)} className="sr-only" {...({ webkitdirectory: "", directory: "" } as Record<string, string>)} />
                          </label>
                        </Button>
                        <Button asChild variant="outline" size="sm" className="cursor-pointer">
                          <label>
                            Choose Archive
                            <input type="file" accept=".zip,.tgz,.tar.gz,.tar,application/zip,application/gzip,application/x-tar" onChange={(event) => chooseUploadArchive(event.target.files?.[0] || null)} className="sr-only" />
                          </label>
                        </Button>
                        {(uploadArchive || uploadFiles.length > 0) && (
                          <span className="text-xs font-mono text-muted-foreground">
                            {uploadArchive ? uploadArchive.name : `${uploadFiles.length} file${uploadFiles.length === 1 ? "" : "s"}`}
                          </span>
                        )}
                      </div>
                      {stagedUpload && (
                        <div className="rounded-md border border-primary/40 bg-primary/10 p-3 text-xs text-primary md:col-span-2">
                          <div>Uploaded to staged server workspace: {stagedUpload.name}</div>
                          <div className="mt-2 font-mono text-[11px]">Detected {stagedUpload.runtime} / {stagedUpload.entryMode} / {stagedUpload.entrypoint}</div>
                        </div>
                      )}
                    </div>
                  )}

                  {wizardStep === "preflight" && (
                    <div className="space-y-4">
                      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                        <div className="space-y-2">
                          <div className="flex items-center gap-2"><FieldLabel>LLM Repair</FieldLabel><FieldHint>When preflight fails, ask the configured primary inference model for a bounded repair and run preflight again.</FieldHint></div>
                          <label className="flex min-h-10 items-center justify-between gap-3 rounded-md border border-border bg-background px-3 py-2 text-xs text-foreground">
                            <span>Attempt repairs on failures</span>
                            <input type="checkbox" checked={uploadRepair} onChange={(event) => setUploadRepair(event.target.checked)} className="h-4 w-4" />
                          </label>
                        </div>
                        <div className="space-y-2">
                          <div className="flex items-center gap-2"><FieldLabel>Inference Route</FieldLabel><FieldHint>Optional sandbox whose configured primary inference model should be used for preflight repair assistance.</FieldHint></div>
                          <select value={repairSandboxId} onChange={(event) => setRepairSandboxId(event.target.value)} disabled={!uploadRepair} className={selectCls}>
                            <option value="">Default configured inference model</option>
                            {sandboxes.map((sandbox) => <option key={sandbox.id} value={sandbox.id}>{sandbox.name}</option>)}
                          </select>
                        </div>
                      </div>
                      <Button onClick={startWizardPreflightChecks} disabled={saving || !stagedUpload} size="sm">
                        {saving ? "Running Preflight..." : "Start Preflight checks"}
                      </Button>
                      {!stagedUpload && (
                        <div className="rounded-md border border-border bg-muted/30 p-4 text-xs text-muted-foreground">Upload server files before starting preflight checks.</div>
                      )}
                      {wizardDependencyInstall && (
                        <div className="rounded-md border border-border bg-background p-4">
                          <h3 className="text-xs font-semibold uppercase tracking-wider">Dependency Bootstrap</h3>
                          <p className="mt-2 text-xs text-muted-foreground">{wizardDependencyInstall.kind || "generic"} bootstrap{wizardDependencyInstall.logs?.length ? `, ${wizardDependencyInstall.logs.length} log item${wizardDependencyInstall.logs.length === 1 ? "" : "s"}` : ""}.</p>
                        </div>
                      )}
                      {wizardPreflight && (
                        <div className={`rounded-md border p-4 text-xs ${wizardPreflight.ok ? "border-primary/40 bg-primary/10 text-primary" : "border-destructive/40 bg-destructive/10 text-destructive"}`}>
                          <div className="font-mono uppercase tracking-wider">Preflight {wizardPreflight.ok ? "passed" : "found failures"} / {wizardPreflight.durationMs} ms</div>
                          <p className="mt-2 whitespace-pre-wrap text-[11px] leading-5">{summarizePreflight(wizardPreflight)}{summarizeRepair(wizardRepair)}</p>
                        </div>
                      )}
                    </div>
                  )}

                  {wizardStep === "review" && (
                    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
                      <div className="rounded-md border border-border bg-background p-4">
                        <h3 className="text-xs font-semibold uppercase tracking-wider">Staged Upload</h3>
                        <pre className="mt-3 overflow-auto text-[11px] leading-5 text-muted-foreground">{JSON.stringify({
                          selectedBundle: uploadArchive?.name || (uploadFiles.length > 0 ? `${uploadFiles.length} files` : stagedUpload?.selectedBundle || "staged"),
                          stagedUpload, dependencyInstall: wizardDependencyInstall,
                          preflight: wizardPreflight ? { ok: wizardPreflight.ok, toolCount: wizardPreflight.toolCount, tools: wizardPreflight.tools, error: wizardPreflight.error || null } : null,
                          repair: wizardRepair,
                        }, null, 2)}</pre>
                      </div>
                      <div className="rounded-md border border-border bg-background p-4">
                        <h3 className="text-xs font-semibold uppercase tracking-wider">Broker Launch Definition</h3>
                        <pre className="mt-3 overflow-auto text-[11px] leading-5 text-muted-foreground">{JSON.stringify(wizardCandidate || { status: "Run preflight checks to generate the launch definition." }, null, 2)}</pre>
                      </div>
                    </div>
                  )}

                  {wizardStep === "install" && (
                    <div className="space-y-4">
                      <div className="rounded-md border border-border bg-background p-4">
                        <h3 className="text-xs font-semibold uppercase tracking-wider">Ready To Install</h3>
                        <p className="mt-2 text-xs leading-5 text-muted-foreground">
                          {wizardCandidate
                            ? `${wizardCandidate.name} will be installed ${wizardPreflight?.ok ? "enabled" : "disabled until preflight passes"}.`
                            : "Run preflight checks before installing this MCP server."}
                        </p>
                      </div>
                      <Button onClick={installStagedUpload} disabled={saving || !wizardCandidate || Boolean(wizardInstallResult)} size="sm">
                        {wizardInstallResult ? "Installed" : saving ? "Installing..." : "Install Server"}
                      </Button>
                      {wizardInstallResult && (
                        <div className="rounded-md border border-primary/40 bg-primary/10 p-4 text-xs text-primary">
                          {wizardInstallResult.name} installed successfully.
                        </div>
                      )}
                    </div>
                  )}

                  <div className="mt-5 flex flex-wrap items-center gap-3">
                    <Button onClick={cancelWizardWorkflow} disabled={saving || (!hasUploadBundle && !stagedUpload && !wizardPreflight && !wizardCandidate)} variant="outline" size="sm">Cancel</Button>
                    <Button onClick={previousWizardStep} disabled={saving || wizardStepIndex === 0} variant="outline" size="sm">Back</Button>
                    <Button onClick={handleWizardNext} disabled={saving || wizardStepIndex === WIZARD_STEPS.length - 1 || (wizardStep === "upload" && !hasUploadBundle && !stagedUpload)} variant="outline" size="sm">Next</Button>
                  </div>
                </div>
              )}
            </Card>
          </section>

          <aside className="space-y-6">
            <Card className="p-6">
              <h2 className="text-sm font-semibold uppercase tracking-wider">Installed Servers</h2>
              <div className="mt-4 space-y-3">
                {servers.length === 0 ? (
                  <div className="rounded-md border border-border bg-muted/30 p-4 text-xs text-muted-foreground">No MCP servers installed yet.</div>
                ) : servers.map((server) => (
                  <div key={server.id} className="rounded-md border border-border bg-muted/30 p-4">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <h3 className="truncate text-sm font-mono font-semibold text-foreground">{server.name}</h3>
                        <p className="mt-1 text-[11px] text-muted-foreground">{server.source} / {server.transport}</p>
                      </div>
                      <Badge variant="outline" className={server.enabled ? "text-primary border-primary text-[10px] shrink-0" : "text-muted-foreground text-[10px] shrink-0"}>
                        {server.enabled ? "enabled" : "disabled"}
                      </Badge>
                    </div>
                    <p className="mt-3 break-all font-mono text-[11px] text-muted-foreground">{server.command} {server.args.join(" ")}</p>
                    <div className="mt-4 flex gap-2">
                      <Button onClick={() => startEditingServer(server)} disabled={saving} variant="outline" size="sm" className="flex-1">Edit</Button>
                      <Button onClick={() => preflightServer(server)} disabled={saving} variant="outline" size="sm" className="flex-1">Preflight</Button>
                      <Button onClick={() => setServerEnabled(server, !server.enabled)} disabled={saving} variant="outline" size="sm" className="flex-1">{server.enabled ? "Disable" : "Enable"}</Button>
                      <Button onClick={() => postUpdate({ action: "uninstall", serverId: server.id }, `${server.name} removed.`)} disabled={saving} variant="outline" size="sm" className="flex-1">Remove</Button>
                    </div>
                    {preflightResults[server.id] && (
                      <div className={`mt-4 rounded-md border p-3 text-xs ${preflightResults[server.id].ok ? "border-primary/40 bg-primary/10 text-primary" : "border-destructive/40 bg-destructive/10 text-destructive"}`}>
                        <div className="font-mono uppercase tracking-wider">Preflight {preflightResults[server.id].ok ? "passed" : "failed"} / {preflightResults[server.id].durationMs} ms</div>
                        <p className="mt-2 whitespace-pre-wrap text-[11px] leading-5">{summarizePreflight(preflightResults[server.id])}</p>
                      </div>
                    )}
                    {editingServerId === server.id && (
                      <div className="mt-4 border-t border-border pt-4">
                        <div className="flex items-center justify-between gap-3">
                          <FieldLabel>Server JSON</FieldLabel>
                          <div className="flex gap-2">
                            <Button onClick={() => { setEditingServerId(null); setEditorText("") }} disabled={saving} variant="outline" size="sm">Cancel</Button>
                            <Button onClick={saveEditedServer} disabled={saving || !editorText.trim()} size="sm">Save</Button>
                          </div>
                        </div>
                        <textarea
                          value={editorText}
                          onChange={(event) => setEditorText(event.target.value)}
                          rows={16}
                          spellCheck={false}
                          className={textareaCls + " mt-3 min-h-80 text-xs leading-5"}
                        />
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </Card>

            <Card className="p-6">
              <h2 className="text-sm font-semibold uppercase tracking-wider">Client JSON</h2>
              <p className="mt-1 text-xs text-muted-foreground">Enabled servers exported in common MCP client format.</p>
              <pre className="mt-4 max-h-96 overflow-auto rounded-md border border-border bg-background p-4 text-[11px] leading-5 text-muted-foreground">
                {configText}
              </pre>
            </Card>
          </aside>
        </div>
      )}
    </div>
  )
}
