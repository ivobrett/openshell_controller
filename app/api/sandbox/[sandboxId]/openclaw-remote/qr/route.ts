import { NextResponse } from "next/server"
import { isUserAuthorizedForSandbox } from "@/app/lib/controlAuth"
import { generateOpenClawQr } from "@/app/lib/openclawPairing"
import { readOpenClawRemoteAccess } from "@/app/lib/openclawRemote"
import { resolveSandboxRef } from "@/app/lib/openshellHost"

// Generate a mobile-pairing QR/setup-code for an already-exposed OpenClaw gateway.
// The setup code embeds a short-lived bootstrapToken that AUTO-approves device
// pairing — the smooth flow (vs a raw wss URL, which needs a manual approve).
// Requires the sandbox to be exposed first (POST /openclaw-remote) so we have a
// public wss:// URL to put in the payload.

async function resolveName(sandboxId: string): Promise<string> {
  try {
    return (await resolveSandboxRef(sandboxId)).name
  } catch {
    return sandboxId
  }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ sandboxId: string }> },
) {
  const { sandboxId } = await params
  const sandboxName = await resolveName(sandboxId)

  const idpUser = request.headers.get("x-forwarded-user")?.trim().toLowerCase()
  if (idpUser && !isUserAuthorizedForSandbox(idpUser, sandboxName)) {
    return NextResponse.json({ ok: false, error: `Forbidden: no access to sandbox ${sandboxName}` }, { status: 403 })
  }

  const access = readOpenClawRemoteAccess(sandboxName)
  if (!access?.url) {
    return NextResponse.json(
      { ok: false, error: "Gateway is not exposed yet — enable remote access first, then generate a QR." },
      { status: 409 },
    )
  }

  try {
    const { setupCode, asciiQr } = await generateOpenClawQr(sandboxName, access.url)
    return NextResponse.json({ ok: true, setupCode, asciiQr, url: access.url })
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : "Failed to generate pairing QR" },
      { status: 502 },
    )
  }
}
