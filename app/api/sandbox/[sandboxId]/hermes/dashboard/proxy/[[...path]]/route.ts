import { NextResponse } from 'next/server'
import http from 'node:http'
import { Readable } from 'node:stream'
import { readHermesRemoteAccess } from '@/app/lib/hermesRemote'

// Proxy the in-sandbox Hermes dashboard (NemoClaw v0.17+) through the controller,
// behind the controller's own auth. Unlike the public `web`-mode Traefik route
// (which serves the session-token-bearing SPA HTML past Pangolin), this keeps the
// dashboard gated by controller auth and injects the session token server-side.
//
// Hermes handles path-prefixing natively via X-Forwarded-Prefix (no HTML rewrite),
// and v0.17 authorises WebSockets with single-use ws-tickets, so this route is pure
// HTTP transport; the WS upgrade is proxied in server.mjs. The dashboard is reachable
// from the controller container at http://<bridgeIp>:<port> (the desktop-mode forward).

const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade', 'content-length', 'accept-encoding', 'host',
])

function proxyPrefix(sandboxId: string) {
  return `/api/sandbox/${encodeURIComponent(sandboxId)}/hermes/dashboard/proxy`
}

function upstreamBase(access: { bridgeIp?: string; port: number }) {
  const host = access.bridgeIp && access.bridgeIp.trim() ? access.bridgeIp.trim() : '127.0.0.1'
  return `http://${host}:${access.port}`
}

async function proxy(request: Request, sandboxId: string) {
  const access = readHermesRemoteAccess(sandboxId) as (ReturnType<typeof readHermesRemoteAccess> & { bridgeIp?: string }) | null
  if (!access) {
    return NextResponse.json(
      { ok: false, error: `Hermes sandbox '${sandboxId}' is not exposed yet — enable remote access first.` },
      { status: 404 },
    )
  }

  const reqUrl = new URL(request.url)
  const prefix = proxyPrefix(sandboxId)
  const upstreamPath = reqUrl.pathname.startsWith(prefix) ? reqUrl.pathname.slice(prefix.length) || '/' : '/'
  const target = new URL(upstreamPath + reqUrl.search, upstreamBase(access))

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
  headers.set('x-forwarded-prefix', prefix)
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
  if (location && location.startsWith('/')) responseHeaders.set('location', `${prefix}${location}`)

  const responseBody =
    method === 'HEAD' || upstream.status === 204 || upstream.status === 304
      ? null
      : (Readable.toWeb(upstream.stream) as unknown as ReadableStream)
  return new NextResponse(responseBody, { status: upstream.status, headers: responseHeaders })
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
