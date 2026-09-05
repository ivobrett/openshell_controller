import { NextResponse } from 'next/server'
import { isUserAuthorizedForSandbox } from '@/app/lib/controlAuth'
import { forwardToHermesDashboard, sandboxIdFromHermesProxyReferer } from '@/app/lib/hermesDashboardProxy'

// Fallback for absolute-path static assets that Hermes 0.20.6's client-side
// route code-splitting requests as `/assets/<chunk>` instead of a path
// relative to X-Forwarded-Prefix (see the long comment in
// app/api/sandbox/[sandboxId]/hermes/dashboard/proxy/[[...path]]/route.ts —
// this is what makes clicking "Chat" in a proxied Hermes dashboard render a
// blank page: 8+ lazy chunks 404 against the controller's own root and an
// uncaught preload-CSS error aborts rendering). There is no sandbox context
// in these request URLs at all, so the only way to know which sandbox's
// Hermes instance to fetch from is the browser's Referer header, which every
// <script>/<link> sub-resource request carries back to the page that
// requested it.
//
// The forwarded bytes are Hermes's own public, non-sandbox-specific UI bundle
// (no secrets, no per-sandbox data) — byte-identical for any Hermes sandbox
// on the same Hermes version — but we still resolve strictly by Referer
// rather than "any running Hermes sandbox", and still apply the same
// per-sandbox OAuth check the sandbox-prefixed route gets from middleware,
// so this can't be used to enumerate or probe sandboxes an OAuth caller
// isn't otherwise allowed to reach.
async function handler(request: Request) {
  const sandboxId = sandboxIdFromHermesProxyReferer(request.headers.get('referer'))
  if (!sandboxId) {
    return NextResponse.json({ ok: false, error: 'No Hermes dashboard referer to resolve this asset against' }, { status: 404 })
  }

  // middleware.ts sets x-forwarded-user only for verified OAuth/IDP callers
  // (it strips any client-supplied value otherwise), so trusting it here is
  // safe. Absence means an operator session, which middleware already let
  // through unconditionally.
  const idpUser = request.headers.get('x-forwarded-user')?.trim().toLowerCase()
  if (idpUser && !isUserAuthorizedForSandbox(idpUser, sandboxId)) {
    return NextResponse.json({ ok: false, error: `Forbidden: no access to sandbox ${sandboxId}` }, { status: 403 })
  }

  const reqUrl = new URL(request.url)
  return forwardToHermesDashboard(request, sandboxId, reqUrl.pathname)
}

export const GET = handler
export const HEAD = handler
