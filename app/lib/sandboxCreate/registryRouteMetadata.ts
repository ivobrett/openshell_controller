// Durable inference-route metadata for ~/.nemoclaw/sandboxes.json rows.
//
// Why this exists (2026-07-09, NemoClaw v0.0.78): the OpenClaw blueprint
// create SIGTERMs `nemoclaw onboard` as soon as the sandbox is Ready (the
// policy step 8/8 reliably hangs — see the comment at the call site in
// app/api/sandbox/create/route.ts). On NemoClaw <= v0.0.74 that was benign;
// since v0.0.78, onboarding writes the row's route fields (provider/model/
// endpointUrl/credentialEnv/preferredInferenceApi) only AFTER the point we
// kill it, and v0.0.78's gateway-route-compatibility check refuses EVERY
// subsequent create/recover on the gateway while any registered row lacks
// provider+model ("lacks durable provider or model metadata"). So each
// Quick-Created OpenClaw sandbox used to brick the next create.
//
// The fix leans on v0.0.78's own invariant: an OpenShell gateway has exactly
// ONE inference route shared by every registered sandbox (a create requesting
// a different route fails before the sandbox exists). Therefore any sibling
// row with a complete route IS this sandbox's route, and copying it records
// reality rather than inventing it. When there is no sibling (first sandbox
// on the gateway), the last completed onboarding session
// (~/.nemoclaw/onboard-session.json) carries the same fields.
//
// This module is pure planning logic; the file IO lives next to the other
// registry patch helpers in app/api/sandbox/create/route.ts.
// Runbook: docs/runbooks/live-vps-upgrades.md (Trap 3).

export const ROUTE_METADATA_FIELDS = [
  "provider",
  "model",
  "endpointUrl",
  "credentialEnv",
  "preferredInferenceApi",
] as const

export type RouteMetadataField = (typeof ROUTE_METADATA_FIELDS)[number]

type Row = Record<string, unknown>

function nonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null
  const trimmed = value.trim()
  return trimmed || null
}

// Mirrors upstream's configuredRoute(): a route is durable when provider AND
// model are non-empty strings. endpointUrl / API-family completeness only
// matters for custom-endpoint providers, which same-gateway creates cannot
// diverge on anyway.
export function hasDurableRoute(row: unknown): boolean {
  if (!row || typeof row !== "object") return false
  const entry = row as Row
  return Boolean(nonEmptyString(entry.provider) && nonEmptyString(entry.model))
}

export type RouteMetadataPlan =
  | { action: "none"; reason: "no-entry" | "already-durable" | "no-source" | "provider-mismatch" }
  | { action: "patch"; entry: Row; filledFields: RouteMetadataField[]; sourceKind: "sibling" | "onboard-session" }

export function planRouteMetadataPatch(
  registry: unknown,
  sandboxName: string,
  onboardSession: unknown,
): RouteMetadataPlan {
  const sandboxes =
    registry && typeof registry === "object" && (registry as Row).sandboxes && typeof (registry as Row).sandboxes === "object"
      ? ((registry as Row).sandboxes as Record<string, unknown>)
      : {}
  const entry = sandboxes[sandboxName]
  if (!entry || typeof entry !== "object") return { action: "none", reason: "no-entry" }
  if (hasDurableRoute(entry)) return { action: "none", reason: "already-durable" }

  let source: Row | null = null
  let sourceKind: "sibling" | "onboard-session" = "sibling"
  for (const [name, row] of Object.entries(sandboxes)) {
    if (name === sandboxName) continue
    if (hasDurableRoute(row)) {
      source = row as Row
      break
    }
  }
  if (!source && hasDurableRoute(onboardSession)) {
    source = onboardSession as Row
    sourceKind = "onboard-session"
  }
  if (!source) return { action: "none", reason: "no-source" }

  // Never mix routes: if the row already names a provider and it differs from
  // the source's, filling the remaining fields would fabricate a hybrid route.
  // One-route-per-gateway means this shouldn't happen; if it does, leave the
  // row alone and let the operator resolve it (runbook Trap 3).
  const rowProvider = nonEmptyString((entry as Row).provider)
  const sourceProvider = nonEmptyString(source.provider)
  if (rowProvider && sourceProvider && rowProvider !== sourceProvider) {
    return { action: "none", reason: "provider-mismatch" }
  }

  const merged: Row = { ...(entry as Row) }
  const filledFields: RouteMetadataField[] = []
  for (const field of ROUTE_METADATA_FIELDS) {
    if (nonEmptyString(merged[field])) continue
    const value = nonEmptyString(source[field])
    if (value) {
      merged[field] = value
      filledFields.push(field)
    }
  }
  if (filledFields.length === 0) return { action: "none", reason: "no-source" }
  return { action: "patch", entry: merged, filledFields, sourceKind }
}
