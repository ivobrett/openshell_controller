// Type companion for filterInventory.mjs (plain ESM so tests can import it
// without TS tooling, matching the policy.mjs / policy.d.ts pattern).
export function filterInventoryForUser<T>(payload: T, allowed: Set<string>): T
