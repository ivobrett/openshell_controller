"use client"
import { useState } from "react"
import { Check, Copy } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/app/components/ui/button"
import { Input } from "@/app/components/ui/input"

type SkillMeta = {
  id: string
  name: string
  description: string
  tags: string[]
  agents: string
}

interface SkillsQuickListProps {
  skills: SkillMeta[]
}

export function SkillsQuickList({ skills }: SkillsQuickListProps) {
  const [search, setSearch] = useState("")
  const [copiedId, setCopiedId] = useState<string | null>(null)

  const filtered = skills.filter((s) => {
    if (!search) return true
    const q = search.toLowerCase()
    return (
      s.name.toLowerCase().includes(q) ||
      s.description.toLowerCase().includes(q) ||
      s.tags.some((t) => t.toLowerCase().includes(q))
    )
  })

  const handleCopy = async (skill: SkillMeta) => {
    try {
      const res = await fetch(`/api/skills/${encodeURIComponent(skill.id)}`)
      const data = await res.json()
      if (!data.ok) throw new Error(data.error || "Failed to load skill")
      await navigator.clipboard.writeText(data.skill.content)
      toast.success(`Copied "${skill.name}"`)
      setCopiedId(skill.id)
      setTimeout(() => setCopiedId((id) => (id === skill.id ? null : id)), 1800)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to copy")
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <Input
        placeholder="Search skills…"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        className="h-8 text-sm"
      />
      {filtered.length === 0 ? (
        <p className="text-xs text-muted-foreground py-4 text-center">No skills match.</p>
      ) : (
        <ul className="space-y-1">
          {filtered.map((skill) => (
            <li key={skill.id} className="flex items-start gap-2 py-2 border-b border-border last:border-0">
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium truncate">{skill.name}</p>
                <p className="text-xs text-muted-foreground line-clamp-2">{skill.description}</p>
              </div>
              <Button
                size="sm"
                variant="ghost"
                className="h-7 w-7 shrink-0 p-0"
                title={`Copy "${skill.name}"`}
                onClick={() => handleCopy(skill)}
              >
                {copiedId === skill.id ? (
                  <Check className="h-3.5 w-3.5 text-primary" />
                ) : (
                  <Copy className="h-3.5 w-3.5" />
                )}
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
