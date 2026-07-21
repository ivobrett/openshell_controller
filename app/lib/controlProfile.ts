/**
 * OpenShell Control install profile.
 *
 * `full` (default) — the complete controller: NemoClaw/OpenClaw/Hermes
 * blueprints, OpenClaw dashboards, inference routing, and the MCP broker.
 * This is what every existing install runs; nothing changes for them.
 *
 * `minimal` — a stripped-back controller for a host that only has the
 * OpenShell CLI + a local gateway (e.g. the `openshell` snap). It manages
 * plain custom sandboxes only: no NemoClaw, no OpenClaw dashboards, no
 * inference routing, no MCP broker. Selected at install time by
 * `./install.sh --minimal`, which writes `OPENSHELL_CONTROL_PROFILE=minimal`
 * (and the `NEXT_PUBLIC_` mirror) to `.env.local`.
 *
 * The profile is read from `process.env` on every call so the Node-runtime
 * middleware/routes pick up config changes without a restart (same reasoning
 * as the auth library — see CLAUDE.md §6).
 */

export type ControlProfile = "full" | "minimal"

function normalizeProfile(raw: string | undefined): ControlProfile {
  return (raw || "").trim().toLowerCase() === "minimal" ? "minimal" : "full"
}

/** Server-side profile (reads OPENSHELL_CONTROL_PROFILE). */
export function controlProfile(): ControlProfile {
  return normalizeProfile(process.env.OPENSHELL_CONTROL_PROFILE)
}

export function isMinimalProfile(): boolean {
  return controlProfile() === "minimal"
}

/**
 * Client-safe profile. Next.js inlines `NEXT_PUBLIC_*` at build time, so this
 * is usable from client components. Falls back to the server var when this
 * module is evaluated on the server.
 */
export function clientControlProfile(): ControlProfile {
  return normalizeProfile(
    process.env.NEXT_PUBLIC_OPENSHELL_CONTROL_PROFILE ?? process.env.OPENSHELL_CONTROL_PROFILE,
  )
}

export function isMinimalClientProfile(): boolean {
  return clientControlProfile() === "minimal"
}
