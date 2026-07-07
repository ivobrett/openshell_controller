const OPENCLAW_SANDBOX_LOGO = "/sandbox-logos/openclaw.svg"
const HERMES_SANDBOX_LOGO = "/sandbox-logos/hermes.png"

export function SandboxTypeLogo({ agent, size = "md" }: { agent?: string; size?: "sm" | "md" }) {
  const isHermes = agent === "hermes"
  const isCustom = agent === "custom"
  const label = isHermes ? "Hermes sandbox" : isCustom ? "Custom sandbox" : "OpenClaw sandbox"
  const logoSrc = isHermes ? HERMES_SANDBOX_LOGO : OPENCLAW_SANDBOX_LOGO
  const borderBg = isHermes
    ? "border-sky-300/60 bg-sky-500/15"
    : isCustom
      ? "border-border bg-muted/40"
      : "border-rose-300/60 bg-rose-500/15"
  const dim = size === "sm" ? "h-6 w-6" : "h-8 w-8"
  const logoDim = size === "sm" ? "h-4 w-4" : "h-6 w-6"
  const iconDim = size === "sm" ? "h-3 w-3" : "h-4 w-4"
  return (
    <span
      aria-label={label}
      title={label}
      className={`flex ${dim} shrink-0 items-center justify-center rounded-md border shadow-inner ${borderBg}`}
    >
      {isCustom ? (
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
