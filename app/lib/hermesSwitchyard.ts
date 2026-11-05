import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"

import { HERMES_SWITCHYARD_PROVIDERS, type HermesSwitchyardProviderId } from "./hermesSwitchyardProviders"

/**
 * Hermes adaptive routing (Switchyard) for `nemoclaw onboard --switchyard-config <file>`.
 *
 * NemoClaw (v0.0.141+, PR #13982) accepts only a small, secret-free JSON file naming
 * an "efficient" and a "capable" provider/model. It derives the Relay and Switchyard
 * configuration itself and rejects endpoints, credentials, or unknown fields, so this
 * module only builds that file. NemoClaw does the authoritative validation.
 */

export type HermesSwitchyardTarget = {
  provider: HermesSwitchyardProviderId
  model: string
}

export type HermesSwitchyardConfig = {
  schemaVersion: 1
  efficient: HermesSwitchyardTarget
  capable: HermesSwitchyardTarget
}

const PROVIDER_IDS = new Set<string>(HERMES_SWITCHYARD_PROVIDERS.map((provider) => provider.id))
// Mirrors NemoClaw's MODEL_PATTERN; NemoClaw applies further checks.
const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:+/-]*$/
const MAX_MODEL_BYTES = 512

export class HermesSwitchyardConfigError extends Error {
  constructor(message: string) {
    super(`Invalid Switchyard routing: ${message}`)
    this.name = "HermesSwitchyardConfigError"
  }
}

function parseTarget(value: unknown, role: "efficient" | "capable"): HermesSwitchyardTarget {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HermesSwitchyardConfigError(`${role} must be an object with provider and model`)
  }
  const raw = value as Record<string, unknown>
  const provider = typeof raw.provider === "string" ? raw.provider.trim() : ""
  const model = typeof raw.model === "string" ? raw.model.trim() : ""
  if (!PROVIDER_IDS.has(provider)) {
    throw new HermesSwitchyardConfigError(
      `${role}.provider must be one of ${[...PROVIDER_IDS].join(", ")}`,
    )
  }
  if (
    !model ||
    Buffer.byteLength(model, "utf8") > MAX_MODEL_BYTES ||
    !MODEL_PATTERN.test(model) ||
    model.includes("://") ||
    model.includes("..")
  ) {
    throw new HermesSwitchyardConfigError(`${role}.model must be a provider model ID (no URLs or credentials)`)
  }
  return { provider: provider as HermesSwitchyardProviderId, model }
}

/**
 * Read the optional `switchyard` request field.
 * Returns null when routing is absent or disabled, so ordinary onboarding is unchanged.
 */
export function parseHermesSwitchyardRequest(value: unknown): HermesSwitchyardConfig | null {
  if (value === undefined || value === null) return null
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new HermesSwitchyardConfigError("switchyard must be an object")
  }
  const raw = value as Record<string, unknown>
  if (raw.enabled === false) return null
  const efficient = parseTarget(raw.efficient, "efficient")
  const capable = parseTarget(raw.capable, "capable")
  if (efficient.model === capable.model) {
    throw new HermesSwitchyardConfigError("efficient and capable must use different model IDs")
  }
  return { schemaVersion: 1, efficient, capable }
}

/** Serialize exactly the fields NemoClaw accepts; anything else is rejected upstream. */
export function serializeHermesSwitchyardConfig(config: HermesSwitchyardConfig) {
  return `${JSON.stringify(
    {
      schemaVersion: 1,
      efficient: { provider: config.efficient.provider, model: config.efficient.model },
      capable: { provider: config.capable.provider, model: config.capable.model },
    },
    null,
    2,
  )}\n`
}

/**
 * Write the config to a private temp file for the onboard run.
 * NemoClaw requires a regular, single-link, non-symlink file of at most 16 KiB.
 * It records the routing in its onboard state, so the file can be removed after the run.
 */
export function writeHermesSwitchyardConfigFile(config: HermesSwitchyardConfig) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "openshell-switchyard-"))
  const filePath = path.join(dir, "switchyard.json")
  writeFileSync(filePath, serializeHermesSwitchyardConfig(config), { mode: 0o600, flag: "wx" })
  return {
    filePath,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  }
}

export function hermesSwitchyardOnboardArgs(filePath: string | null) {
  return filePath ? ["--switchyard-config", filePath] : []
}
