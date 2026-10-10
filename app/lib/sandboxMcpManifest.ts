import { readFile } from "node:fs/promises"
import path from "node:path"
import { revokeSandboxMcpBrokerSession, rotateSandboxMcpBrokerSession } from "./mcpBrokerStore"
import { resolveSandboxName } from "./sandboxFiles"
import {
  OPENSHELL_CONTROL_MCP_SERVER_NAME,
  syncSandboxOpenClawMcpConfig,
  revokeSandboxOpenClawMcpConfig,
} from "./sandboxOpenClawMcpConfig"
import { writeSandboxFilePrivileged } from "./sandboxPrivilegedFiles"

export const SANDBOX_MCP_MANIFEST_PATH = "/sandbox/openshell_control_mcp.md"
export const SANDBOX_ISC_HELPER_PATH = "/sandbox/.inter-sandbox/isc.py"
const ISC_HELPER_SOURCE = path.join(process.cwd(), "scripts", "inter-sandbox", "isc.py")

// The inter-sandbox chat helper ships with the controller and is written into
// the sandbox next to the manifest, so an agent never has to transcribe a
// script out of a skill document (retyped copies were the usual way older
// setups broke). Best-effort: MCP access must not fail because of it.
async function installInterSandboxHelper(sandboxName: string) {
  try {
    const source = await readFile(ISC_HELPER_SOURCE)
    const written = await writeSandboxFilePrivileged(sandboxName, SANDBOX_ISC_HELPER_PATH, source, "0755")
    return { path: written.path, bytes: written.bytes, installed: true }
  } catch (error) {
    return {
      path: SANDBOX_ISC_HELPER_PATH,
      installed: false,
      error: error instanceof Error ? error.message : "failed to install the inter-sandbox helper",
    }
  }
}

type SandboxRef = {
  id: string
  name?: string | null
}

type BrokerHandoffOptions = {
  brokerBaseUrl: string
  rotateToken?: boolean
}

function normalizeBrokerBaseUrl(value: string) {
  return value.replace(/\/+$/, "")
}

export async function buildSandboxMcpBrokerHandoff(
  sandbox: SandboxRef,
  options: BrokerHandoffOptions,
) {
  const { session, token } = await rotateSandboxMcpBrokerSession(sandbox.id, sandbox.name)
  const brokerBaseUrl = normalizeBrokerBaseUrl(options.brokerBaseUrl)
  const now = new Date().toISOString()

  return {
    session,
    token,
    markdown: [
      "# OpenShell Control MCP Broker",
      "",
      `Generated: ${now}`,
      `Sandbox: ${sandbox.name || sandbox.id}`,
      `Sandbox ID: ${sandbox.id}`,
      "",
      "This sandbox does not receive a list of MCP servers. MCP access is brokered by OpenShell Control, and the control plane enforces which tools are available on every request.",
      "",
      "## Broker Endpoints",
      "",
      `- MCP: \`${brokerBaseUrl}/mcp\``,
      `- Capabilities: \`${brokerBaseUrl}/capabilities\``,
      `- Call: \`${brokerBaseUrl}/call\``,
      "",
      "## OpenClaw",
      "",
      `OpenShell Control also configures OpenClaw MCP server \`${OPENSHELL_CONTROL_MCP_SERVER_NAME}\` to use the MCP endpoint above.`,
      "",
      "## Authentication",
      "",
      "Send this token as an Authorization bearer token or x-openshell-mcp-token header:",
      "",
      "```",
      token,
      "```",
      "",
      "## Quick Check",
      "",
      "Run this inside the sandbox to verify that you are using the current broker token without pasting it into your shell history:",
      "",
      "```sh",
      "TOKEN=$(sed -n 's/^\\(osmcp_.*\\)$/\\1/p' /sandbox/openshell_control_mcp.md | head -1)",
      `curl -sS --max-time 20 -H 'Content-Type: application/json' -H "x-openshell-mcp-token: $TOKEN" \\`,
      `  --data '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' ${brokerBaseUrl}/mcp`,
      "```",
      "",
      "A JSON reply listing tools means the broker is reachable. `policy_denied` means the sandbox network policy does not allow this endpoint yet: ask the operator to re-issue MCP access. Do not try other addresses.",
      "",
      "## Talking to other sandboxes",
      "",
      `If the broker lists \`inter-sandbox-chat\` tools, use the helper at \`${SANDBOX_ISC_HELPER_PATH}\` instead of calling them by hand. It reads this file for your name, the address and the token, so there is nothing to configure:`,
      "",
      "```sh",
      `python3 ${SANDBOX_ISC_HELPER_PATH} check                          # can I reach the broker? who am I?`,
      `python3 ${SANDBOX_ISC_HELPER_PATH} install                        # once: start the background listener`,
      `python3 ${SANDBOX_ISC_HELPER_PATH} who                            # sandbox names seen in the room`,
      `python3 ${SANDBOX_ISC_HELPER_PATH} ask <sandbox> "<question>"     # ask and wait for the answer`,
      "```",
      "",
      "Your name on the broker is the `Sandbox:` value at the top of this file. After `install`, messages addressed to you arrive on their own as a new turn that tells you how to answer.",
      "",
      "## Rules",
      "",
      "- Do not assume any MCP server exists unless the broker returns it as available.",
      "- Do not attempt to connect directly to MCP servers.",
      "- Do not invent credentials. The broker owns server credentials and launch details.",
      "- If access changes, ask the operator to issue a new broker config.",
      "",
    ].join("\n"),
  }
}

export async function syncSandboxMcpManifest(
  sandbox: SandboxRef,
  options: BrokerHandoffOptions,
) {
  const handoff = await buildSandboxMcpBrokerHandoff(sandbox, options)
  const sandboxName = sandbox.name || await resolveSandboxName(sandbox.id)
  const uploaded = await writeSandboxFilePrivileged(
    sandboxName,
    SANDBOX_MCP_MANIFEST_PATH,
    Buffer.from(handoff.markdown, "utf8"),
  )
  const interSandboxHelper = await installInterSandboxHelper(sandboxName)
  const openClaw = await syncSandboxOpenClawMcpConfig(
    sandboxName,
    options.brokerBaseUrl,
    handoff.token,
  )
  return {
    interSandboxHelper,
    path: uploaded.path,
    sandboxName: uploaded.sandboxName,
    bytes: uploaded.bytes,
    brokerSession: {
      sandboxId: handoff.session.sandboxId,
      sandboxName: handoff.session.sandboxName,
      enabled: handoff.session.enabled,
      rotatedAt: handoff.session.rotatedAt,
      expiresAt: handoff.session.expiresAt,
    },
    openClaw,
    markdown: handoff.markdown,
  }
}

export async function revokeSandboxMcpManifest(sandbox: SandboxRef) {
  const session = await revokeSandboxMcpBrokerSession(sandbox.id)
  const now = new Date().toISOString()
  const markdown = [
    "# OpenShell Control MCP Broker",
    "",
    `Generated: ${now}`,
    `Sandbox: ${sandbox.name || sandbox.id}`,
    `Sandbox ID: ${sandbox.id}`,
    "",
    "MCP access is currently disabled for this sandbox.",
    "",
    "The previous broker token has been revoked. Ask the operator to enable an MCP server and issue a new broker config if MCP access is needed.",
    "",
  ].join("\n")
  const sandboxName = sandbox.name || await resolveSandboxName(sandbox.id)
  const uploaded = await writeSandboxFilePrivileged(
    sandboxName,
    SANDBOX_MCP_MANIFEST_PATH,
    Buffer.from(markdown, "utf8"),
  )
  const openClaw = await revokeSandboxOpenClawMcpConfig(sandboxName)

  return {
    path: uploaded.path,
    sandboxName: uploaded.sandboxName,
    bytes: uploaded.bytes,
    brokerSession: session ? {
      sandboxId: session.sandboxId,
      sandboxName: session.sandboxName,
      enabled: session.enabled,
      rotatedAt: session.rotatedAt,
      expiresAt: session.expiresAt,
    } : null,
    openClaw,
    markdown,
  }
}
