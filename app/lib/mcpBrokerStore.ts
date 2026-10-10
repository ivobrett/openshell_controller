import { createHash, randomBytes, timingSafeEqual } from "node:crypto"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { listMcpServers, sandboxCanAccessMcpServer } from "./mcpServerStore"

export type SandboxMcpBrokerSession = {
  sandboxId: string
  sandboxName: string | null
  tokenHash: string
  enabled: boolean
  createdAt: string
  rotatedAt: string
  expiresAt: string | null
}

type StoreShape = {
  sessions: Record<string, SandboxMcpBrokerSession>
}

const HOME = process.env.HOME || "/tmp"
const STORE_DIR = process.env.NEMOCLAW_DASHBOARD_STATE_DIR || path.join(HOME, ".nemoclaw-dashboard")
const STORE_PATH = path.join(STORE_DIR, "mcp-broker-sessions.json")
const DEFAULT_TOKEN_TTL_HOURS = Number.parseInt(process.env.MCP_BROKER_TOKEN_TTL_HOURS || "168", 10)

function emptyStore(): StoreShape {
  return { sessions: {} }
}

async function readStore(): Promise<StoreShape> {
  try {
    const raw = await readFile(STORE_PATH, "utf8")
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === "object" && parsed.sessions && typeof parsed.sessions === "object"
      ? parsed
      : emptyStore()
  } catch {
    return emptyStore()
  }
}

async function writeStore(store: StoreShape) {
  await mkdir(STORE_DIR, { recursive: true, mode: 0o700 })
  await writeFile(STORE_PATH, JSON.stringify(store, null, 2), { mode: 0o600 })
}

function tokenHash(token: string) {
  return createHash("sha256").update(token).digest("hex")
}

function safeEqual(left: string, right: string) {
  const leftBuffer = Buffer.from(left)
  const rightBuffer = Buffer.from(right)
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer)
}

function expiryFromNow() {
  if (!Number.isFinite(DEFAULT_TOKEN_TTL_HOURS) || DEFAULT_TOKEN_TTL_HOURS <= 0) return null
  return new Date(Date.now() + DEFAULT_TOKEN_TTL_HOURS * 60 * 60 * 1000).toISOString()
}

export async function rotateSandboxMcpBrokerSession(sandboxId: string, sandboxName?: string | null) {
  const store = await readStore()
  const token = `osmcp_${randomBytes(32).toString("base64url")}`
  const now = new Date().toISOString()
  const existing = store.sessions[sandboxId]
  const session: SandboxMcpBrokerSession = {
    sandboxId,
    sandboxName: sandboxName || existing?.sandboxName || null,
    tokenHash: tokenHash(token),
    enabled: true,
    createdAt: existing?.createdAt || now,
    rotatedAt: now,
    expiresAt: expiryFromNow(),
  }
  store.sessions[sandboxId] = session
  await writeStore(store)
  return { session, token }
}

export async function verifySandboxMcpBrokerToken(token: string) {
  const store = await readStore()
  const hash = tokenHash(token)
  const session = Object.values(store.sessions).find((candidate) => safeEqual(candidate.tokenHash, hash))
  if (!session || !session.enabled) return null
  if (session.expiresAt && Date.parse(session.expiresAt) <= Date.now()) return null
  // Sliding expiry: a token that is in use keeps working. A fixed lifetime cut
  // every sandbox off the broker after MCP_BROKER_TOKEN_TTL_HOURS (7 days by
  // default) until an operator re-issued access by hand; agents reported that
  // as "can't access the MCP server". Renewal is written at most once per half
  // lifetime, and revoking or re-issuing still invalidates the token at once.
  const renewed = expiryFromNow()
  if (session.expiresAt && renewed) {
    const halfLifeMs = (DEFAULT_TOKEN_TTL_HOURS * 60 * 60 * 1000) / 2
    if (Date.parse(session.expiresAt) - Date.now() < halfLifeMs) {
      session.expiresAt = renewed
      await writeStore(store).catch(() => null)
    }
  }
  return session
}

export async function revokeSandboxMcpBrokerSession(sandboxId: string) {
  const store = await readStore()
  const existing = store.sessions[sandboxId]
  if (!existing) return null
  store.sessions[sandboxId] = {
    ...existing,
    enabled: false,
    rotatedAt: new Date().toISOString(),
    expiresAt: new Date().toISOString(),
  }
  await writeStore(store)
  return store.sessions[sandboxId]
}

export async function listAllowedBrokerServers(session: SandboxMcpBrokerSession) {
  const inventory = await listMcpServers()
  return inventory.servers.filter((server) => sandboxCanAccessMcpServer(server, session.sandboxId, session.sandboxName))
}

export function readBrokerToken(request: Request) {
  const authorization = request.headers.get("authorization") || ""
  const bearer = authorization.match(/^Bearer\s+(.+)$/i)?.[1]?.trim()
  return bearer || request.headers.get("x-openshell-mcp-token")?.trim() || ""
}

// --- inter-sandbox directory -------------------------------------------------
// Agents kept confusing sandbox names with personas ("Jynx") and with names of
// sandboxes that no longer exist. The broker is the one place that knows which
// sandboxes hold a live session, so it serves the directory; each agent may add
// a short self-description so a human-style name can be resolved to a sandbox.

export type SandboxPeerProfile = {
  about: string
  runtime: string
  listening: boolean
  updatedAt: string
}

const PROFILE_PATH = path.join(STORE_DIR, "mcp-broker-profiles.json")
export const PEER_ABOUT_MAX_LENGTH = 200

export function cleanPeerText(value: unknown, maxLength: number) {
  return String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength)
}

async function readProfiles(): Promise<Record<string, SandboxPeerProfile>> {
  try {
    const parsed = JSON.parse(await readFile(PROFILE_PATH, "utf8"))
    return parsed && typeof parsed === "object" ? parsed : {}
  } catch {
    return {}
  }
}

export async function listActiveBrokerSessions() {
  const store = await readStore()
  const now = Date.now()
  return Object.values(store.sessions).filter((session) => (
    session.enabled && !(session.expiresAt && Date.parse(session.expiresAt) <= now)
  ))
}

export async function listSandboxPeerProfiles() {
  return readProfiles()
}

export async function updateSandboxPeerProfile(
  sandboxId: string,
  patch: { about?: unknown; runtime?: unknown; listening?: unknown },
) {
  const profiles = await readProfiles()
  const current = profiles[sandboxId] || { about: "", runtime: "", listening: false, updatedAt: "" }
  const next: SandboxPeerProfile = {
    about: patch.about === undefined ? current.about : cleanPeerText(patch.about, PEER_ABOUT_MAX_LENGTH),
    runtime: patch.runtime === undefined ? current.runtime : cleanPeerText(patch.runtime, 24).toLowerCase(),
    listening: patch.listening === undefined ? current.listening : patch.listening === true,
    updatedAt: new Date().toISOString(),
  }
  profiles[sandboxId] = next
  await mkdir(STORE_DIR, { recursive: true, mode: 0o700 })
  await writeFile(PROFILE_PATH, JSON.stringify(profiles, null, 2), { mode: 0o600 })
  return next
}
