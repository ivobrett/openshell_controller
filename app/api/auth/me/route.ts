import { NextRequest, NextResponse } from "next/server"
import { resolveAuthContext, isAuthConfigured } from "@/app/lib/auth/context"
import { getSandboxAccessMap } from "@/app/lib/auth/sandboxAccessStore"

export type Capabilities = {
  createSandbox: boolean
  deleteSandbox: boolean
  restartSandbox: boolean
  openTerminal: boolean
  openDashboard: boolean
  manageFiles: boolean
  manageInference: boolean
  manageMcp: boolean
  approvePermissions: boolean
  manageShields: boolean
  backupRestore: boolean
  manageSecurity: boolean
  manageNodes: boolean
  viewActivity: boolean
  viewWizards: boolean
  viewSkills: boolean
}

const OPERATOR_CAPS: Capabilities = {
  createSandbox: true, deleteSandbox: true, restartSandbox: true,
  openTerminal: true, openDashboard: true, manageFiles: true,
  manageInference: true, manageMcp: true, approvePermissions: true,
  manageShields: true, backupRestore: true, manageSecurity: true,
  manageNodes: true, viewActivity: true, viewWizards: true,
  viewSkills: true,
}

// OAuth/IdP users: read + terminal + dashboard on THEIR sandboxes only.
// Mirrors middleware.ts: writes are 403 except OAUTH_WRITE_ALLOWED_PATHS
// (/api/openshell/terminal/live); dashboard/open is a GET gated per-sandbox.
const OAUTH_CAPS: Capabilities = {
  createSandbox: false, deleteSandbox: false, restartSandbox: false,
  openTerminal: true, openDashboard: true, manageFiles: false,
  manageInference: false, manageMcp: false, approvePermissions: false,
  manageShields: false, backupRestore: false, manageSecurity: false,
  manageNodes: false, viewActivity: true, viewWizards: false,
  viewSkills: true,   // setup prompts are read-only and secret-free (§13.2)
}

function allowedSandboxesForEmail(email: string): string[] {
  const map = getSandboxAccessMap() // Map<sandboxName, Set<email>>
  const allowed: string[] = []
  for (const [sandboxName, emails] of map.entries()) {
    if (emails.has(email.toLowerCase())) allowed.push(sandboxName)
  }
  return allowed.sort()
}

export async function GET(request: NextRequest) {
  const configured = isAuthConfigured()
  const ctx = await resolveAuthContext(request)

  if (ctx.kind === "operator" || ctx.kind === "disabled") {
    return NextResponse.json({
      role: "operator",
      operator: true,               // legacy field — keep, ShieldsPanel + setup-account read it
      configured,
      email: null,
      capabilities: OPERATOR_CAPS,
      allowedSandboxes: "all",
    })
  }

  if (ctx.kind === "oauth") {
    return NextResponse.json({
      role: "user",
      operator: false,
      configured,
      email: ctx.email,
      capabilities: OAUTH_CAPS,
      allowedSandboxes: allowedSandboxesForEmail(ctx.email),
    })
  }

  return NextResponse.json({
    role: "anonymous",
    operator: false,
    configured,
    email: null,
    capabilities: null,
    allowedSandboxes: [],
  })
}
