import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { NEMOCLAW_BIN, NODE_BIN, commandExists, hostCommandEnv } from "./hostCommands"

const execFileAsync = promisify(execFile)
const NEMOCLAW_RECOVERY_MIN_VERSION = "0.0.37"

type NemoClawInvocation = {
  file: string
  args: string[]
  display: string[]
}

type NemoClawRunResult = {
  ok: boolean
  stdout: string
  stderr: string
  exitCode: number | null
  error: string | null
}

export type NemoClawDoctorCheck = {
  group: string
  label: string
  status: "ok" | "warn" | "fail" | "info"
  detail: string
  hint?: string
}

export type NemoClawDoctorReport = {
  schemaVersion: number
  sandbox: string
  status: "ok" | "warn" | "fail" | "info"
  failed: number
  warnings: number
  checks: NemoClawDoctorCheck[]
}

function buildNemoClawInvocation(args: string[]): NemoClawInvocation | null {
  if (!commandExists(NEMOCLAW_BIN)) return null
  if (/\.(?:c?m?js|ts)$/i.test(NEMOCLAW_BIN)) {
    return {
      file: NODE_BIN,
      args: [NEMOCLAW_BIN, ...args],
      display: [NODE_BIN, NEMOCLAW_BIN, ...args],
    }
  }
  return {
    file: NEMOCLAW_BIN,
    args,
    display: [NEMOCLAW_BIN, ...args],
  }
}

function parseVersion(value: string) {
  return value.match(/v?(\d+\.\d+\.\d+)/)?.[1] ?? null
}

function versionGte(left: string, right: string) {
  const leftParts = left.split(".").map((part) => Number.parseInt(part, 10) || 0)
  const rightParts = right.split(".").map((part) => Number.parseInt(part, 10) || 0)
  const length = Math.max(leftParts.length, rightParts.length)
  for (let index = 0; index < length; index += 1) {
    const a = leftParts[index] || 0
    const b = rightParts[index] || 0
    if (a > b) return true
    if (a < b) return false
  }
  return true
}

function parseJsonObject(value: string) {
  const trimmed = value.trim()
  if (!trimmed) return null
  try {
    return JSON.parse(trimmed)
  } catch {
    const start = trimmed.indexOf("{")
    const end = trimmed.lastIndexOf("}")
    if (start === -1 || end === -1 || end <= start) return null
    return JSON.parse(trimmed.slice(start, end + 1))
  }
}

async function runNemoClaw(args: string[], timeout = 30000): Promise<NemoClawRunResult & { command: string[] }> {
  const invocation = buildNemoClawInvocation(args)
  if (!invocation) {
    return {
      ok: false,
      stdout: "",
      stderr: "",
      exitCode: null,
      error: "NemoClaw CLI is not available",
      command: [NEMOCLAW_BIN, ...args],
    }
  }

  try {
    const { stdout, stderr } = await execFileAsync(invocation.file, invocation.args, {
      env: hostCommandEnv({
        OPENSHELL_GATEWAY: process.env.OPENSHELL_GATEWAY || "nemoclaw",
        NO_COLOR: "1",
        CLICOLOR: "0",
        CLICOLOR_FORCE: "0",
      }),
      timeout,
      maxBuffer: 8 * 1024 * 1024,
    })
    return {
      ok: true,
      stdout: String(stdout).trim(),
      stderr: String(stderr).trim(),
      exitCode: 0,
      error: null,
      command: invocation.display,
    }
  } catch (error: any) {
    return {
      ok: false,
      stdout: String(error?.stdout || "").trim(),
      stderr: String(error?.stderr || "").trim(),
      exitCode: typeof error?.code === "number" ? error.code : null,
      error: error instanceof Error ? error.message : String(error ?? "NemoClaw command failed"),
      command: invocation.display,
    }
  }
}

export async function getNemoClawVersion() {
  const result = await runNemoClaw(["--version"], 10000)
  const version = parseVersion(`${result.stdout}\n${result.stderr}`)
  return {
    available: result.ok || Boolean(version),
    version,
    stdout: result.stdout,
    stderr: result.stderr,
    error: result.ok ? null : result.error,
    command: result.command,
  }
}

async function hasModernNemoClawSurface() {
  const version = await getNemoClawVersion()
  return {
    ...version,
    supported: version.version ? versionGte(version.version, NEMOCLAW_RECOVERY_MIN_VERSION) : false,
    minimumVersion: NEMOCLAW_RECOVERY_MIN_VERSION,
  }
}

export async function getNemoClawDoctorReport(sandboxName: string) {
  const capability = await hasModernNemoClawSurface()
  if (!capability.supported) {
    return {
      available: capability.available,
      supported: false,
      attempted: false,
      version: capability.version,
      minimumVersion: capability.minimumVersion,
      report: null as NemoClawDoctorReport | null,
      error: capability.available
        ? `NemoClaw ${capability.version || "unknown"} does not expose doctor --json`
        : capability.error || "NemoClaw CLI is not available",
    }
  }

  const result = await runNemoClaw([sandboxName, "doctor", "--json"], 30000)
  const parsed = result.ok ? parseJsonObject(result.stdout) : null
  const report = parsed && typeof parsed === "object" ? parsed as NemoClawDoctorReport : null

  return {
    available: true,
    supported: true,
    attempted: true,
    version: capability.version,
    minimumVersion: capability.minimumVersion,
    report,
    error: report ? null : result.error || result.stderr || "NemoClaw doctor did not return JSON",
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.exitCode,
  }
}

export async function recoverSandboxWithNemoClaw(sandboxName: string) {
  const capability = await hasModernNemoClawSurface()
  if (!capability.supported) {
    return {
      available: capability.available,
      supported: false,
      attempted: false,
      version: capability.version,
      minimumVersion: capability.minimumVersion,
      ok: false,
      stdout: "",
      stderr: "",
      exitCode: null as number | null,
      error: capability.available
        ? `NemoClaw ${capability.version || "unknown"} does not expose sandbox recover`
        : capability.error || "NemoClaw CLI is not available",
    }
  }

  const result = await runNemoClaw([sandboxName, "recover"], 90000)
  return {
    available: true,
    supported: true,
    attempted: true,
    version: capability.version,
    minimumVersion: capability.minimumVersion,
    ok: result.ok,
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.exitCode,
    error: result.error,
  }
}

// ---------------------------------------------------------------------------
// Shields (NemoClaw kernel-level config lockdown) — verified on NemoClaw
// v0.0.73. Per-sandbox subcommand: `nemoclaw <sandbox> shields up|down|status`.
//   up     -> agent config chown root:root 444 (sandbox user cannot modify),
//             restrictive policy stays active.
//   down   -> snapshots the current sandbox policy, applies a PERMISSIVE
//             policy, unlocks config. Default auto-relock after 5m via a
//             detached host timer; a repeated `down` does NOT extend it
//             (fail-locked by design).
//   status -> text only (no --json on v0.0.73), parsed below.
// Host-side state lives in $HOME/.nemoclaw/state/ (shields-<sb>.json,
// shields-timer-<sb>.json with pid+restoreAt, shields-audit.jsonl).
// ---------------------------------------------------------------------------

export type ShieldsPosture = "up" | "down" | "not_configured" | "unknown"

export type ShieldsStatus = {
  available: boolean
  posture: ShieldsPosture
  since: string | null
  autoLockIn: string | null
  restoreAt: string | null
  reason: string | null
  policy: string | null
  raw: string
  error: string | null
}

export type ShieldsAuditEvent = {
  action: string
  sandbox: string
  timestamp: string
  reason?: string | null
  timeout_seconds?: number
  restored_by?: string
  duration_seconds?: number
}

function nemoclawStateDir() {
  const home = process.env.HOME || "/root"
  return `${home}/.nemoclaw/state`
}

function parseShieldsStatusText(raw: string): Omit<ShieldsStatus, "available" | "restoreAt" | "error"> {
  const text = raw.replace(/\[[0-9;]*m/g, "")
  const field = (label: string) => {
    const match = text.match(new RegExp(`${label}:\\s*(.+)`, "i"))
    const value = match?.[1]?.trim() ?? null
    return value && value.toLowerCase() !== "not specified" ? value : null
  }
  let posture: ShieldsPosture = "unknown"
  if (/Shields:\s*UP/i.test(text)) posture = "up"
  else if (/Shields:\s*DOWN/i.test(text)) posture = "down"
  else if (/Shields:\s*NOT CONFIGURED/i.test(text)) posture = "not_configured"
  return {
    posture,
    since: field("Since"),
    autoLockIn: field("Auto-lockdown in"),
    reason: field("Reason"),
    policy: field("Policy"),
    raw: text.trim(),
  }
}

export async function getShieldsStatus(sandboxName: string): Promise<ShieldsStatus> {
  const result = await runNemoClaw([sandboxName, "shields", "status"], 90000)
  if (!result.ok) {
    return {
      available: false,
      posture: "unknown",
      since: null,
      autoLockIn: null,
      restoreAt: null,
      reason: null,
      policy: null,
      raw: result.stdout || result.stderr,
      error: result.error || result.stderr || "shields status failed",
    }
  }
  const parsed = parseShieldsStatusText(result.stdout || result.stderr)

  // Best-effort: the detached auto-relock timer records an absolute restoreAt.
  let restoreAt: string | null = null
  if (parsed.posture === "down") {
    try {
      const { readFile } = await import("node:fs/promises")
      const timer = JSON.parse(
        await readFile(`${nemoclawStateDir()}/shields-timer-${sandboxName}.json`, "utf8"),
      )
      if (typeof timer?.restoreAt === "string") restoreAt = timer.restoreAt
    } catch {
      // Timer file absent (e.g. timer process died) — posture text is still
      // authoritative; the UI will show the countdown from autoLockIn only.
    }
  }
  return { available: true, ...parsed, restoreAt, error: null }
}

export async function getShieldsAudit(sandboxName: string, limit = 20): Promise<ShieldsAuditEvent[]> {
  try {
    const { readFile } = await import("node:fs/promises")
    const raw = await readFile(`${nemoclawStateDir()}/shields-audit.jsonl`, "utf8")
    const events: ShieldsAuditEvent[] = []
    for (const line of raw.split("\n")) {
      const trimmed = line.trim()
      if (!trimmed) continue
      try {
        const event = JSON.parse(trimmed)
        if (event?.sandbox === sandboxName) events.push(event)
      } catch {
        // skip malformed lines
      }
    }
    return events.slice(-limit).reverse()
  } catch {
    return []
  }
}

const SHIELDS_TIMEOUT_PATTERN = /^\d+(?:s|m|h)?$/

export async function runShieldsAction(
  sandboxName: string,
  action: "up" | "down",
  options: { timeout?: string; reason?: string } = {},
) {
  const args = [sandboxName, "shields", action]
  if (action === "down") {
    if (options.timeout) {
      if (!SHIELDS_TIMEOUT_PATTERN.test(options.timeout)) {
        return { ok: false, stdout: "", stderr: "", exitCode: null, error: "invalid timeout (expected e.g. 30s, 5m, 1h)", command: args }
      }
      args.push("--timeout", options.timeout)
    }
    if (options.reason) {
      args.push("--reason", options.reason.slice(0, 200))
    }
  }
  // `shields down` snapshots the policy + submits a permissive one, which can
  // take a while on a busy gateway; `up` re-locks files + restores policy.
  return runNemoClaw(args, 180000)
}
