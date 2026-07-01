import { NextResponse } from "next/server"
import { isUserAuthorizedForSandbox } from "@/app/lib/controlAuth"
import { approveOpenClawPairing, listOpenClawPairingRequests } from "@/app/lib/openclawPairing"
import { resolveSandboxRef } from "@/app/lib/openshellHost"

// Controller surface for OpenClaw mobile-app device pairing. GET lists pending
// requests; POST approves one (by requestId, or the latest). Runs the approval
// CLI inside the sandbox via `openshell sandbox exec` — see app/lib/openclawPairing.ts.
//
// Approve is a privileged, mutating action: the middleware write-allowlist keeps
// OAuth/IDP users off any non-GET here (only operators can POST), and this
// per-sandbox guard is belt-and-suspenders for the GET listing so an IDP user
// without access to this sandbox can't enumerate its pairing requests.
function forbiddenForIdpUser(request: Request, sandboxName: string) {
  const idpUser = request.headers.get("x-forwarded-user")?.trim().toLowerCase()
  if (idpUser && !isUserAuthorizedForSandbox(idpUser, sandboxName)) {
    return NextResponse.json(
      { ok: false, error: `Forbidden: no access to sandbox ${sandboxName}` },
      { status: 403 },
    )
  }
  return null
}

async function resolveName(sandboxId: string): Promise<string> {
  try {
    return (await resolveSandboxRef(sandboxId)).name
  } catch {
    return sandboxId
  }
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ sandboxId: string }> },
) {
  const { sandboxId } = await params
  const sandboxName = await resolveName(sandboxId)

  const forbidden = forbiddenForIdpUser(request, sandboxName)
  if (forbidden) return forbidden

  try {
    const { requests, raw } = await listOpenClawPairingRequests(sandboxName)
    return NextResponse.json({ ok: true, requests, raw })
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : "Failed to list pairing requests" },
      { status: 502 },
    )
  }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ sandboxId: string }> },
) {
  const { sandboxId } = await params
  const sandboxName = await resolveName(sandboxId)

  const forbidden = forbiddenForIdpUser(request, sandboxName)
  if (forbidden) return forbidden

  const body = await request.json().catch(() => ({}))
  const requestId = typeof body?.requestId === "string" && body.requestId.trim() ? body.requestId.trim() : undefined

  try {
    const { output } = await approveOpenClawPairing(sandboxName, requestId)
    return NextResponse.json({ ok: true, output })
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : "Failed to approve pairing request" },
      { status: 502 },
    )
  }
}
