import { execFile, spawn } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import path from "node:path"
import { promisify } from "node:util"
import { NEMOCLAW_BIN, NODE_BIN, OPENSHELL_BIN, hostCommandEnv } from "./hostCommands"
import { getSandboxInferenceConfig, type SandboxInferenceRoute } from "./sandboxInferenceStore"

const execFileAsync = promisify(execFile)

// Same registry the create route reads/writes. Its per-sandbox `agent` field is
// "hermes" for Hermes sandboxes and null/absent for OpenClaw ones.
const NEMOCLAW_REGISTRY_FILE = path.join(process.env.HOME || "/tmp", ".nemoclaw", "sandboxes.json")

function resolveSandboxAgent(sandboxName: string): "hermes" | "openclaw" {
  try {
    if (!existsSync(NEMOCLAW_REGISTRY_FILE)) return "openclaw"
    const data = JSON.parse(readFileSync(NEMOCLAW_REGISTRY_FILE, "utf8"))
    return data?.sandboxes?.[sandboxName]?.agent === "hermes" ? "hermes" : "openclaw"
  } catch {
    return "openclaw"
  }
}

function modelContextWindow(modelId: string) {
  const normalized = modelId.toLowerCase()
  if (normalized.includes("nemotron-3-super") && normalized.includes("120b")) return 262144
  if (normalized.includes("qwen2.5:7b")) return 32768
  if (normalized.includes("qwen3.5:27b")) return 32768
  return 131072
}

function modelMaxTokens(modelId: string) {
  const contextWindow = modelContextWindow(modelId)
  if (contextWindow >= 262144) return 8192
  if (contextWindow <= 32768) return 2048
  return 4096
}

function modelSupportsReasoning(modelId: string) {
  const normalized = modelId.toLowerCase()
  return normalized.includes("nemotron-3-super")
}

function modelEntry(modelId: string, modelName: string, compat: Record<string, unknown> | null) {
  return {
    ...(compat ? { compat } : {}),
    id: modelId,
    name: modelName,
    reasoning: modelSupportsReasoning(modelId),
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: modelContextWindow(modelId),
    maxTokens: modelMaxTokens(modelId),
  }
}

function resolveInferenceModelIdentity(route: SandboxInferenceRoute) {
  const nvidiaModel = route.model.match(/^nvidia\/(.+)$/i)
  if (nvidiaModel) {
    return {
      providerKey: "nvidia",
      modelId: nvidiaModel[1],
      modelName: route.model,
      modelRef: route.model,
    }
  }
  return {
    providerKey: "inference",
    modelId: route.model,
    modelName: route.model,
    modelRef: `inference/${route.model}`,
  }
}

function resolveOpenClawRoute(route: SandboxInferenceRoute) {
  switch (route.provider) {
    case "openai-api":
      return {
        providerKey: "openai",
        modelId: route.model,
        modelName: route.model,
        modelRef: `openai/${route.model}`,
        baseUrl: "https://inference.local/v1",
        api: "openai-completions",
        compat: null,
      }
    case "anthropic-prod":
    case "compatible-anthropic-endpoint":
      return {
        providerKey: "anthropic",
        modelId: route.model,
        modelName: route.model,
        modelRef: `anthropic/${route.model}`,
        baseUrl: "https://inference.local",
        api: "anthropic-messages",
        compat: null,
      }
    case "bedrock":
    case "compatible-endpoint":
    case "gemini-api": {
      const identity = resolveInferenceModelIdentity(route)
      return {
        ...identity,
        baseUrl: "https://inference.local/v1",
        api: "openai-completions",
        compat: { supportsStore: false },
      }
    }
    case "nvidia-prod":
    case "nvidia-nim":
    case "ollama-local":
    case "vllm-local":
    default: {
      const identity = resolveInferenceModelIdentity(route)
      return {
        ...identity,
        baseUrl: "https://inference.local/v1",
        api: "openai-completions",
        compat: null,
      }
    }
  }
}

function buildOpenClawConfig(current: any, routes: SandboxInferenceRoute[], primary: SandboxInferenceRoute) {
  const providers: Record<string, any> = {}
  let primaryModelRef = primary.model
  const channelDefaults = { ...(current?.channels?.defaults || {}) }
  delete channelDefaults.configWrites

  for (const route of routes.filter((item) => item.enabled)) {
    const resolved = resolveOpenClawRoute(route)
    providers[resolved.providerKey] ||= {
      baseUrl: resolved.baseUrl,
      apiKey: "unused",
      api: resolved.api,
      models: [],
    }
    providers[resolved.providerKey].models.push(modelEntry(resolved.modelId, resolved.modelName, resolved.compat))
    if (route.id === primary.id) primaryModelRef = resolved.modelRef
  }

  return {
    ...current,
    agents: {
      ...(current?.agents || {}),
      defaults: {
        ...(current?.agents?.defaults || {}),
        model: {
          ...(current?.agents?.defaults?.model || {}),
          primary: primaryModelRef,
        },
      },
    },
    models: {
      ...(current?.models || {}),
      mode: "merge",
      providers,
    },
    channels: {
      ...(current?.channels || {}),
      defaults: {
        ...channelDefaults,
      },
    },
  }
}

async function runOpenShell(args: string[]) {
  const { stdout, stderr } = await execFileAsync(OPENSHELL_BIN, args, {
    env: hostCommandEnv({
      OPENSHELL_GATEWAY: process.env.OPENSHELL_GATEWAY || "nemoclaw",
    }),
    timeout: 60000,
    maxBuffer: 20 * 1024 * 1024,
  })
  return { stdout: String(stdout).trim(), stderr: String(stderr).trim() }
}

async function runSandboxExec(sandboxName: string, command: string[], input?: string) {
  return await new Promise<{ stdout: string; stderr: string; code: number | null }>((resolve, reject) => {
    const child = spawn(OPENSHELL_BIN, ["sandbox", "exec", "-n", sandboxName, "--", ...command], {
      env: hostCommandEnv({ OPENSHELL_GATEWAY: process.env.OPENSHELL_GATEWAY || "nemoclaw" }),
      stdio: ["pipe", "pipe", "pipe"],
    })
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (chunk) => { stdout += String(chunk) })
    child.stderr.on("data", (chunk) => { stderr += String(chunk) })
    child.on("error", reject)
    child.on("close", (code) => resolve({ stdout: stdout.trim(), stderr: stderr.trim(), code }))
    if (input) child.stdin.end(input)
    else child.stdin.end()
  })
}

async function readCurrentOpenClawConfig(sandboxName: string) {
  const result = await runSandboxExec(sandboxName, ["cat", "/sandbox/.openclaw/openclaw.json"])
  if (result.code !== 0) throw new Error(result.stderr || "Failed to read OpenClaw config")
  return JSON.parse(result.stdout)
}

async function writeOpenClawConfig(sandboxName: string, config: any) {
  const payload = `${JSON.stringify(config, null, 2)}\n`
  const script = [
    "set -e",
    `tmp="$(mktemp /sandbox/.openclaw/openclaw.json.XXXXXX)"`,
    `cat > "$tmp"`,
    `chmod 444 "$tmp"`,
    `mv -f "$tmp" /sandbox/.openclaw/openclaw.json`,
    `tmp2="$(mktemp /sandbox/.openclaw/.config-hash.XXXXXX)"`,
    `sha256sum /sandbox/.openclaw/openclaw.json > "$tmp2"`,
    `chmod 444 "$tmp2"`,
    `mv -f "$tmp2" /sandbox/.openclaw/.config-hash`,
  ].join("; ")
  const result = await runSandboxExec(sandboxName, ["sh", "-lc", script], payload)
  if (result.code !== 0) throw new Error(result.stderr || "Failed to write OpenClaw config")
  return result
}

async function restartOpenClawGatewayIfRunning(sandboxName: string) {
  const script = "for p in /proc/[0-9]*; do cmd=$(tr '\\0' ' ' < \"$p/cmdline\" 2>/dev/null || true); case \"$cmd\" in *'openclaw gateway'*) kill \"${p##*/}\" 2>/dev/null || true;; esac; done"
  return await runSandboxExec(sandboxName, ["sh", "-lc", script])
}

// The nemoclaw CLI is invoked directly unless it resolves to a JS entrypoint,
// in which case it must be launched through node (mirrors the create route).
async function runNemoClaw(args: string[], timeoutMs = 180000) {
  const isJsEntrypoint = /\.(?:c?m?js|ts)$/i.test(NEMOCLAW_BIN)
  const file = isJsEntrypoint ? NODE_BIN : NEMOCLAW_BIN
  const fullArgs = isJsEntrypoint ? [NEMOCLAW_BIN, ...args] : args
  return await new Promise<{ stdout: string; stderr: string; code: number | null; timedOut: boolean }>((resolve, reject) => {
    const child = spawn(file, fullArgs, {
      env: hostCommandEnv({ OPENSHELL_GATEWAY: process.env.OPENSHELL_GATEWAY || "nemoclaw" }),
      stdio: ["ignore", "pipe", "pipe"],
    })
    let stdout = ""
    let stderr = ""
    let timedOut = false
    // Escalate to SIGKILL after SIGTERM: a nemoclaw process wedged inside a
    // shields transition can be job-control-stopped (SIGSTOP), which ignores
    // SIGTERM — SIGKILL guarantees the HTTP request returns instead of hanging.
    const killTimer = setTimeout(() => {
      timedOut = true
      child.kill("SIGTERM")
      setTimeout(() => { try { child.kill("SIGKILL") } catch { /* already gone */ } }, 5000)
    }, timeoutMs)
    child.stdout.on("data", (chunk) => { stdout += String(chunk) })
    child.stderr.on("data", (chunk) => { stderr += String(chunk) })
    child.on("error", (error) => { clearTimeout(killTimer); reject(error) })
    child.on("close", (code) => { clearTimeout(killTimer); resolve({ stdout: stdout.trim(), stderr: stderr.trim(), code, timedOut }) })
  })
}

// Hermes sandboxes have no /sandbox/.openclaw/openclaw.json — their model route
// lives in /sandbox/.hermes/config.yaml, written by NemoClaw's config guard under
// the shields transition lock. The OpenClaw JSON-patch path above can't touch it,
// so we delegate to `nemoclaw inference set`, which is agent-aware and also points
// the gateway route. Only the primary route applies (Hermes runs a single model).
const HERMES_SHIELDS_BLOCK = /shields are up|shields down first|config writes are unavailable/i

async function applyHermesInferenceProfile(
  sandboxName: string,
  primary: SandboxInferenceRoute,
  routesApplied: number,
) {
  const result = await runNemoClaw([
    "inference", "set",
    "--sandbox", sandboxName,
    "--provider", primary.provider,
    "--model", primary.model,
    "--no-verify",
  ])
  const combined = `${result.stdout}\n${result.stderr}`
  if (result.timedOut) {
    throw new Error(
      "nemoclaw inference set timed out for the Hermes sandbox (the shields transition may be stuck). Verify shields are down and the sandbox is healthy, then retry.",
    )
  }
  // A shields-up run can print a warning and still exit 0 while leaving the
  // in-sandbox config unwritten — surface that as a hard failure so the UI
  // never reports a false success.
  if (HERMES_SHIELDS_BLOCK.test(combined)) {
    throw new Error(
      "Hermes inference apply is blocked while shields are up. Drop shields for this sandbox (SHIELDS panel) and retry.",
    )
  }
  if (result.code !== 0) {
    throw new Error(result.stderr || result.stdout || "nemoclaw inference set failed for the Hermes sandbox")
  }
  return {
    primaryRoute: primary,
    routesApplied,
    gatewayRoute: { stdout: result.stdout, stderr: result.stderr },
    agent: "hermes" as const,
    note: "Hermes in-sandbox config and the OpenShell gateway route were updated to the primary route.",
  }
}

export async function applySandboxInferenceProfile(sandboxId: string, sandboxName: string) {
  const config = await getSandboxInferenceConfig(sandboxId)
  const enabledRoutes = config.routes.filter((route) => route.enabled)
  if (enabledRoutes.length === 0) throw new Error("No enabled inference routes are configured for this sandbox")
  const primary = enabledRoutes.find((route) => route.id === config.primaryRouteId) || enabledRoutes[0]

  if (resolveSandboxAgent(sandboxName) === "hermes") {
    return await applyHermesInferenceProfile(sandboxName, primary, enabledRoutes.length)
  }

  const currentOpenClawConfig = await readCurrentOpenClawConfig(sandboxName)
  const nextOpenClawConfig = buildOpenClawConfig(currentOpenClawConfig, enabledRoutes, primary)
  await writeOpenClawConfig(sandboxName, nextOpenClawConfig)
  await restartOpenClawGatewayIfRunning(sandboxName)

  const routeResult = await runOpenShell(["inference", "set", "--no-verify", "--provider", primary.provider, "--model", primary.model])
  return {
    primaryRoute: primary,
    routesApplied: enabledRoutes.length,
    gatewayRoute: routeResult,
    agent: "openclaw" as const,
    note: "OpenClaw config was patched with the routed inference provider and the OpenShell gateway was pointed at the primary route.",
  }
}
