"use client"

import { useEffect, useMemo, useState } from "react"
import { Button } from "@/app/components/ui/button"
import { Input } from "@/app/components/ui/input"
import { Badge } from "@/app/components/ui/badge"
import { Card } from "@/app/components/ui/card"
import type { SandboxInventoryItem } from "../hooks/inventoryModel"

type BlueprintOption = {
  id: string
  label: string
  description: string
  type?: "blueprint" | "custom" | "image"
  supportsTailscale?: boolean
  baseline?: { name: string; available: boolean }
}

type WizardStep = "source" | "target" | "options" | "review" | "run"
type ControllerDeployMode = "manual" | "auto"

type ControllerPlan = {
  controller: {
    name: string
    url: string
    host: string
    dashboardPort: number
    terminalPort: number
    installDir: string
    parentControllerUrl: string
  }
  env: string
  commands: {
    ssh: string
    localBootstrap: string
    start: string
    terminal: string
  }
  checks: string[]
}

const steps: Array<{ key: WizardStep; label: string }> = [
  { key: "source", label: "Source" },
  { key: "target", label: "Target" },
  { key: "options", label: "Options" },
  { key: "review", label: "Review" },
  { key: "run", label: "Run" },
]

function contentDispositionFileName(value: string | null, fallback: string) {
  const header = value || ""
  return decodeURIComponent(header.match(/filename\*=UTF-8''([^;]+)/)?.[1] || "")
    || header.match(/filename="([^"]+)"/)?.[1]
    || fallback
}

function defaultCloneName(source?: SandboxInventoryItem) {
  if (!source) return ""
  return `${source.name.replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "")}-clone`.slice(0, 63)
}

const inputCls = "w-full rounded-md border border-input bg-background px-3 py-2 text-xs font-mono text-foreground focus:outline-none focus:ring-1 focus:ring-ring"

export default function WizardPanel({
  sandboxes,
  onInventoryRefresh,
}: {
  sandboxes: SandboxInventoryItem[]
  onInventoryRefresh: () => Promise<SandboxInventoryItem[]>
}) {
  const [activeStep, setActiveStep] = useState<WizardStep>("source")
  const [sourceSandboxId, setSourceSandboxId] = useState("")
  const [targetName, setTargetName] = useState("")
  const [blueprints, setBlueprints] = useState<BlueprintOption[]>([])
  const [selectedBlueprint, setSelectedBlueprint] = useState("redeploy-image")
  const [enableTailscale, setEnableTailscale] = useState(false)
  const [backupPath, setBackupPath] = useState("/sandbox")
  const [restorePath, setRestorePath] = useState("/sandbox")
  const [replaceTarget, setReplaceTarget] = useState(true)
  const [running, setRunning] = useState(false)
  const [message, setMessage] = useState("")
  const [runLog, setRunLog] = useState<string[]>([])
  const [controllerName, setControllerName] = useState("remote-controller")
  const [controllerHost, setControllerHost] = useState("")
  const [sshTarget, setSshTarget] = useState("")
  const [installDir, setInstallDir] = useState("/opt/openshell-control")
  const [repoUrl, setRepoUrl] = useState("https://github.com/mmckeen-nv/openshell_controller.git")
  const [dashboardPort, setDashboardPort] = useState("3000")
  const [terminalPort, setTerminalPort] = useState("3011")
  const [openClawDashboardUrl, setOpenClawDashboardUrl] = useState("http://127.0.0.1:18789/")
  const [openshellGateway, setOpenshellGateway] = useState("nemoclaw")
  const [exposePublicly, setExposePublicly] = useState(false)
  const [parentControllerUrl, setParentControllerUrl] = useState("http://localhost:3000")
  const [controllerDeployMode, setControllerDeployMode] = useState<ControllerDeployMode>("manual")
  const [remotePort, setRemotePort] = useState("22")
  const [remoteUser, setRemoteUser] = useState("")
  const [remotePassword, setRemotePassword] = useState("")
  const [allowSudo, setAllowSudo] = useState(false)
  const [acceptUnknownHostKey, setAcceptUnknownHostKey] = useState(false)
  const [expectedHostKeySha256, setExpectedHostKeySha256] = useState("")
  const [controllerPlan, setControllerPlan] = useState<ControllerPlan | null>(null)
  const [controllerMessage, setControllerMessage] = useState("")
  const [controllerPlanning, setControllerPlanning] = useState(false)
  const [controllerDeploying, setControllerDeploying] = useState(false)
  const [controllerDeployLog, setControllerDeployLog] = useState("")
  const [controllerWizardOpen, setControllerWizardOpen] = useState(true)
  const [cloneWizardOpen, setCloneWizardOpen] = useState(false)

  const sourceSandbox = useMemo(
    () => sandboxes.find((sandbox) => sandbox.id === sourceSandboxId) || null,
    [sandboxes, sourceSandboxId],
  )
  const activeBlueprint = blueprints.find((blueprint) => blueprint.id === selectedBlueprint)
  const activeIndex = steps.findIndex((step) => step.key === activeStep)

  useEffect(() => {
    fetch("/api/sandbox/create", { cache: "no-store" })
      .then((response) => response.json())
      .then((data) => {
        if (Array.isArray(data?.blueprints)) setBlueprints(data.blueprints)
      })
      .catch(() => {})
  }, [])

  useEffect(() => {
    if (typeof window === "undefined") return
    setParentControllerUrl(window.location.origin)
  }, [])

  useEffect(() => {
    if (!sourceSandboxId && sandboxes[0]) {
      setSourceSandboxId(sandboxes[0].id)
    }
  }, [sandboxes, sourceSandboxId])

  useEffect(() => {
    if (!targetName && sourceSandbox) {
      setTargetName(defaultCloneName(sourceSandbox))
    }
  }, [sourceSandbox, targetName])

  const canContinue = (() => {
    if (activeStep === "source") return Boolean(sourceSandbox)
    if (activeStep === "target") return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(targetName) && targetName.length <= 63
    if (activeStep === "options") return Boolean(backupPath.trim() && restorePath.trim())
    if (activeStep === "review") return Boolean(sourceSandbox && targetName.trim())
    return false
  })()

  const goNext = () => {
    const next = steps[activeIndex + 1]
    if (next) setActiveStep(next.key)
  }

  const goBack = () => {
    const previous = steps[activeIndex - 1]
    if (previous) setActiveStep(previous.key)
  }

  const appendLog = (line: string) => {
    setRunLog((current) => [...current, line])
  }

  async function runCloneWizard() {
    if (!sourceSandbox || running) return
    try {
      setRunning(true)
      setMessage("")
      setRunLog([])
      setActiveStep("run")

      appendLog(selectedBlueprint === "redeploy-image" ? `Redeploying ${sourceSandbox.name}'s image as ${targetName}...` : `Creating target sandbox ${targetName}...`)
      const createResponse = await fetch("/api/sandbox/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          blueprint: selectedBlueprint,
          sandboxName: targetName.trim(),
          sourceSandboxName: sourceSandbox.name,
          enableTailscale,
          policy: null,
          preset: null,
        }),
      })
      const createData = await createResponse.json()
      if (!createResponse.ok) {
        throw new Error([createData.error, createData.verification?.summary, createData.verification?.error, createData.stdout, createData.stderr].filter(Boolean).join("\n\n") || "Failed to create target sandbox")
      }
      const createdSandboxId = createData.verification?.details?.id || createData.verification?.details?.name || createData.sandboxName
      appendLog(`Target sandbox ready: ${createdSandboxId}.`)

      appendLog(`Backing up ${sourceSandbox.name}:${backupPath.trim()}...`)
      const backupResponse = await fetch(`/api/sandbox/${encodeURIComponent(sourceSandbox.id)}/backup?${new URLSearchParams({ path: backupPath.trim() })}`)
      if (!backupResponse.ok) {
        const data = await backupResponse.json().catch(() => ({}))
        throw new Error(data.error || "Failed to create source backup")
      }
      const backupBlob = await backupResponse.blob()
      const backupFileName = contentDispositionFileName(backupResponse.headers.get("content-disposition"), `${sourceSandbox.name}-backup.tar.gz`)
      appendLog(`Backup captured: ${backupFileName} (${Math.ceil(backupBlob.size / 1024)} KiB).`)

      appendLog(`Restoring backup into ${createdSandboxId}:${restorePath.trim()}...`)
      const form = new FormData()
      form.set("archive", new File([backupBlob], backupFileName, { type: "application/gzip" }))
      form.set("targetPath", restorePath.trim())
      form.set("replace", replaceTarget ? "true" : "false")
      const restoreResponse = await fetch(`/api/sandbox/${encodeURIComponent(createdSandboxId)}/restore`, {
        method: "POST",
        body: form,
      })
      const restoreData = await restoreResponse.json()
      if (!restoreResponse.ok) throw new Error(restoreData.error || "Failed to restore backup into target sandbox")
      appendLog(restoreData.note || "Restore complete.")

      appendLog("Refreshing inventory...")
      await onInventoryRefresh()
      setMessage(`Clone complete: ${sourceSandbox.name} -> ${targetName.trim()}.`)
    } catch (error) {
      const text = error instanceof Error ? error.message : "Clone wizard failed"
      appendLog(text)
      setMessage(text)
    } finally {
      setRunning(false)
    }
  }

  async function generateControllerPlan() {
    try {
      setControllerPlanning(true)
      setControllerMessage("")
      setControllerPlan(null)

      const response = await fetch("/api/controller-node/plan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          controllerName,
          controllerHost,
          sshTarget,
          installDir,
          repoUrl,
          dashboardPort,
          terminalPort,
          openClawDashboardUrl,
          openshellGateway,
          exposePublicly,
          parentControllerUrl,
        }),
      })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || "Failed to generate controller node plan")
      setControllerPlan(data)
      window.dispatchEvent(new Event("controller-nodes-changed"))
      setControllerMessage(`Launch kit ready for ${data.controller.url}.`)
    } catch (error) {
      setControllerMessage(error instanceof Error ? error.message : "Failed to generate controller node plan")
    } finally {
      setControllerPlanning(false)
    }
  }

  async function autodeployControllerNode() {
    try {
      setControllerDeploying(true)
      setControllerMessage("")
      setControllerDeployLog("")

      const response = await fetch("/api/controller-node/deploy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          controllerName,
          controllerHost,
          sshTarget,
          installDir,
          repoUrl,
          dashboardPort,
          terminalPort,
          openClawDashboardUrl,
          openshellGateway,
          exposePublicly,
          parentControllerUrl,
          remoteHost: controllerHost,
          remotePort,
          remoteUser,
          remotePassword,
          allowSudo,
          acceptUnknownHostKey,
          expectedHostKeySha256,
        }),
      })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || "Autodeploy failed")
      setControllerPlan((current) => current ?? data)
      setControllerDeployLog([data.note, data.hostKeySha256 ? `Host key SHA256: ${data.hostKeySha256}` : "", data.stdout, data.stderr].filter(Boolean).join("\n\n"))
      setRemotePassword("")
      window.dispatchEvent(new Event("controller-nodes-changed"))
      setControllerMessage(`Autodeploy complete for ${data.controller?.url || controllerHost}.`)
    } catch (error) {
      setControllerMessage(error instanceof Error ? error.message : "Autodeploy failed")
    } finally {
      setControllerDeploying(false)
    }
  }

  async function copyText(value: string, label: string) {
    try {
      await navigator.clipboard.writeText(value)
      setControllerMessage(`${label} copied.`)
    } catch {
      setControllerMessage("Clipboard access was blocked. Select the command text manually.")
    }
  }

  return (
    <div className="space-y-6">
      <Card className="p-8">
        <p className="text-[10px] font-mono uppercase tracking-wider text-primary">Guided Tasks</p>
        <h1 className="mt-2 text-xl font-semibold uppercase tracking-wider">Wizards</h1>
        <p className="mt-2 max-w-3xl text-sm text-muted-foreground">
          Step-by-step workflows for common operations, including remote controller bootstrap and sandbox cloning.
        </p>
      </Card>

      <Card className="overflow-hidden">
        <button
          type="button"
          onClick={() => setControllerWizardOpen((open) => !open)}
          aria-expanded={controllerWizardOpen}
          className="flex w-full items-center justify-between gap-4 border-b border-border p-5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring max-md:items-start"
        >
          <div className="flex min-w-0 items-start gap-4">
            <svg
              className={`mt-1 h-4 w-4 shrink-0 text-muted-foreground transition-transform ${controllerWizardOpen ? "rotate-90" : ""}`}
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
              aria-hidden="true"
            >
              <path strokeLinecap="square" strokeLinejoin="miter" strokeWidth={2} d="M9 5l7 7-7 7" />
            </svg>
            <div>
              <h2 className="text-sm font-semibold uppercase tracking-wider">Spawn a Controller Node</h2>
              <p className="mt-1 text-xs text-muted-foreground">Prepare a remote VPS to run OpenShell Control near another OpenShell gateway or sandbox host.</p>
            </div>
          </div>
          <Badge variant="outline" className="shrink-0 font-mono text-[10px] text-muted-foreground">
            {controllerDeployMode === "auto" ? "autodeploy" : "manual deploy"}
          </Badge>
        </button>

        {controllerWizardOpen && <div className="grid grid-cols-1 gap-5 p-5 xl:grid-cols-[minmax(0,1fr)_minmax(360px,0.8fr)]">
          <div className="space-y-5">
            <div className="grid grid-cols-2 gap-2 rounded-md border border-border bg-muted/30 p-1">
              {(["manual", "auto"] as ControllerDeployMode[]).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  onClick={() => setControllerDeployMode(mode)}
                  className={`rounded-sm px-3 py-2 text-xs font-mono uppercase tracking-wider ${
                    controllerDeployMode === mode
                      ? "bg-primary text-primary-foreground"
                      : "text-muted-foreground hover:bg-background"
                  }`}
                >
                  {mode === "manual" ? "Manual Deploy" : "Autodeploy"}
                </button>
              ))}
            </div>
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <label className="block space-y-1.5">
                <span className="text-[10px] uppercase tracking-wider text-muted-foreground">Controller Name</span>
                <input value={controllerName} onChange={(event) => setControllerName(event.target.value)} className={inputCls} />
              </label>
              <label className="block space-y-1.5">
                <span className="text-[10px] uppercase tracking-wider text-muted-foreground">Controller Host</span>
                <input value={controllerHost} onChange={(event) => setControllerHost(event.target.value)} placeholder="203.0.113.10 or vps.example.com" className={inputCls} />
              </label>
              <label className="block space-y-1.5">
                <span className="text-[10px] uppercase tracking-wider text-muted-foreground">SSH Target</span>
                <input value={sshTarget} onChange={(event) => setSshTarget(event.target.value)} placeholder="ubuntu@vps.example.com" className={inputCls} />
              </label>
              <label className="block space-y-1.5">
                <span className="text-[10px] uppercase tracking-wider text-muted-foreground">Install Directory</span>
                <input value={installDir} onChange={(event) => setInstallDir(event.target.value)} className={inputCls} />
              </label>
              <label className="block space-y-1.5 md:col-span-2">
                <span className="text-[10px] uppercase tracking-wider text-muted-foreground">Repository URL</span>
                <input value={repoUrl} onChange={(event) => setRepoUrl(event.target.value)} className={inputCls} />
              </label>
              <label className="block space-y-1.5">
                <span className="text-[10px] uppercase tracking-wider text-muted-foreground">Dashboard Port</span>
                <input value={dashboardPort} onChange={(event) => setDashboardPort(event.target.value)} className={inputCls} />
              </label>
              <label className="block space-y-1.5">
                <span className="text-[10px] uppercase tracking-wider text-muted-foreground">Terminal Port</span>
                <input value={terminalPort} onChange={(event) => setTerminalPort(event.target.value)} className={inputCls} />
              </label>
              <label className="block space-y-1.5">
                <span className="text-[10px] uppercase tracking-wider text-muted-foreground">OpenClaw Dashboard URL</span>
                <input value={openClawDashboardUrl} onChange={(event) => setOpenClawDashboardUrl(event.target.value)} className={inputCls} />
              </label>
              <label className="block space-y-1.5">
                <span className="text-[10px] uppercase tracking-wider text-muted-foreground">OpenShell Gateway</span>
                <input value={openshellGateway} onChange={(event) => setOpenshellGateway(event.target.value)} className={inputCls} />
              </label>
              <label className="block space-y-1.5 md:col-span-2">
                <span className="text-[10px] uppercase tracking-wider text-muted-foreground">Parent Controller URL</span>
                <input value={parentControllerUrl} onChange={(event) => setParentControllerUrl(event.target.value)} className={inputCls} />
              </label>
            </div>
            <label className="flex items-start gap-3 rounded-md border border-border bg-muted/30 p-3">
              <input type="checkbox" checked={exposePublicly} onChange={(event) => setExposePublicly(event.target.checked)} className="mt-0.5 h-4 w-4" />
              <span>
                <span className="block text-xs font-mono uppercase tracking-wider">Controller UI is directly reachable</span>
                <span className="mt-1 block text-[11px] text-muted-foreground">Leave this off when you access the VPS through SSH tunnels, WireGuard, or Tailscale.</span>
              </span>
            </label>
            {controllerDeployMode === "auto" && (
              <Card className="p-4 space-y-4">
                <div>
                  <h3 className="text-xs font-semibold uppercase tracking-wider">Autodeploy SSH</h3>
                  <p className="mt-1 text-xs text-muted-foreground">Password is used once for this SSH session and is not written into the deploy script or saved config.</p>
                </div>
                <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
                  <label className="block space-y-1.5">
                    <span className="text-[10px] uppercase tracking-wider text-muted-foreground">SSH Port</span>
                    <input value={remotePort} onChange={(event) => setRemotePort(event.target.value)} className={inputCls} />
                  </label>
                  <label className="block space-y-1.5">
                    <span className="text-[10px] uppercase tracking-wider text-muted-foreground">SSH User</span>
                    <input value={remoteUser} onChange={(event) => setRemoteUser(event.target.value)} placeholder="ubuntu" className={inputCls} />
                  </label>
                  <label className="block space-y-1.5">
                    <span className="text-[10px] uppercase tracking-wider text-muted-foreground">SSH Password</span>
                    <input type="password" value={remotePassword} onChange={(event) => setRemotePassword(event.target.value)} className={inputCls} />
                  </label>
                </div>
                <label className="block space-y-1.5">
                  <span className="text-[10px] uppercase tracking-wider text-muted-foreground">Expected Host Key SHA256</span>
                  <input value={expectedHostKeySha256} onChange={(event) => setExpectedHostKeySha256(event.target.value)} placeholder="SHA256:..." className={inputCls} />
                </label>
                <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                  <label className="flex items-start gap-3 rounded-md border border-border bg-background p-3">
                    <input type="checkbox" checked={acceptUnknownHostKey} onChange={(event) => setAcceptUnknownHostKey(event.target.checked)} className="mt-0.5 h-4 w-4" />
                    <span>
                      <span className="block text-xs font-mono uppercase tracking-wider">Trust first host key</span>
                      <span className="mt-1 block text-[11px] text-muted-foreground">Use only on a trusted network when you do not have the fingerprint yet.</span>
                    </span>
                  </label>
                  <label className="flex items-start gap-3 rounded-md border border-border bg-background p-3">
                    <input type="checkbox" checked={allowSudo} onChange={(event) => setAllowSudo(event.target.checked)} className="mt-0.5 h-4 w-4" />
                    <span>
                      <span className="block text-xs font-mono uppercase tracking-wider">Allow sudo</span>
                      <span className="mt-1 block text-[11px] text-muted-foreground">Installs the systemd service when the remote account can sudo.</span>
                    </span>
                  </label>
                </div>
              </Card>
            )}
            <div className="flex items-center gap-3 flex-wrap">
              <Button type="button" onClick={generateControllerPlan} disabled={controllerPlanning || !controllerHost.trim()} size="sm">
                {controllerPlanning ? "Preparing…" : "Generate Launch Kit"}
              </Button>
              {controllerDeployMode === "auto" && (
                <Button type="button" variant="outline" size="sm" onClick={autodeployControllerNode} disabled={controllerDeploying || !controllerHost.trim() || !remoteUser.trim() || !remotePassword}>
                  {controllerDeploying ? "Deploying…" : "Autodeploy Controller"}
                </Button>
              )}
            </div>
            {controllerMessage && (
              <p className="rounded-md border border-border bg-muted/30 p-3 text-sm text-muted-foreground">{controllerMessage}</p>
            )}
            {controllerDeployLog && (
              <pre className="max-h-72 overflow-auto whitespace-pre-wrap rounded-md border border-border bg-background p-3 text-[11px] leading-5 text-muted-foreground">{controllerDeployLog}</pre>
            )}
          </div>

          <div className="space-y-4">
            <Card className="p-4">
              <h3 className="text-xs font-semibold uppercase tracking-wider">Topology</h3>
              <div className="mt-3 space-y-2 text-xs text-muted-foreground">
                <p>Controller VPS: {controllerHost || "not set"}</p>
                <p>Sandbox host/gateway: {openshellGateway || "nemoclaw"}</p>
                <p>OpenClaw upstream: {openClawDashboardUrl}</p>
                <p>Parent controller: {parentControllerUrl}</p>
              </div>
            </Card>
            {controllerPlan ? (
              <div className="space-y-4">
                {[
                  { label: "SSH Bootstrap", value: controllerPlan.commands.ssh },
                  { label: "Bootstrap Script", value: controllerPlan.commands.localBootstrap },
                  { label: "Controller Env", value: controllerPlan.env },
                ].map(({ label, value }) => (
                  <Card key={label} className="p-4">
                    <div className="flex items-center justify-between gap-3">
                      <h3 className="text-xs font-semibold uppercase tracking-wider">{label}</h3>
                      <Button type="button" variant="ghost" size="sm" onClick={() => copyText(value, label)} className="h-7 px-2">Copy</Button>
                    </div>
                    <pre className="mt-3 max-h-72 overflow-auto whitespace-pre-wrap rounded-md border border-border bg-muted p-3 text-[11px] leading-5 text-muted-foreground">{value}</pre>
                  </Card>
                ))}
                <Card className="p-4">
                  <h3 className="text-xs font-semibold uppercase tracking-wider">Readiness Checks</h3>
                  <div className="mt-3 space-y-2">
                    {controllerPlan.checks.map((check) => (
                      <p key={check} className="text-xs text-muted-foreground">{check}</p>
                    ))}
                  </div>
                </Card>
              </div>
            ) : (
              <Card className="p-4">
                <p className="text-sm text-muted-foreground">
                  Enter the remote node details to generate a controller bootstrap command and matching environment block.
                </p>
              </Card>
            )}
          </div>
        </div>}
      </Card>

      <Card className="overflow-hidden">
        <button
          type="button"
          onClick={() => setCloneWizardOpen((open) => !open)}
          aria-expanded={cloneWizardOpen}
          className="flex w-full items-center justify-between gap-4 border-b border-border p-5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring max-md:items-start"
        >
          <div className="flex min-w-0 items-start gap-4">
            <svg
              className={`mt-1 h-4 w-4 shrink-0 text-muted-foreground transition-transform ${cloneWizardOpen ? "rotate-90" : ""}`}
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
              aria-hidden="true"
            >
              <path strokeLinecap="square" strokeLinejoin="miter" strokeWidth={2} d="M9 5l7 7-7 7" />
            </svg>
            <div>
              <h2 className="text-sm font-semibold uppercase tracking-wider">Clone Sandbox</h2>
              <p className="mt-1 text-xs text-muted-foreground">Start a fresh sandbox from the source image, then restore source files into the target.</p>
            </div>
          </div>
          <Badge variant="outline" className="shrink-0 font-mono text-[10px] text-muted-foreground">
            image + restore
          </Badge>
        </button>

        {cloneWizardOpen && <><div className="border-b border-border p-4">
          <div className="grid grid-cols-5 gap-2 max-md:grid-cols-1">
            {steps.map((step, index) => (
              <button
                key={step.key}
                type="button"
                onClick={() => setActiveStep(step.key)}
                className={`rounded-md border px-3 py-2 text-left text-xs font-mono uppercase tracking-wider ${
                  activeStep === step.key
                    ? "border-primary bg-primary/5 text-foreground"
                    : index < activeIndex
                      ? "border-primary/40 text-primary"
                      : "border-border text-muted-foreground"
                }`}
              >
                {index + 1}. {step.label}
              </button>
            ))}
          </div>
        </div>

        <div className="p-5">
          {activeStep === "source" && (
            <div className="space-y-4">
              <div>
                <h3 className="text-xs font-semibold uppercase tracking-wider">Choose Source Sandbox</h3>
                <p className="mt-1 text-xs text-muted-foreground">This sandbox will be archived from the selected source directory.</p>
              </div>
              <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
                {sandboxes.map((sandbox) => (
                  <button
                    key={sandbox.id}
                    type="button"
                    onClick={() => {
                      setSourceSandboxId(sandbox.id)
                      setTargetName(defaultCloneName(sandbox))
                    }}
                    className={`rounded-md border p-4 text-left ${
                      sourceSandboxId === sandbox.id
                        ? "border-primary bg-primary/5"
                        : "border-border bg-muted/30"
                    }`}
                  >
                    <div className="flex items-center justify-between gap-3">
                      <span className="truncate text-sm font-mono font-semibold">{sandbox.name}</span>
                      <Badge variant="outline" className="font-mono text-[10px] text-primary border-primary">{sandbox.status}</Badge>
                    </div>
                    <p className="mt-2 truncate text-xs text-muted-foreground">{sandbox.namespace} / {sandbox.sshHostAlias || sandbox.ip}</p>
                  </button>
                ))}
              </div>
              {sandboxes.length === 0 && (
                <p className="text-sm text-muted-foreground">No sandboxes are available to clone yet.</p>
              )}
            </div>
          )}

          {activeStep === "target" && (
            <div className="space-y-4">
              <div>
                <h3 className="text-xs font-semibold uppercase tracking-wider">Configure Target Sandbox</h3>
                <p className="mt-1 text-xs text-muted-foreground">Choose how the target is created and set its sandbox name.</p>
              </div>
              <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                {blueprints.map((blueprint) => (
                  <button
                    key={blueprint.id}
                    type="button"
                    onClick={() => setSelectedBlueprint(blueprint.id)}
                    className={`rounded-md border p-4 text-left ${selectedBlueprint === blueprint.id ? "border-primary bg-primary/5" : "border-border bg-muted/30"}`}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <span className="text-sm font-semibold uppercase tracking-wider">{blueprint.label}</span>
                      {blueprint.baseline && (
                        <Badge variant="outline" className={`shrink-0 font-mono text-[10px] ${blueprint.baseline.available ? "text-primary border-primary" : "text-yellow-500 border-yellow-500"}`}>
                          {blueprint.baseline.available ? "Baseline Ready" : "Baseline Missing"}
                        </Badge>
                      )}
                    </div>
                    <p className="mt-2 text-xs text-muted-foreground">{blueprint.description}</p>
                    {blueprint.baseline && (
                      <p className="mt-1 text-[10px] font-mono text-muted-foreground">Baseline: {blueprint.baseline.name}</p>
                    )}
                  </button>
                ))}
              </div>
              <label className="block space-y-1.5">
                <span className="text-[10px] uppercase tracking-wider text-muted-foreground">Target Sandbox Name</span>
                <input
                  value={targetName}
                  onChange={(event) => setTargetName(event.target.value)}
                  placeholder="source-clone"
                  className={inputCls}
                />
              </label>
              {activeBlueprint?.supportsTailscale && (
                <label className="flex items-center gap-3 text-sm font-mono">
                  <input type="checkbox" checked={enableTailscale} onChange={(event) => setEnableTailscale(event.target.checked)} />
                  Enable Tailscale
                </label>
              )}
            </div>
          )}

          {activeStep === "options" && (
            <div className="space-y-4">
              <div>
                <h3 className="text-xs font-semibold uppercase tracking-wider">Clone Options</h3>
                <p className="mt-1 text-xs text-muted-foreground">Most clones should back up and restore /sandbox.</p>
              </div>
              <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                <label className="block space-y-1.5">
                  <span className="text-[10px] uppercase tracking-wider text-muted-foreground">Source Backup Path</span>
                  <input value={backupPath} onChange={(event) => setBackupPath(event.target.value)} className={inputCls} />
                </label>
                <label className="block space-y-1.5">
                  <span className="text-[10px] uppercase tracking-wider text-muted-foreground">Target Restore Path</span>
                  <input value={restorePath} onChange={(event) => setRestorePath(event.target.value)} className={inputCls} />
                </label>
              </div>
              <label className="flex items-start gap-3 rounded-md border border-border bg-muted/30 p-3">
                <input type="checkbox" checked={replaceTarget} onChange={(event) => setReplaceTarget(event.target.checked)} className="mt-0.5 h-4 w-4" />
                <span>
                  <span className="block text-xs font-mono uppercase tracking-wider">Replace target contents</span>
                  <span className="mt-1 block text-[11px] text-muted-foreground">Recommended for cloning into a new sandbox.</span>
                </span>
              </label>
            </div>
          )}

          {activeStep === "review" && (
            <div className="space-y-4">
              <div>
                <h3 className="text-xs font-semibold uppercase tracking-wider">Review Clone Plan</h3>
                <p className="mt-1 text-xs text-muted-foreground">The wizard will run these steps in order.</p>
              </div>
              <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                {[
                  ["Source", sourceSandbox?.name || "-"],
                  ["Target", targetName || "-"],
                  ["Create Path", activeBlueprint?.label || selectedBlueprint],
                  ["Backup Path", backupPath],
                  ["Restore Path", restorePath],
                  ["Restore Mode", replaceTarget ? "replace" : "merge"],
                ].map(([label, value]) => (
                  <div key={label} className="rounded-md border border-border bg-muted/30 p-4">
                    <p className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</p>
                    <p className="mt-1 break-words font-mono text-sm">{value}</p>
                  </div>
                ))}
              </div>
            </div>
          )}

          {activeStep === "run" && (
            <div className="space-y-4">
              <div>
                <h3 className="text-xs font-semibold uppercase tracking-wider">Run Clone</h3>
                <p className="mt-1 text-xs text-muted-foreground">Progress appears here as each operation completes.</p>
              </div>
              <Card className="p-4">
                {runLog.length === 0 ? (
                  <p className="text-xs text-muted-foreground">Ready to clone.</p>
                ) : (
                  <div className="space-y-2">
                    {runLog.map((line, index) => (
                      <p key={`${line}-${index}`} className="font-mono text-xs text-muted-foreground">{line}</p>
                    ))}
                  </div>
                )}
              </Card>
              {message && (
                <p className="rounded-md border border-border bg-muted/30 p-3 text-sm text-muted-foreground whitespace-pre-wrap">{message}</p>
              )}
            </div>
          )}
        </div>

        <div className="flex items-center justify-between gap-3 border-t border-border p-5">
          <Button type="button" variant="outline" size="sm" onClick={goBack} disabled={activeIndex === 0 || running}>
            Back
          </Button>
          {activeStep === "review" || activeStep === "run" ? (
            <Button type="button" size="sm" onClick={runCloneWizard} disabled={!sourceSandbox || !targetName.trim() || running}>
              {running ? "Running…" : "Start Clone"}
            </Button>
          ) : (
            <Button type="button" size="sm" onClick={goNext} disabled={!canContinue || running}>
              Next
            </Button>
          )}
        </div>
        </>}
      </Card>
    </div>
  )
}
