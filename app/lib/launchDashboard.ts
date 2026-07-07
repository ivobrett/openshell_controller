export function launchOpenClawDashboard(sandboxName: string) {
  window.open(
    `/launch/dashboard?sandboxId=${encodeURIComponent(sandboxName)}`,
    "_blank",
    "noopener,noreferrer",
  )
}
