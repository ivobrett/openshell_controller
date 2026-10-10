// Network-policy preset that lets a sandbox reach the OpenShell Control MCP
// broker. Kept as plain .mjs so tests/mcp-broker-reachability-check.mjs can
// import it without a TypeScript toolchain.
//
// Why a preset instead of "probe, then approve whatever the advisor proposes":
// an approved chunk is bound to the ONE program that made the probe request and
// the ONE address it used. On the Oracle BYOVPS (2026-10-10) that left curl
// allowed where the agent's own MCP client was not, different addresses allowed
// per sandbox, and nothing at all after a sandbox was recreated.

export const MCP_BROKER_POLICY_PRESET = "mcp-broker"

// OpenShell's sandbox->host bridge name. NemoClaw refuses custom presets that
// name any other private host unless the operator passes explicit trust.
export const SANDBOX_HOST_BRIDGE = "host.openshell.internal"

// Every HTTP client an agent is likely to use: the skill helpers (curl),
// OpenClaw's MCP client (node) and Hermes's (python).
export const MCP_BROKER_CLIENT_BINARIES = [
  "/usr/bin/curl",
  "/usr/local/bin/node",
  "/usr/bin/node",
  "/usr/bin/python3.13",
  "/usr/bin/python3",
  "/opt/hermes/.venv/bin/python",
]

/**
 * Returns the preset YAML for a broker base URL such as
 * "http://host.openshell.internal:3000/api/mcp/broker", or null when the URL
 * cannot be covered by a preset (not the host bridge, or not plain HTTP).
 */
export function buildMcpBrokerPolicyPreset(brokerBaseUrl) {
  let url
  try {
    url = new URL(brokerBaseUrl)
  } catch {
    return null
  }
  if (url.protocol !== "http:" || url.hostname !== SANDBOX_HOST_BRIDGE) return null
  const port = Number.parseInt(url.port || "80", 10)
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null
  const basePath = url.pathname.replace(/\/+$/, "")
  if (!/^\/[A-Za-z0-9/_-]+$/.test(basePath)) return null

  return [
    "preset:",
    `  name: ${MCP_BROKER_POLICY_PRESET}`,
    '  description: "OpenShell Control MCP broker (inter-sandbox chat and brokered MCP tools)"',
    "",
    "network_policies:",
    "  mcp_broker:",
    "    name: mcp_broker",
    "    endpoints:",
    `      - host: ${SANDBOX_HOST_BRIDGE}`,
    `        port: ${port}`,
    "        protocol: rest",
    "        enforcement: enforce",
    "        rules:",
    `          - allow: { method: POST, path: "${basePath}/**" }`,
    `          - allow: { method: GET, path: "${basePath}/**" }`,
    "    binaries:",
    ...MCP_BROKER_CLIENT_BINARIES.map((binary) => `      - { path: ${binary} }`),
    "",
  ].join("\n")
}
