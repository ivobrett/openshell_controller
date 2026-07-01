import { spawn } from "node:child_process"
import { OPENSHELL_BIN, hostCommandEnv } from "./hostCommands"

// Controller-driven OpenClaw device-pairing approval.
//
// The OpenClaw mobile apps authenticate the WS *transport* with the gateway
// shared-secret token, but a first-time node (role: node) still files a pending
// *pairing* request that a human must approve with `openclaw devices approve`
// on the gateway host. On a Docker-driver deployment the gateway host is the
// sandbox container, so there is no shell for the operator to run that in —
// the "chicken-and-egg" that blocked Android pairing.
//
// This module runs the approval CLI *inside* the sandbox via the same
// privileged `openshell sandbox exec` channel the controller already uses for
// MCP config writes (see sandboxPrivilegedFiles.ts / sandboxOpenClawMcpConfig.ts),
// so the operator can list + approve from the controller UI without the GUI
// pairing flow.

function shellQuote(value: string) {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

// requestId comes from `openclaw devices list`; it is passed as a distinct argv
// entry (no shell), but we still constrain it defensively before use.
const REQUEST_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/

export type OpenClawPairingRequest = {
  requestId: string
  role?: string
  label?: string
  scopes?: string[]
  createdAt?: string
}

function runSandboxExec(sandboxName: string, command: string[]) {
  return new Promise<{ stdout: string; stderr: string; code: number | null }>((resolve, reject) => {
    const child = spawn(OPENSHELL_BIN, ["sandbox", "exec", "-n", sandboxName, "--", ...command], {
      env: hostCommandEnv({ OPENSHELL_GATEWAY: process.env.OPENSHELL_GATEWAY || "nemoclaw" }),
      stdio: ["ignore", "pipe", "pipe"],
    })
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (chunk) => { stdout += String(chunk) })
    child.stderr.on("data", (chunk) => { stderr += String(chunk) })
    child.on("error", reject)
    child.on("close", (code) => resolve({ stdout: stdout.trim(), stderr: stderr.trim(), code }))
  })
}

// Best-effort parse of `openclaw devices list --json`. The CLI schema varies
// across OpenClaw versions, so we tolerate a few shapes and fall back to the
// raw text (surfaced to the operator) when we can't parse a request id.
function parsePairingRequests(raw: string): OpenClawPairingRequest[] {
  if (!raw) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return []
  }
  const rows = Array.isArray(parsed)
    ? parsed
    : Array.isArray((parsed as { requests?: unknown[] })?.requests)
      ? (parsed as { requests: unknown[] }).requests
      : Array.isArray((parsed as { devices?: unknown[] })?.devices)
        ? (parsed as { devices: unknown[] }).devices
        : []
  const out: OpenClawPairingRequest[] = []
  for (const row of rows) {
    if (!row || typeof row !== "object") continue
    const r = row as Record<string, unknown>
    const requestId =
      (typeof r.requestId === "string" && r.requestId) ||
      (typeof r.id === "string" && r.id) ||
      (typeof r.request_id === "string" && r.request_id) ||
      ""
    if (!requestId) continue
    // Only surface things still awaiting approval when the CLI tells us.
    const status = typeof r.status === "string" ? r.status.toLowerCase() : ""
    if (status && status !== "pending" && status !== "requested" && status !== "awaiting") continue
    out.push({
      requestId,
      role: typeof r.role === "string" ? r.role : undefined,
      label: typeof r.label === "string" ? r.label : typeof r.name === "string" ? r.name : undefined,
      scopes: Array.isArray(r.scopes) ? r.scopes.filter((s): s is string => typeof s === "string") : undefined,
      createdAt: typeof r.createdAt === "string" ? r.createdAt : typeof r.created_at === "string" ? r.created_at : undefined,
    })
  }
  return out
}

export async function listOpenClawPairingRequests(sandboxName: string): Promise<{
  requests: OpenClawPairingRequest[]
  raw: string
}> {
  // Prefer JSON; fall back to plain text (older CLIs) so the operator can still
  // read request ids off the panel and approve by id.
  let result = await runSandboxExec(sandboxName, ["sh", "-lc", "openclaw devices list --json"])
  if (result.code !== 0 || !result.stdout) {
    const plain = await runSandboxExec(sandboxName, ["sh", "-lc", "openclaw devices list"])
    if (plain.code !== 0 && !plain.stdout) {
      throw new Error(plain.stderr || result.stderr || "failed to list OpenClaw pairing requests")
    }
    return { requests: parsePairingRequests(plain.stdout), raw: plain.stdout }
  }
  return { requests: parsePairingRequests(result.stdout), raw: result.stdout }
}

export async function approveOpenClawPairing(
  sandboxName: string,
  requestId?: string,
): Promise<{ output: string }> {
  let cmd: string
  if (requestId) {
    if (!REQUEST_ID_RE.test(requestId)) {
      throw new Error("invalid pairing requestId")
    }
    cmd = `openclaw devices approve ${shellQuote(requestId)}`
  } else {
    // No id → approve the most recent pending request.
    cmd = "openclaw devices approve --latest"
  }
  const result = await runSandboxExec(sandboxName, ["sh", "-lc", cmd])
  if (result.code !== 0) {
    throw new Error(result.stderr || result.stdout || "failed to approve OpenClaw pairing request")
  }
  return { output: result.stdout || result.stderr || "approved" }
}
