import { NextResponse } from "next/server"
import {
  listActiveBrokerSessions,
  listSandboxPeerProfiles,
  readBrokerToken,
  updateSandboxPeerProfile,
  verifySandboxMcpBrokerToken,
} from "@/app/lib/mcpBrokerStore"
import { listMcpServers, sandboxCanAccessMcpServer } from "@/app/lib/mcpServerStore"
import { listLiveSandboxRefs } from "@/app/lib/mcpSandboxAutoSync"

const CHAT_SERVER_ID = "inter-sandbox-chat"

function unavailable(status = 401) {
  return NextResponse.json({ ok: false, error: "MCP broker is unavailable for this sandbox." }, { status })
}

async function authenticate(request: Request) {
  const token = readBrokerToken(request)
  return token ? verifySandboxMcpBrokerToken(token) : null
}

/**
 * The inter-sandbox directory: which sandboxes can be messaged right now.
 * A sandbox is listed when it exists, holds a live broker session and is
 * granted the Inter-Sandbox Chat server. Names of deleted sandboxes and
 * personas never appear, so an agent can treat this list as the only valid
 * set of addresses.
 */
export async function GET(request: Request) {
  try {
    const session = await authenticate(request)
    if (!session) return unavailable()

    const [sessions, profiles, inventory, live] = await Promise.all([
      listActiveBrokerSessions(),
      listSandboxPeerProfiles(),
      listMcpServers(),
      listLiveSandboxRefs().catch(() => null),
    ])
    const chat = inventory.servers.find((server) => server.id === CHAT_SERVER_ID)
    const liveIds = live ? new Set(live.map((sandbox) => sandbox.id)) : null
    const liveNames = live ? new Set(live.map((sandbox) => sandbox.name)) : null

    const peers = sessions
      .filter((candidate) => candidate.sandboxName)
      // A recreated sandbox keeps its name but gets a new id, and its old
      // session lingers: match on id, and on name only when the id of the
      // live sandbox could not be resolved.
      .filter((candidate) => !liveIds || liveIds.has(candidate.sandboxId) || liveIds.has(candidate.sandboxName || ""))
      .filter((candidate) => !liveNames || liveNames.has(candidate.sandboxName || ""))
      .filter((candidate, index, all) => all.findIndex((other) => other.sandboxName === candidate.sandboxName) === index)
      .filter((candidate) => !chat || sandboxCanAccessMcpServer(chat, candidate.sandboxId, candidate.sandboxName))
      .map((candidate) => {
        const profile = profiles[candidate.sandboxId]
        return {
          name: candidate.sandboxName as string,
          you: candidate.sandboxId === session.sandboxId,
          runtime: profile?.runtime || "",
          about: profile?.about || "",
          listening: profile?.listening === true,
        }
      })
      .sort((left, right) => left.name.localeCompare(right.name))

    return NextResponse.json({
      ok: true,
      you: session.sandboxName || session.sandboxId,
      peers,
    })
  } catch {
    return unavailable(500)
  }
}

/** A sandbox describes itself. It can only ever change its own entry. */
export async function POST(request: Request) {
  try {
    const session = await authenticate(request)
    if (!session) return unavailable()
    const body = await request.json().catch(() => null)
    if (!body || typeof body !== "object") {
      return NextResponse.json({ ok: false, error: "A JSON object is required." }, { status: 400 })
    }
    const profile = await updateSandboxPeerProfile(session.sandboxId, {
      about: (body as Record<string, unknown>).about,
      runtime: (body as Record<string, unknown>).runtime,
      listening: (body as Record<string, unknown>).listening,
    })
    return NextResponse.json({ ok: true, you: session.sandboxName || session.sandboxId, profile })
  } catch {
    return unavailable(500)
  }
}
