import { displaySandboxAgent } from "@/app/lib/agentDisplay"

const OPENCLAW_SANDBOX_LOGO = "/sandbox-logos/openclaw.svg"
const HERMES_SANDBOX_LOGO = "/sandbox-logos/hermes.png"

// Visual identity per agent kind. OpenClaw and Hermes have real logos;
// Custom keeps its terminal glyph; every other NemoClaw agent (Deep Agents
// today, future runtimes tomorrow) gets a shared "agent nodes" glyph so it
// never masquerades as OpenClaw (see app/lib/agentDisplay.ts).
type AgentKind = "openclaw" | "hermes" | "custom" | "other"

function agentKind(agent?: string): AgentKind {
  const key = typeof agent === "string" ? agent.trim().toLowerCase() : ""
  if (!key || key === "openclaw") return "openclaw"
  if (key === "hermes") return "hermes"
  if (key === "custom") return "custom"
  return "other"
}

export function SandboxTypeLogo({ agent, size = "md" }: { agent?: string; size?: "sm" | "md" | "lg" }) {
  const kind = agentKind(agent)
  const label = `${displaySandboxAgent(agent)} sandbox`
  const logoSrc = kind === "hermes" ? HERMES_SANDBOX_LOGO : OPENCLAW_SANDBOX_LOGO
  const borderBg =
    kind === "hermes"
      ? "border-sky-300/60 bg-sky-500/15"
      : kind === "custom"
        ? "border-border bg-muted/40"
        : kind === "other"
          ? "border-emerald-300/60 bg-emerald-500/15"
          : "border-rose-300/60 bg-rose-500/15"
  const dim = size === "sm" ? "h-6 w-6" : size === "lg" ? "h-16 w-16" : "h-8 w-8"
  const logoDim = size === "sm" ? "h-4 w-4" : size === "lg" ? "h-11 w-11" : "h-6 w-6"
  const iconDim = size === "sm" ? "h-3 w-3" : size === "lg" ? "h-8 w-8" : "h-4 w-4"
  return (
    <span
      aria-label={label}
      title={label}
      className={`flex ${dim} shrink-0 items-center justify-center rounded-md border shadow-inner ${borderBg}`}
    >
      {kind === "custom" ? (
        <svg
          className={`${iconDim} text-muted-foreground`}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          strokeLinecap="square"
          strokeLinejoin="miter"
          aria-hidden="true"
        >
          <rect x="3" y="4" width="18" height="14" rx="1" />
          <path d="M7 9l3 3-3 3M13 15h4" />
        </svg>
      ) : kind === "other" ? (
        <svg
          className={`${iconDim} text-emerald-500`}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <circle cx="12" cy="5" r="2.5" />
          <circle cx="5.5" cy="18" r="2.5" />
          <circle cx="18.5" cy="18" r="2.5" />
          <path d="M10.8 7.2 7 15.6M13.2 7.2 17 15.6M8 18h8" />
        </svg>
      ) : (
        <span
          aria-hidden="true"
          className={`${logoDim} bg-contain bg-center bg-no-repeat`}
          style={{ backgroundImage: `url(${logoSrc})` }}
        />
      )}
    </span>
  )
}
