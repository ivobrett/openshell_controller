import { cn } from "@/app/lib/utils"

export type LedStatus = "running" | "pending" | "stopped" | "error" | "unknown"

const LED: Record<LedStatus, { dot: string; text: string; label: string }> = {
  running: { dot: "bg-primary shadow-[0_0_6px_2px_rgba(118,185,0,0.55)]", text: "text-primary", label: "RUNNING" },
  pending: { dot: "bg-warning shadow-[0_0_6px_2px_rgba(251,191,36,0.45)] animate-pulse motion-reduce:animate-none", text: "text-warning", label: "PENDING" },
  stopped: { dot: "bg-destructive", text: "text-destructive", label: "STOPPED" },
  error:   { dot: "bg-destructive animate-pulse motion-reduce:animate-none", text: "text-destructive", label: "ERROR" },
  unknown: { dot: "bg-muted-foreground", text: "text-muted-foreground", label: "UNKNOWN" },
}

export function StatusLed({ status, showLabel = true, dotOnly, ready: _ready, className }: {
  status: LedStatus; showLabel?: boolean; dotOnly?: boolean; ready?: boolean; className?: string
}) {
  const s = LED[status] ?? LED.unknown
  const showText = showLabel && !dotOnly
  return (
    <span className={cn("inline-flex items-center gap-1.5", className)}>
      <span aria-hidden className={cn("h-2 w-2 rounded-full", s.dot)} />
      {showText && <span className={cn("font-mono text-[11px] uppercase tracking-wider", s.text)}>{s.label}</span>}
    </span>
  )
}
