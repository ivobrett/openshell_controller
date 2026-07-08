// Filters an inventory payload for an OAuth user. `allowed` is a Set of
// sandbox names. Matches on sandbox name OR id (the UI and access store key
// by name; ids can equal names for docker-driver sandboxes).
export function filterInventoryForUser(payload, allowed) {
  const out = { ...payload }
  if (Array.isArray(out.sandboxes)) {
    out.sandboxes = out.sandboxes.filter(
      (s) => allowed.has(s?.name) || allowed.has(s?.id),
    )
  }
  if (out.pods?.items) {
    out.pods = {
      ...out.pods,
      items: out.pods.items.filter((pod) => {
        const labels = pod?.metadata?.labels || {}
        return (
          allowed.has(labels["nemoclaw.ai/sandbox-name"]) ||
          allowed.has(labels["nemoclaw.ai/sandbox-id"]) ||
          allowed.has(pod?.metadata?.name)
        )
      }),
    }
  }
  if (out.nemoclaw) {
    // Reduce host-level gateway detail for non-operators: keep availability,
    // drop service/summary lines and default names not in the allowed set.
    out.nemoclaw = {
      ...out.nemoclaw,
      defaultSandboxNames: (out.nemoclaw.defaultSandboxNames || []).filter((n) => allowed.has(n)),
      serviceLines: [],
      summaryLines: [],
    }
  }
  return out
}
