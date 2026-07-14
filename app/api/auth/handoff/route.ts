import { NextRequest, NextResponse } from "next/server"
import { getAuthSettings, sessionCookieOptionsForRequest } from "@/app/lib/controlAuth"
import { getOperatorSecret, isAuthDisabled } from "@/app/lib/auth/context"
import { verifyOperatorSession } from "@/app/lib/auth/edge"

// Lets the mobile app hand its already-issued operator session token to an
// in-app browser view so the full web console/terminal loads authenticated
// instead of bouncing to the login page. The token is passed as `session`
// (Pangolin uses the `token` query param for its own edge auth, so the names
// must not collide). Only a token that already passes operator-session
// verification is accepted, and it is stored back as the httpOnly session
// cookie the browser session reads.
export async function GET(request: NextRequest) {
  const settings = getAuthSettings()
  const token = request.nextUrl.searchParams.get("session") || ""
  const nextParam = request.nextUrl.searchParams.get("next")
  const nextPath = nextParam && nextParam.startsWith("/") ? nextParam : "/"

  const valid = isAuthDisabled() || Boolean(await verifyOperatorSession(token, getOperatorSecret()))
  // Use RELATIVE redirects. Behind Pangolin / a reverse proxy, `request.url`
  // reports the controller's internal bind address (e.g. http://0.0.0.0:3000),
  // so `new URL(path, request.url)` produced an absolute Location the mobile
  // in-app browser could not reach. A relative Location is resolved by the
  // browser against the public URL it actually requested.
  if (!valid) {
    const loginTarget = `/login?next=${encodeURIComponent(nextPath)}`
    return new NextResponse(null, { status: 307, headers: { Location: loginTarget } })
  }

  const response = new NextResponse(null, { status: 307, headers: { Location: nextPath } })
  if (!isAuthDisabled()) {
    response.cookies.set(settings.cookieName, token, sessionCookieOptionsForRequest(request))
  }
  return response
}
