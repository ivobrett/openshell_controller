import { NextResponse } from "next/server"
import {
  getShieldsAudit,
  getShieldsStatus,
  runShieldsAction,
} from "@/app/lib/nemoclawCli"

// NemoClaw shields: kernel-level lockdown of the sandbox agent config.
//   GET  -> current posture (up / down / not_configured) + audit trail
//   POST -> { action: "up" } | { action: "down", timeout?: "5m", reason?: "..." }
// Shields semantics (verified on NemoClaw v0.0.73):
//   - up locks the agent config to root:root 444 under a restrictive policy.
//   - down snapshots the policy, applies a PERMISSIVE one, and unlocks the
//     config for a bounded window (default 5m) enforced by a detached host
//     timer; a repeated `down` does not extend the active window.
// While shields are UP, config-editing features (openclaw.json patches) fail
// with Permission denied — the UI uses posture to disable those affordances.

function validateSandboxName(value: string) {
  if (!value || value.length > 63) throw new Error("sandbox name is required")
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(value)) throw new Error("invalid sandbox name")
  return value
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ sandboxId: string }> },
) {
  try {
    const { sandboxId } = await params
    const sandboxName = validateSandboxName(sandboxId)
    const [shields, audit] = await Promise.all([
      getShieldsStatus(sandboxName),
      getShieldsAudit(sandboxName),
    ])
    if (!shields.available) {
      return NextResponse.json(
        { ok: false, error: shields.error || "shields status unavailable", shields, audit },
        { status: 502 },
      )
    }
    return NextResponse.json({ ok: true, shields, audit })
  } catch (error) {
    const message = error instanceof Error ? error.message : "shields status failed"
    return NextResponse.json({ ok: false, error: message }, { status: 400 })
  }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ sandboxId: string }> },
) {
  try {
    const { sandboxId } = await params
    const sandboxName = validateSandboxName(sandboxId)
    const body = await request.json().catch(() => ({}))
    const action = body?.action
    if (action !== "up" && action !== "down") {
      return NextResponse.json({ ok: false, error: 'action must be "up" or "down"' }, { status: 400 })
    }
    const timeout = typeof body?.timeout === "string" && body.timeout.trim() ? body.timeout.trim() : undefined
    const reason = typeof body?.reason === "string" && body.reason.trim() ? body.reason.trim() : undefined

    const result = await runShieldsAction(sandboxName, action, { timeout, reason })
    if (!result.ok) {
      return NextResponse.json(
        {
          ok: false,
          error: result.error || result.stderr || `shields ${action} failed`,
          stdout: result.stdout,
        },
        { status: 502 },
      )
    }

    const [shields, audit] = await Promise.all([
      getShieldsStatus(sandboxName),
      getShieldsAudit(sandboxName),
    ])
    return NextResponse.json({ ok: true, action, shields, audit, stdout: result.stdout })
  } catch (error) {
    const message = error instanceof Error ? error.message : "shields action failed"
    return NextResponse.json({ ok: false, error: message }, { status: 400 })
  }
}
