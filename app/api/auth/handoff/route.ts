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
  if (!valid) {
    const loginUrl = new URL("/login", request.url)
    loginUrl.searchParams.set("next", nextPath)
    return NextResponse.redirect(loginUrl)
  }

  const response = NextResponse.redirect(new URL(nextPath, request.url))
  if (!isAuthDisabled()) {
    response.cookies.set(settings.cookieName, token, sessionCookieOptionsForRequest(request))
  }
  return response
}
