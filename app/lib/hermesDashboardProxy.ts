import { NextResponse } from 'next/server'
import http from 'node:http'
import { Readable } from 'node:stream'
import { readHermesRemoteAccess } from './hermesRemote'

const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade', 'content-length', 'accept-encoding', 'host',
])

export function hermesDashboardProxyPrefix(sandboxId: string) {
  return `/api/sandbox/${encodeURIComponent(sandboxId)}/hermes/dashboard/proxy`
}

// Matches the sandbox id out of a Referer pointing at the Hermes dashboard
// proxy, e.g. https://host/api/sandbox/my-hermes/hermes/dashboard/proxy/chat.
const REFERER_SANDBOX_RE = /\/api\/sandbox\/([^/]+)\/hermes\/dashboard\/proxy(?:\/|$)/

export function sandboxIdFromHermesProxyReferer(referer: string | null): string | null {
  if (!referer) return null
  try {
    const match = new URL(referer).pathname.match(REFERER_SANDBOX_RE)
    return match ? decodeURIComponent(match[1]) : null
  } catch {
    return null
  }
}

function upstreamBase(access: { bridgeIp?: string; port: number }) {
  const host = access.bridgeIp && access.bridgeIp.trim() ? access.bridgeIp.trim() : '127.0.0.1'
  return `http://${host}:${access.port}`
}

// Forwards a single HTTP request to the in-sandbox Hermes dashboard. Shared by
// the sandbox-prefixed proxy route and the bare /api/assets/* fallback (see
// that route for why it exists): both just need to hand off a request and an
// already-resolved upstream path.
export async function forwardToHermesDashboard(
  request: Request,
  sandboxId: string,
  upstreamPath: string,
  options: { rewriteLocationPrefix?: string } = {},
) {
  const access = readHermesRemoteAccess(sandboxId) as (ReturnType<typeof readHermesRemoteAccess> & { bridgeIp?: string }) | null
  if (!access) {
    return NextResponse.json(
      { ok: false, error: `Hermes sandbox '${sandboxId}' is not exposed yet — enable remote access first.` },
      { status: 404 },
    )
  }

  const reqUrl = new URL(request.url)
  const target = new URL(upstreamPath, upstreamBase(access))

  const headers = new Headers()
  request.headers.forEach((value, key) => {
    if (!HOP_BY_HOP.has(key.toLowerCase())) headers.set(key, value)
  })
  // Hermes >=0.18 binds the dashboard to loopback (scripts/hermes-remote/
  // launch.sh) and its Host/Origin DNS-rebinding guards then only accept
  // loopback-shaped headers — the connection still goes to the bridge-IP
  // forward, only the headers say loopback. Session token stays the auth.
  headers.set('host', `127.0.0.1:${access.port}`)
  headers.set('origin', `http://127.0.0.1:${access.port}`)
  // Hermes renders the SPA under this prefix natively — no HTML rewriting needed.
  headers.set('x-forwarded-prefix', hermesDashboardProxyPrefix(sandboxId))
  // Inject the session token server-side so it gates every /api/* call (the browser
  // never needs to hold it). The single-use ws-ticket flow (/api/auth/ws-ticket)
  // rides the same injection, so the WS handshake in server.mjs is pure transport.
  headers.set('x-hermes-session-token', access.token)

  const method = request.method.toUpperCase()
  const hasBody = !['GET', 'HEAD'].includes(method)
  const bodyBuffer = hasBody ? Buffer.from(await request.arrayBuffer()) : undefined

  // node:http, not fetch: undici's fetch treats Host as a forbidden header
  // and silently strips it, so the loopback Host rewrite above never reached
  // the wire and Hermes 0.18 answered "Invalid Host header" (2026-07-11).
  const requestHeaders: Record<string, string> = {}
  headers.forEach((value, key) => { requestHeaders[key] = value })
  if (bodyBuffer) requestHeaders['content-length'] = String(bodyBuffer.length)

  let upstream: { status: number; headers: http.IncomingHttpHeaders; stream: Readable }
  try {
    upstream = await new Promise((resolve, reject) => {
      const upstreamReq = http.request(
        {
          host: target.hostname,
          port: Number(access.port),
          path: upstreamPath + reqUrl.search,
          method,
          headers: requestHeaders,
        },
        (res) => resolve({ status: res.statusCode || 502, headers: res.headers, stream: res }),
      )
      upstreamReq.on('error', reject)
      if (bodyBuffer) upstreamReq.write(bodyBuffer)
      upstreamReq.end()
    })
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : 'Hermes dashboard unreachable' },
      { status: 502 },
    )
  }

  const responseHeaders = new Headers()
  for (const [key, value] of Object.entries(upstream.headers)) {
    if (HOP_BY_HOP.has(key.toLowerCase()) || value === undefined) continue
    if (Array.isArray(value)) {
      for (const v of value) responseHeaders.append(key, v)
    } else {
      responseHeaders.set(key, value)
    }
  }
  responseHeaders.set('cache-control', 'no-store')
  const location = responseHeaders.get('location')
  if (location && location.startsWith('/') && options.rewriteLocationPrefix) {
    responseHeaders.set('location', `${options.rewriteLocationPrefix}${location}`)
  }

  const responseBody =
    method === 'HEAD' || upstream.status === 204 || upstream.status === 304
      ? null
      : (Readable.toWeb(upstream.stream) as unknown as ReadableStream)
  return new NextResponse(responseBody, { status: upstream.status, headers: responseHeaders })
}
