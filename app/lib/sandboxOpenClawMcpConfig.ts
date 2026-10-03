import { spawn } from "node:child_process"
import { OPENSHELL_BIN, hostCommandEnv } from "./hostCommands"
import { restartSandboxGatewayWithNemoClaw } from "./nemoclawCli"
import { writeNativeOpenClawConfigPatch } from "./openClawNativeConfig"

export const OPENSHELL_CONTROL_MCP_SERVER_NAME = "openshell-control"
export const OPENCLAW_CONFIG_PATH = "/sandbox/.openclaw/openclaw.json"

function normalizeBrokerBaseUrl(value: string) {
  return value.replace(/\/+$/, "")
}

// FORK-ONLY: our MCP broker syncs EVERY sandbox type, including Hermes and
// custom sandboxes that have no /sandbox/.openclaw/openclaw.json (and no
// `openclaw` binary, so the native `openclaw config patch` would fail). Both
// callers below return a "skipped" result for those. Upstream only runs this
// path for OpenClaw sandboxes, so it can afford to fail. Do not "simplify"
// this probe away when merging upstream.
function sandboxHasOpenClawConfig(sandboxName: string, timeoutMs = 30000) {
  return new Promise<boolean>((resolve, reject) => {
    const child = spawn(
      OPENSHELL_BIN,
      ["sandbox", "exec", "-n", sandboxName, "--", "test", "-f", OPENCLAW_CONFIG_PATH],
      {
        env: hostCommandEnv({
          OPENSHELL_GATEWAY: process.env.OPENSHELL_GATEWAY?.trim() || undefined,
        }),
        stdio: ["ignore", "ignore", "pipe"],
      },
    )
    let stderr = ""
    const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs)
    child.stderr.on("data", (chunk) => { stderr += String(chunk) })
    child.on("error", (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.on("close", (code) => {
      clearTimeout(timer)
      if (code === 0) resolve(true)
      else if (code === 1) resolve(false)
      else reject(new Error(stderr.trim() || "Failed to probe for OpenClaw config"))
    })
  })
}

async function restartNativeGateway(sandboxName: string) {
  const result = await restartSandboxGatewayWithNemoClaw(sandboxName)
  if (!result.ok) {
    throw new Error(
      result.stderr || result.error ||
      "NemoClaw could not verify the native agent gateway restart after updating MCP config",
    )
  }
}

export function buildOpenClawMcpServerConfig(brokerBaseUrl: string, token: string) {
  return {
    transport: "streamable-http",
    url: `${normalizeBrokerBaseUrl(brokerBaseUrl)}/mcp`,
    headers: {
      Authorization: `Bearer ${token}`,
    },
    connectionTimeoutMs: 45000,
  }
}

export async function syncSandboxOpenClawMcpConfig(
  sandboxName: string,
  brokerBaseUrl: string,
  token: string,
) {
  if (!(await sandboxHasOpenClawConfig(sandboxName))) {
    return {
      path: OPENCLAW_CONFIG_PATH,
      serverName: OPENSHELL_CONTROL_MCP_SERVER_NAME,
      skipped: true,
      reason: "OpenClaw is not installed in this sandbox; MCP broker is wired only through the sandbox manifest.",
    }
  }
  const serverConfig = buildOpenClawMcpServerConfig(brokerBaseUrl, token)

  await writeNativeOpenClawConfigPatch(
    sandboxName,
    { mcp: { servers: { [OPENSHELL_CONTROL_MCP_SERVER_NAME]: serverConfig } } },
    "Failed to apply native OpenClaw MCP config",
  )
  await restartNativeGateway(sandboxName)

  return {
    path: OPENCLAW_CONFIG_PATH,
    serverName: OPENSHELL_CONTROL_MCP_SERVER_NAME,
    transport: serverConfig.transport,
    url: serverConfig.url,
  }
}

export async function revokeSandboxOpenClawMcpConfig(sandboxName: string) {
  if (!(await sandboxHasOpenClawConfig(sandboxName))) {
    return {
      path: OPENCLAW_CONFIG_PATH,
      serverName: OPENSHELL_CONTROL_MCP_SERVER_NAME,
      removed: false,
      skipped: true,
      reason: "OpenClaw is not installed in this sandbox; nothing to revoke from openclaw.json.",
    }
  }
  await writeNativeOpenClawConfigPatch(
    sandboxName,
    { mcp: { servers: { [OPENSHELL_CONTROL_MCP_SERVER_NAME]: null } } },
    "Failed to remove native OpenClaw MCP config",
  )
  await restartNativeGateway(sandboxName)

  return {
    path: OPENCLAW_CONFIG_PATH,
    serverName: OPENSHELL_CONTROL_MCP_SERVER_NAME,
    removed: true,
  }
}
