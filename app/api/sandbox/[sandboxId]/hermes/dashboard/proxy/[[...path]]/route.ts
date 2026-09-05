import { forwardToHermesDashboard, hermesDashboardProxyPrefix } from '@/app/lib/hermesDashboardProxy'

// Proxy the in-sandbox Hermes dashboard (NemoClaw v0.17+) through the controller,
// behind the controller's own auth. Unlike the public `web`-mode Traefik route
// (which serves the session-token-bearing SPA HTML past Pangolin), this keeps the
// dashboard gated by controller auth and injects the session token server-side.
//
// Hermes handles path-prefixing natively via X-Forwarded-Prefix for its own
// server-rendered HTML, and v0.17 authorises WebSockets with single-use ws-tickets,
// so this route is pure HTTP transport; the WS upgrade is proxied in server.mjs.
// The dashboard is reachable from the controller container at
// http://<bridgeIp>:<port> (the desktop-mode forward).
//
// BUT: Hermes 0.20.6's client-side route code-splitting (React Router lazy
// chunks — ChatPage, xterm, etc.) requests its JS/CSS from an ABSOLUTE
// `/assets/...` path baked into the bundle at build time, not one relative to
// X-Forwarded-Prefix. That 404s against the controller's own root and the
// resulting uncaught error blanks the whole page (confirmed live 2026-09-06:
// "Open dashboard" works, but clicking Chat renders nothing). The
// `app/api/assets/[...path]/route.ts` fallback catches those absolute
// requests via Referer and forwards them here too — see that file.

function proxyPrefix(sandboxId: string) {
  return hermesDashboardProxyPrefix(sandboxId)
}

async function proxy(request: Request, sandboxId: string) {
  const reqUrl = new URL(request.url)
  const prefix = proxyPrefix(sandboxId)
  const upstreamPath = reqUrl.pathname.startsWith(prefix) ? reqUrl.pathname.slice(prefix.length) || '/' : '/'
  return forwardToHermesDashboard(request, sandboxId, upstreamPath, { rewriteLocationPrefix: prefix })
}

type Ctx = { params: Promise<{ sandboxId: string; path?: string[] }> }
async function handler(request: Request, { params }: Ctx) {
  const { sandboxId } = await params
  return proxy(request, sandboxId)
}

export const GET = handler
export const POST = handler
export const PUT = handler
export const PATCH = handler
export const DELETE = handler
export const HEAD = handler
export const OPTIONS = handler
