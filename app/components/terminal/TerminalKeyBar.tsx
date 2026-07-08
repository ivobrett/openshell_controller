"use client"

import { cn } from "@/app/lib/utils"

// §12.3(d) — mobile key toolbar. Rendered only on coarse-pointer devices. Sends
// raw byte sequences via the terminal connection's sendInput; the Ctrl button
// is a latching toggle handled inside useTerminalConnection (the next printable
// key becomes a control code).

interface TerminalKeyBarProps {
  sendInput: (seq: string) => void
  ctrlLatched: boolean
  onToggleCtrl: () => void
}

const KEYS: { label: string; seq: string }[] = [
  { label: "Esc", seq: "\x1b" },
  { label: "Tab", seq: "\t" },
  { label: "↑", seq: "\x1b[A" },
  { label: "↓", seq: "\x1b[B" },
  { label: "←", seq: "\x1b[D" },
  { label: "→", seq: "\x1b[C" },
  { label: "^C", seq: "\x03" },
]

export function TerminalKeyBar({ sendInput, ctrlLatched, onToggleCtrl }: TerminalKeyBarProps) {
  const paste = async () => {
    try {
      const text = await navigator.clipboard.readText()
      if (text) sendInput(text)
    } catch {
      // clipboard read denied — nothing to do
    }
  }

  const btn =
    "shrink-0 rounded-sm border border-border px-3 py-1.5 text-xs font-mono text-foreground hover:border-primary hover:text-primary transition-colors"

  return (
    <div className="flex gap-1.5 overflow-x-auto py-1 -mx-1 px-1">
      <button type="button" className={btn} onClick={() => sendInput("\x1b")}>
        Esc
      </button>
      <button type="button" className={btn} onClick={() => sendInput("\t")}>
        Tab
      </button>
      <button
        type="button"
        onClick={onToggleCtrl}
        aria-pressed={ctrlLatched}
        className={cn(btn, ctrlLatched && "border-primary text-primary bg-primary/10")}
      >
        Ctrl
      </button>
      {KEYS.filter((k) => !["Esc", "Tab"].includes(k.label)).map((k) => (
        <button key={k.label} type="button" className={btn} onClick={() => sendInput(k.seq)}>
          {k.label}
        </button>
      ))}
      <button type="button" className={btn} onClick={paste}>
        Paste
      </button>
    </div>
  )
}
