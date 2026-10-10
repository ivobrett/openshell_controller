import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { OPENSHELL_BIN, hostCommandEnv } from "./hostCommands"
import { SANDBOX_HOST_BRIDGE } from "./mcpBrokerPolicyPreset.mjs"
import { resolveSandboxRef } from "./openshellHost"

const execFileAsync = promisify(execFile)

const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1", "0.0.0.0", "host.docker.internal", "host.openshell.internal"])
const FALLBACK_SANDBOX_PROXY_ORIGIN = "http://10.200.0.1:3128"

function shouldUseProxyWrappedBrokerUrl() {
  return /^(1|true|yes|on)$/i.test(process.env.OPENSHELL_CONTROL_MCP_BROKER_PROXY_URL || "")
}


function normalizeProxyOrigin(value: string) {
  try {
    const proxy = new URL(value)
    if (proxy.protocol !== "http:" && proxy.protocol !== "https:") return null
    return proxy.toString().replace(/\/+$/, "")
  } catch {
    return null
  }
}

async function runOpenShell(args: string[]) {
  const { stdout } = await execFileAsync(OPENSHELL_BIN, args, {
    env: hostCommandEnv({
      OPENSHELL_GATEWAY: process.env.OPENSHELL_GATEWAY?.trim() || undefined,
      TERM: "dumb",
    }),
    timeout: 15000,
    maxBuffer: 1024 * 1024,
  })
  return String(stdout)
}

async function discoverSandboxProxyOrigin(sandboxId: string, sandboxName?: string | null) {
  const resolvedName = sandboxName || (await resolveSandboxRef(sandboxId)).name
  const script = "printf '%s\\n' \"${HTTP_PROXY:-${http_proxy:-${HTTPS_PROXY:-${https_proxy:-}}}}\""
  const output = await runOpenShell(["sandbox", "exec", "-n", resolvedName, "--", "sh", "-lc", script])
  return normalizeProxyOrigin(output.trim())
}

export async function brokerBaseUrlForSandbox(
  request: Request,
  sandbox?: { id: string, name?: string | null },
) {
  if (process.env.OPENSHELL_CONTROL_MCP_BROKER_URL) return process.env.OPENSHELL_CONTROL_MCP_BROKER_URL

  const origin = new URL(request.url).origin
  const publicOrigin = new URL(origin)
  if (LOCAL_HOSTNAMES.has(publicOrigin.hostname)) {
    // The sandbox reaches the controller over OpenShell's host bridge, and the
    // controller's own listener (server.mjs) is plain HTTP. Behind a TLS
    // reverse proxy the request origin says https://localhost:3000, which used
    // to produce an https://host.docker.internal:3000 broker URL that no
    // sandbox could use (TLS handshake against a plain-HTTP port). The bridge
    // name, not host.docker.internal, is the one NemoClaw policy presets may
    // name without extra trust flags — see mcpBrokerPolicyPreset.mjs.
    publicOrigin.hostname = SANDBOX_HOST_BRIDGE
    publicOrigin.protocol = "http:"
  }

  const hostBrokerUrl = `${publicOrigin.toString().replace(/\/+$/, "")}/api/mcp/broker`
  if (!shouldUseProxyWrappedBrokerUrl()) return hostBrokerUrl

  const proxyOrigin = sandbox
    ? await discoverSandboxProxyOrigin(sandbox.id, sandbox.name).catch(() => null)
    : null
  if (proxyOrigin) return `${proxyOrigin}/${hostBrokerUrl}`
  if (LOCAL_HOSTNAMES.has(new URL(origin).hostname)) return `${FALLBACK_SANDBOX_PROXY_ORIGIN}/${hostBrokerUrl}`
  return hostBrokerUrl
}
