import { NextRequest, NextResponse } from "next/server"
import { listActivity } from "@/app/lib/activityLog"
import { isOperator, oauthEmail } from "@/app/lib/auth/context"
import { getSandboxAccessMap } from "@/app/lib/auth/sandboxAccessStore"

export async function GET(request: NextRequest) {
  const requestUrl = new URL(request.url)
  const limit = Number.parseInt(requestUrl.searchParams.get("limit") || "100", 10)
  let entries = await listActivity(Number.isFinite(limit) ? limit : 100)

  // Operators see everything. OAuth/IdP users only see entries tagged with a
  // sandbox they've been granted; entries with no sandboxName are operator-only.
  if (!(await isOperator(request))) {
    const email = await oauthEmail(request)
    const allowed = new Set<string>()
    if (email) {
      const map = getSandboxAccessMap()
      for (const [name, emails] of map.entries()) {
        if (emails.has(email.toLowerCase())) allowed.add(name)
      }
    }
    entries = entries.filter((entry) => Boolean(entry.sandboxName) && allowed.has(entry.sandboxName!))
  }

  return NextResponse.json({ ok: true, entries })
}
