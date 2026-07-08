import { readFile, stat } from "node:fs/promises"
import path from "node:path"
import { NextRequest, NextResponse } from "next/server"

const SKILLS_DIR = process.env.SKILLS_DIR ?? path.join(process.cwd(), "skills")
const ID_RE = /^[a-z0-9][a-z0-9._-]{0,80}\.md$/

function parseFrontmatter(raw: string): { meta: Record<string, string>; body: string } | null {
  if (!raw.startsWith("---")) return null
  const end = raw.indexOf("---", 3)
  if (end === -1) return null
  const fm = raw.slice(3, end).trim()
  const body = raw.slice(end + 3).trim()
  const meta: Record<string, string> = {}
  for (const line of fm.split("\n")) {
    const colon = line.indexOf(":")
    if (colon === -1) continue
    meta[line.slice(0, colon).trim()] = line.slice(colon + 1).trim()
  }
  return { meta, body }
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ skillId: string }> },
) {
  const { skillId } = await params
  if (!ID_RE.test(skillId)) {
    return NextResponse.json({ ok: false, error: "Invalid skill id" }, { status: 400 })
  }
  const resolvedDir = path.resolve(SKILLS_DIR)
  const p = path.join(resolvedDir, skillId)
  if (!path.resolve(p).startsWith(resolvedDir + path.sep)) {
    return NextResponse.json({ ok: false, error: "Invalid skill id" }, { status: 400 })
  }
  try {
    const [raw, info] = await Promise.all([readFile(p, "utf8"), stat(p)])
    const parsed = parseFrontmatter(raw)
    if (!parsed) return NextResponse.json({ ok: false, error: "Not found" }, { status: 404 })
    const { meta, body } = parsed
    return NextResponse.json({
      ok: true,
      skill: {
        id: skillId,
        name: meta.name || skillId,
        description: meta.description || "",
        tags: meta.tags ? meta.tags.split(",").map((t: string) => t.trim()).filter(Boolean) : [],
        agents: meta.agents || "any",
        updatedAt: info.mtime.toISOString(),
        content: body,
      },
    })
  } catch {
    return NextResponse.json({ ok: false, error: "Not found" }, { status: 404 })
  }
}
