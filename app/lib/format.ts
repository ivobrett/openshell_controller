export function relativeTime(isoString: string): string {
  const now = Date.now()
  const then = new Date(isoString).getTime()
  if (isNaN(then)) return "unknown"
  const diff = Math.max(0, now - then)
  const seconds = Math.floor(diff / 1000)
  if (seconds < 60) return `${seconds}s ago`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

/**
 * Compact absolute timestamp, e.g. "Jul 6, 14:32:10". Second precision so the
 * elapsed time between events that share a relative bucket ("2d ago") is
 * still legible.
 */
export function absoluteTime(isoString: string): string {
  const d = new Date(isoString)
  if (isNaN(d.getTime())) return ""
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  })
}
