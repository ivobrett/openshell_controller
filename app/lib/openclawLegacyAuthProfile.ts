import { restartSandboxGatewayWithNemoClaw } from "./nemoclawCli"
import { retireLegacyOpenClawAuthProfile } from "./sandboxPrivilegedFiles"

// TEMPORARY SHIM for NemoClaw #12254 (see retireLegacyOpenClawAuthProfile).
// The gateway caches the migration refusal in-process, so a removal only takes
// effect after a native gateway restart. Never throws: create must not fail on
// this best-effort repair.
export async function repairLegacyOpenClawAuthProfile(sandboxName: string, options: { restartGateway?: boolean } = {}) {
  const restartGateway = options.restartGateway ?? true
  try {
    const retired = await retireLegacyOpenClawAuthProfile(sandboxName)
    if (!retired.changed || !restartGateway) return { ...retired, gatewayRestarted: false }
    const restart = await restartSandboxGatewayWithNemoClaw(sandboxName)
    return {
      ...retired,
      gatewayRestarted: Boolean(restart.attempted && restart.ok),
      gatewayRestartError: restart.ok ? null : restart.error || restart.stderr || null,
    }
  } catch (error) {
    return {
      sandboxName,
      changed: false,
      gatewayRestarted: false,
      error: error instanceof Error ? error.message : "Failed to repair legacy OpenClaw auth profile",
    }
  }
}
