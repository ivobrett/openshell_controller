import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { OPENSHELL_BIN, hostCommandEnv } from "./hostCommands"
import { resolveSandboxRef } from "./openshellHost"

const execFileAsync = promisify(execFile)

export type SandboxNetworkRule = {
  chunkId: string
  status: string
  rule: string
  binary: string
  confidence: string
  rationale: string
  endpoints: string[]
  binaries: string[]
}

type BrokerNetworkAction = {
  action: "approve" | "reject"
  chunkId: string
  endpoint: string
  status: string
}

function runOpenShell(args: string[], timeout = 60000) {
  return execFileAsync(OPENSHELL_BIN, args, {
    env: hostCommandEnv({
      OPENSHELL_GATEWAY: process.env.OPENSHELL_GATEWAY || "nemoclaw",
      TERM: "dumb",
    }),
    timeout,
    maxBuffer: 10 * 1024 * 1024,
  })
}

function stripAnsi(value: string) {
  return value.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "")
}

function parseList(value: string) {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
}

function parseNetworkRules(output: string): SandboxNetworkRule[] {
  const clean = stripAnsi(output)
  const chunks = clean.split(/\n\s*Chunk:\s+/).slice(1)

  return chunks
    .map((chunk) => {
      const lines = chunk.split(/\r?\n/)
      const chunkId = lines.shift()?.trim() || ""
      const fields = new Map<string, string>()

      for (const line of lines) {
        const match = line.match(/^\s*([^:]+):\s*(.*)$/)
        if (!match) continue
        fields.set(match[1].trim().toLowerCase(), match[2].trim())
      }

      return {
        chunkId,
        status: fields.get("status") || "unknown",
        rule: fields.get("rule") || "",
        binary: fields.get("binary") || "",
        confidence: fields.get("confidence") || "",
        rationale: fields.get("rationale") || "",
        endpoints: parseList(fields.get("endpoints") || ""),
        binaries: parseList(fields.get("binaries") || ""),
      }
    })
    .filter((rule) => rule.chunkId)
}

function hostPortForUrl(parsed: URL) {
  const port = parsed.port || (parsed.protocol === "https:" ? "443" : "80")
  return `${parsed.hostname}:${port}`
}

function addEndpointCandidate(candidates: Set<string>, parsed: URL) {
  const hostPort = hostPortForUrl(parsed)
  candidates.add(hostPort)
  if (parsed.hostname === "host.docker.internal") {
    const port = parsed.port || (parsed.protocol === "https:" ? "443" : "80")
    candidates.add(`0.0.0.0:${port}`)
  }
}

function extractProxiedTargetUrl(brokerBaseUrl: string) {
  try {
    const parsed = new URL(brokerBaseUrl)
    const rawPath = parsed.pathname.replace(/^\/+/, "")
    const decodedPath = decodeURIComponent(rawPath)
    if (!/^https?:\/\//i.test(decodedPath)) return null
    return new URL(decodedPath)
  } catch {
    return null
  }
}

function brokerEndpointCandidates(brokerBaseUrl: string) {
  const parsed = new URL(brokerBaseUrl)
  const candidates = new Set<string>()
  addEndpointCandidate(candidates, parsed)

  const proxiedTarget = extractProxiedTargetUrl(brokerBaseUrl)
  if (proxiedTarget) addEndpointCandidate(candidates, proxiedTarget)

  return candidates
}

function ruleMatchesEndpoints(rule: SandboxNetworkRule, candidates: Set<string>) {
  return rule.endpoints.some((endpoint) => candidates.has(endpoint))
    || Array.from(candidates).some((endpoint) => rule.rule.includes(endpoint.replace(/[^a-zA-Z0-9]/g, "_")))
    || Array.from(candidates).some((endpoint) => rule.rationale.includes(endpoint))
}

async function listRulesForStatus(sandboxName: string, status: "pending" | "approved" | "rejected") {
  const { stdout } = await runOpenShell(["rule", "get", "--status", status, sandboxName], 30000)
  return parseNetworkRules(String(stdout))
}

export async function getSandboxPermissionFeed(sandboxId: string) {
  const resolved = await resolveSandboxRef(sandboxId)
  const [pending, approved, rejected] = await Promise.all([
    listRulesForStatus(resolved.name, "pending"),
    listRulesForStatus(resolved.name, "approved").catch(() => [] as SandboxNetworkRule[]),
    listRulesForStatus(resolved.name, "rejected").catch(() => [] as SandboxNetworkRule[]),
  ])

  return {
    sandboxId,
    sandboxName: resolved.name,
    pending,
    recent: [...pending, ...approved, ...rejected].slice(0, 8),
    pendingCount: pending.length,
    approvedCount: approved.length,
    rejectedCount: rejected.length,
    latest: pending[0] ? { status: "Pending", chunkId: pending[0].chunkId } : { status: "Ready" },
  }
}

export async function resolveSandboxNetworkRule(sandboxId: string, action: string, chunkId: string, reason = "") {
  if (!/^[a-f0-9-]{8,}$/i.test(chunkId)) throw new Error("invalid network rule chunk id")
  const resolved = await resolveSandboxRef(sandboxId)
  const command = action === "reject" ? "reject" : action === "approve" ? "approve" : ""
  if (!command) throw new Error("unsupported permission action")

  const args = ["rule", command, "--chunk-id", chunkId]
  if (command === "reject" && reason) args.push("--reason", reason)
  args.push(resolved.name)

  let stdout: string
  let stderr: string
  let viaAmbiguityFallback = false

  try {
    const result = await runOpenShell(args, 60000)
    stdout = String(result.stdout)
    stderr = String(result.stderr)
  } catch (error) {
    const detail = errorText(error)
    if (command !== "approve" || !isAdvisorAmbiguityFailure(detail)) throw error

    // ADVISOR-vs-PRESET AMBIGUITY FALLBACK.
    //
    // OpenShell >= 0.0.101 validates network policies with
    // find_endpoint_ambiguities() (crates/openshell-policy/src/ambiguity.rs,
    // a file that does NOT exist in 0.0.85). It rejects any two endpoints that
    // overlap on host:port while differing on tls, allowed_ips or
    // advisor_proposed — and it does NOT consider `binaries`, the field that
    // actually distinguishes them.
    //
    // Approving an advisor chunk stamps advisor_proposed=true, so any proposal
    // for a host:port already covered by a curated preset (`brew` alone covers
    // github.com, ghcr.io, raw/objects.githubusercontent.com, ...) collides
    // with that preset's advisor_proposed=false and is UNAPPROVABLE. The user
    // sees "network endpoint ambiguity validation failed" and the grant button
    // simply does not work. This regressed when OpenShell moved 0.0.85 ->
    // 0.0.101 (NemoClaw v0.0.96 -> v0.0.108, 2026-08-14); on 0.0.85 there was
    // no ambiguity check and approval just worked.
    //
    // The conflict only fires when the two values DIFFER, so authoring the
    // same grant manually — which defaults advisor_proposed to false, matching
    // the preset — passes validation and produces the identical authorization.
    // We therefore replay the chunk's own endpoints/binaries via
    // `openshell policy update`, then reject the now-satisfied chunk so it
    // leaves the pending queue.
    //
    // Note `policy update` refuses to fold the new rule into an overlapping
    // preset when that would widen access (it says so on stderr), so this does
    // NOT inherit the preset's other endpoints. Verified live 2026-08-23:
    // python3.13 gained github.com:443 (200) while formulae.brew.sh stayed
    // blocked.
    const pendingRules = await listRulesForStatus(resolved.name, "pending").catch(
      () => [] as SandboxNetworkRule[],
    )
    const chunk = pendingRules.find((entry) => entry.chunkId === chunkId)
    const endpoints = normalizeEndpointSelectors(chunk?.endpoints ?? [])
    const binaries = (chunk?.binaries?.length ? chunk.binaries : chunk?.binary ? [chunk.binary] : [])
      .map((entry) => entry.trim())
      .filter((entry) => /^\/[\w./*-]+$/.test(entry))

    if (!chunk || endpoints.length === 0 || binaries.length === 0) throw error

    const updateArgs = ["policy", "update", resolved.name]
    for (const endpoint of endpoints) updateArgs.push("--add-endpoint", endpoint)
    for (const binary of binaries) updateArgs.push("--binary", binary)
    if (chunk.rule && /^[\w.-]+$/.test(chunk.rule)) updateArgs.push("--rule-name", chunk.rule)
    updateArgs.push("--wait", "--timeout", "90")

    const applied = await runOpenShell(updateArgs, 120000)

    // The grant is live; clear the chunk so the queue reflects reality.
    const cleared = await runOpenShell(
      ["rule", "reject", "--chunk-id", chunkId, resolved.name],
      60000,
    ).catch(() => ({ stdout: "", stderr: "" }))

    viaAmbiguityFallback = true
    stdout = [String(applied.stdout).trim(), String(cleared.stdout).trim()].filter(Boolean).join("\n")
    stderr = String(applied.stderr)
  }

  const feed = await getSandboxPermissionFeed(resolved.name).catch(() => null)

  return {
    sandboxId,
    sandboxName: resolved.name,
    action: command,
    chunkId,
    stdout: stdout.trim(),
    stderr: stderr.trim(),
    viaAmbiguityFallback,
    feed,
  }
}

function errorText(error: unknown) {
  if (!error || typeof error !== "object") return String(error ?? "")
  const candidate = error as { stderr?: unknown; stdout?: unknown; message?: unknown }
  return [candidate.stderr, candidate.stdout, candidate.message].map((part) => String(part ?? "")).join("\n")
}

/**
 * Only the advisor-vs-preset collision is safe to work around. Any other
 * ambiguity (a real tls/allowed_ips disagreement) must still surface, because
 * re-authoring it manually would silently resolve a genuine policy conflict in
 * an arbitrary direction.
 */
function isAdvisorAmbiguityFailure(detail: string) {
  return /endpoint ambiguity validation failed/i.test(detail) && /advisor_proposed/i.test(detail)
}

/**
 * `rule get` renders endpoints as "github.com:443 [L4]"; `policy update
 * --add-endpoint` wants a bare "host:port[:access...]". Strip the annotation
 * and keep only well-formed host:port selectors.
 */
function normalizeEndpointSelectors(endpoints: string[]) {
  const seen = new Set<string>()
  for (const raw of endpoints) {
    const selector = raw.replace(/\s*\[[^\]]*\]\s*/g, "").trim()
    if (/^[A-Za-z0-9.*_-]+:\d{1,5}$/.test(selector)) seen.add(selector)
  }
  return [...seen]
}

async function probeBrokerEndpoint(sandboxName: string, brokerBaseUrl: string) {
  const mcpUrl = `${brokerBaseUrl.replace(/\/+$/, "")}/mcp`
  const payload = {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "openshell-control-mcp-policy-probe", version: "0" },
    },
  }
  const script = [
    "node",
    "--input-type=module",
    "-e",
    `
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 8000);
      try {
        await fetch(${JSON.stringify(mcpUrl)}, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: ${JSON.stringify(JSON.stringify(payload))},
          signal: controller.signal,
        });
      } catch {
        // The probe only exists to let OpenShell create a policy chunk.
      } finally {
        clearTimeout(timeout);
      }
    `,
  ]
  await runOpenShell(["sandbox", "exec", "-n", sandboxName, "--", ...script], 15000).catch(() => null)
}

export async function syncBrokerNetworkAccess(sandboxId: string, brokerBaseUrl: string) {
  const resolved = await resolveSandboxRef(sandboxId)
  const candidates = brokerEndpointCandidates(brokerBaseUrl)
  await probeBrokerEndpoint(resolved.name, brokerBaseUrl)
  const pending = await listRulesForStatus(resolved.name, "pending").catch(() => [] as SandboxNetworkRule[])
  const matchingPending = pending.filter((rule) => ruleMatchesEndpoints(rule, candidates))
  const approved: BrokerNetworkAction[] = []

  for (const rule of matchingPending) {
    await resolveSandboxNetworkRule(resolved.name, "approve", rule.chunkId)
    approved.push({
      action: "approve",
      chunkId: rule.chunkId,
      endpoint: rule.endpoints.find((endpoint) => candidates.has(endpoint)) || Array.from(candidates)[0] || "",
      status: rule.status,
    })
  }

  const currentlyApproved = await listRulesForStatus(resolved.name, "approved").catch(() => [] as SandboxNetworkRule[])
  return {
    sandboxId,
    sandboxName: resolved.name,
    brokerBaseUrl,
    approved,
    alreadyApproved: currentlyApproved.filter((rule) => ruleMatchesEndpoints(rule, candidates)).map((rule) => ({
      chunkId: rule.chunkId,
      endpoints: rule.endpoints,
      status: rule.status,
    })),
  }
}

export async function revokeBrokerNetworkAccess(sandboxId: string, brokerBaseUrl: string) {
  const resolved = await resolveSandboxRef(sandboxId)
  const candidates = brokerEndpointCandidates(brokerBaseUrl)
  const [pending, approved] = await Promise.all([
    listRulesForStatus(resolved.name, "pending").catch(() => [] as SandboxNetworkRule[]),
    listRulesForStatus(resolved.name, "approved").catch(() => [] as SandboxNetworkRule[]),
  ])
  const matching = [...pending, ...approved].filter((rule) => ruleMatchesEndpoints(rule, candidates))
  const rejected: BrokerNetworkAction[] = []

  for (const rule of matching) {
    await resolveSandboxNetworkRule(resolved.name, "reject", rule.chunkId, "MCP broker access revoked")
    rejected.push({
      action: "reject",
      chunkId: rule.chunkId,
      endpoint: rule.endpoints.find((endpoint) => candidates.has(endpoint)) || Array.from(candidates)[0] || "",
      status: rule.status,
    })
  }

  return {
    sandboxId,
    sandboxName: resolved.name,
    brokerBaseUrl,
    rejected,
  }
}
