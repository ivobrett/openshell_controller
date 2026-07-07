"use client"
import { useState } from "react"
import { BookOpen, Check, Copy } from "lucide-react"
import { toast } from "sonner"
import { useQuery } from "@tanstack/react-query"
import { apiFetch } from "@/app/lib/apiFetch"
import { PageHeader } from "@/app/components/PageHeader"
import { Input } from "@/app/components/ui/input"
import { Button } from "@/app/components/ui/button"
import { Badge } from "@/app/components/ui/badge"
import { Card } from "@/app/components/ui/card"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/app/components/ui/dialog"

type SkillMeta = {
  id: string
  name: string
  description: string
  tags: string[]
  agents: string
}

function useSkills() {
  return useQuery({
    queryKey: ["skills"],
    queryFn: () => apiFetch<{ ok: boolean; skills: SkillMeta[] }>("/api/skills"),
    staleTime: 30_000,
    select: (d) => d.skills ?? [],
  })
}

function SkillCard({ skill }: { skill: SkillMeta }) {
  const [copied, setCopied] = useState(false)
  const [viewOpen, setViewOpen] = useState(false)
  const [viewContent, setViewContent] = useState<string | null>(null)
  const [viewCopied, setViewCopied] = useState(false)

  const fetchContent = async (): Promise<string> => {
    const data = await apiFetch<{ ok: boolean; skill: { content: string } }>(
      `/api/skills/${encodeURIComponent(skill.id)}`,
    )
    return data.skill.content
  }

  const handleCopy = async () => {
    try {
      const content = await fetchContent()
      await navigator.clipboard.writeText(content)
      toast.success(`Copied "${skill.name}"`)
      setCopied(true)
      setTimeout(() => setCopied(false), 1800)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to copy")
    }
  }

  const handleView = async () => {
    setViewOpen(true)
    if (viewContent === null) {
      try {
        setViewContent(await fetchContent())
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Failed to load skill")
        setViewOpen(false)
      }
    }
  }

  const handleViewCopy = async () => {
    if (!viewContent) return
    try {
      await navigator.clipboard.writeText(viewContent)
      toast.success(`Copied "${skill.name}"`)
      setViewCopied(true)
      setTimeout(() => setViewCopied(false), 1800)
    } catch {
      toast.error("Failed to copy")
    }
  }

  return (
    <>
      <Card className="flex flex-col p-4 gap-3">
        <div className="flex-1 min-w-0 space-y-1">
          <p className="text-sm font-semibold leading-snug">{skill.name}</p>
          <p className="text-xs text-muted-foreground line-clamp-2">{skill.description}</p>
          {(skill.tags.length > 0 || skill.agents !== "any") && (
            <div className="flex flex-wrap gap-1 pt-1">
              {skill.agents !== "any" && (
                <Badge variant="secondary" className="text-[10px] px-1.5 py-0">
                  {skill.agents}
                </Badge>
              )}
              {skill.tags.map((tag) => (
                <Badge key={tag} variant="outline" className="text-[10px] px-1.5 py-0">
                  {tag}
                </Badge>
              ))}
            </div>
          )}
        </div>
        <div className="flex gap-2 pt-1 border-t border-border">
          <Button size="sm" variant="outline" className="flex-1 h-7 text-xs gap-1.5" onClick={handleCopy}>
            {copied ? <Check className="h-3 w-3 text-primary" /> : <Copy className="h-3 w-3" />}
            {copied ? "Copied" : "Copy"}
          </Button>
          <Button size="sm" variant="ghost" className="flex-1 h-7 text-xs" onClick={handleView}>
            View
          </Button>
        </div>
      </Card>

      <Dialog open={viewOpen} onOpenChange={setViewOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>{skill.name}</DialogTitle>
          </DialogHeader>
          <div className="max-h-[60vh] overflow-y-auto rounded border border-border bg-muted/40 p-4">
            {viewContent === null ? (
              <p className="text-xs text-muted-foreground font-mono">Loading…</p>
            ) : (
              <pre className="text-xs font-mono whitespace-pre-wrap break-words leading-relaxed">
                {viewContent}
              </pre>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={handleViewCopy} disabled={!viewContent}>
              {viewCopied ? <Check className="h-3.5 w-3.5 mr-1.5 text-primary" /> : <Copy className="h-3.5 w-3.5 mr-1.5" />}
              {viewCopied ? "Copied" : "Copy"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}

export default function SkillsPage() {
  const { data: skills = [], isLoading } = useSkills()
  const [search, setSearch] = useState("")

  const filtered = skills.filter((s) => {
    if (!search) return true
    const q = search.toLowerCase()
    return (
      s.name.toLowerCase().includes(q) ||
      s.description.toLowerCase().includes(q) ||
      s.tags.some((t) => t.toLowerCase().includes(q))
    )
  })

  return (
    <>
      <PageHeader
        title="Skills"
        description="Reusable setup prompts for configuring agents. Copy one and paste it into the agent's prompt."
      />

      <div className="mb-4 max-w-sm">
        <Input
          placeholder="Search by name, description, or tag…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="h-8 text-sm"
        />
      </div>

      {isLoading ? (
        <p className="text-xs font-mono text-muted-foreground">Loading…</p>
      ) : filtered.length === 0 && skills.length === 0 ? (
        <div className="py-20 flex flex-col items-center gap-3 text-center">
          <BookOpen className="h-10 w-10 text-muted-foreground" />
          <h3 className="text-sm font-semibold uppercase tracking-wider">No skills yet</h3>
          <p className="text-xs text-muted-foreground max-w-xs">
            Add markdown files to the repo&apos;s{" "}
            <code className="font-mono">skills/</code> directory — see{" "}
            <code className="font-mono">skills/README.md</code>.
          </p>
        </div>
      ) : filtered.length === 0 ? (
        <div className="py-12 text-center">
          <p className="text-sm text-muted-foreground">No skills match.</p>
          <button
            className="mt-2 text-xs underline underline-offset-2 hover:text-foreground text-muted-foreground"
            onClick={() => setSearch("")}
          >
            Clear search
          </button>
        </div>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {filtered.map((skill) => (
            <SkillCard key={skill.id} skill={skill} />
          ))}
        </div>
      )}
    </>
  )
}
