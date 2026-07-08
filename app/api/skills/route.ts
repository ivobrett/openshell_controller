import { readdir, readFile, stat } from "node:fs/promises"
import path from "node:path"
import { NextResponse } from "next/server"

const SKILLS_DIR = process.env.SKILLS_DIR ?? path.join(process.cwd(), "skills")
const ID_RE = /^[a-z0-9][a-z0-9._-]{0,80}\.md$/

type SkillMeta = {
  id: string
  name: string
  description: string
  tags: string[]
  agents: string
  updatedAt: string
}

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

export async function GET() {
  try {
    const entries = await readdir(SKILLS_DIR)
    const skills: SkillMeta[] = []
    for (const filename of entries) {
      if (!ID_RE.test(filename)) continue
      try {
        const filepath = path.join(SKILLS_DIR, filename)
        const [raw, info] = await Promise.all([readFile(filepath, "utf8"), stat(filepath)])
        const parsed = parseFrontmatter(raw)
        if (!parsed) continue
        const { meta } = parsed
        if (!meta.name || !meta.description) continue
        skills.push({
          id: filename,
          name: meta.name,
          description: meta.description,
          tags: meta.tags ? meta.tags.split(",").map((t) => t.trim()).filter(Boolean) : [],
          agents: meta.agents || "any",
          updatedAt: info.mtime.toISOString(),
        })
      } catch {
        // skip unreadable files
      }
    }
    skills.sort((a, b) => a.name.localeCompare(b.name))
    return NextResponse.json({ ok: true, skills })
  } catch {
    return NextResponse.json({ ok: true, skills: [] })
  }
}
