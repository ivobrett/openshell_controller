import { spawn } from "node:child_process"
import { OPENSHELL_BIN, hostCommandEnv } from "./hostCommands"

function shellQuote(value: string) {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

function runSandboxShell(sandboxName: string, script: string, input?: Buffer | string, timeoutMs = 60000) {
  return new Promise<{ stdout: string; stderr: string; code: number | null }>((resolve, reject) => {
    const child = spawn(OPENSHELL_BIN, ["sandbox", "exec", "-n", sandboxName, "--", "sh", "-lc", script], {
      env: hostCommandEnv({
        OPENSHELL_GATEWAY: process.env.OPENSHELL_GATEWAY?.trim() || undefined,
      }),
      stdio: ["pipe", "pipe", "pipe"],
    })
    let stdout = ""
    let stderr = ""
    const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs)
    child.stdout.on("data", (chunk) => { stdout += String(chunk) })
    child.stderr.on("data", (chunk) => { stderr += String(chunk) })
    child.on("error", (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.on("close", (code) => {
      clearTimeout(timer)
      resolve({ stdout: stdout.trim(), stderr: stderr.trim(), code })
    })
    if (input) child.stdin.end(input)
    else child.stdin.end()
  })
}

export async function writeSandboxFilePrivileged(
  sandboxName: string,
  targetPath: string,
  payload: Buffer,
  mode = "0644",
) {
  const script = [
    `mkdir -p ${shellQuote(targetPath.split("/").slice(0, -1).join("/") || "/")}`,
    `cat > ${shellQuote(targetPath)}`,
    `chmod ${shellQuote(mode)} ${shellQuote(targetPath)}`,
    `chown root:root ${shellQuote(targetPath)} 2>/dev/null || true`,
  ].join(" && ")
  const result = await runSandboxShell(sandboxName, script, payload)
  if (result.code !== 0) throw new Error(result.stderr || `failed to write ${targetPath}`)
  return {
    sandboxName,
    path: targetPath,
    bytes: payload.byteLength,
  }
}

// TEMPORARY SHIM for NemoClaw #12254 — RETIRE when the pinned NemoClaw tag
// contains PR #12237 (merge e39044f5, 2026-09-24; v0.0.129 was cut ~4h before
// it and does NOT include it).
//
// scripts/nemoclaw-start.sh write_auth_profile() writes
// ~/.openclaw/agents/main/agent/auth-profiles.json with a `<provider>:manual`
// env-keyRef profile. OpenClaw 2026.9.1 treats that file as legacy credential
// state and fails every agent turn with AuthProfileMigrationRequiredError; the
// prescribed `openclaw doctor --fix` cannot run while the gateway owns the
// lifecycle lock. OpenShell authenticates inference.local on the host, so the
// profile is not needed. This mirrors #12237 exactly: only for a managed
// inference.local route, remove only the exact generated entry, keep any other
// profiles, and delete the file only when nothing else is left. The gateway
// caches the migration refusal, so callers must restart it when changed=true.
// Verified live 2026-09-23: removal + `nemoclaw <sb> gateway restart` -> chat OK.
const RETIRE_LEGACY_AUTH_PROFILE_PY = `
import json, os, re, sys
home = "/sandbox/.openclaw"
path = home + "/agents/main/agent/auth-profiles.json"
def done(changed, reason):
    print(json.dumps({"changed": changed, "reason": reason})); sys.exit(0)
if os.path.islink(path) or not os.path.isfile(path): done(False, "no legacy auth-profiles.json")
provider = os.environ.get("NEMOCLAW_INFERENCE_PROVIDER_ID") or os.environ.get("NEMOCLAW_PROVIDER_KEY") or "inference"
base = os.environ.get("NEMOCLAW_INFERENCE_BASE_URL", "")
if not base:
    try:
        cfg = json.load(open(home + "/openclaw.json"))
        base = str(((cfg.get("models") or {}).get("providers") or {}).get(provider, {}).get("baseUrl", ""))
    except Exception:
        base = ""
if not re.match(r"^https://inference\\.local(:443)?(/.*)?$", base, re.I):
    done(False, "inference route is not managed inference.local (or unknown); left untouched")
try:
    profiles = json.load(open(path))
except Exception:
    done(False, "unreadable auth-profiles.json; left untouched")
if not isinstance(profiles, dict): done(False, "unexpected auth-profiles.json shape; left untouched")
pid = provider + ":manual"
legacy = {"type": "api_key", "provider": provider, "keyRef": {"source": "env", "id": "NVIDIA_INFERENCE_API_KEY"}, "profileId": pid}
if profiles.get(pid) != legacy: done(False, "no generated legacy profile present")
retained = {k: v for k, v in profiles.items() if k != pid}
if not retained:
    os.unlink(path); done(True, "removed generated legacy auth-profiles.json")
st = os.stat(path)
tmp = path + ".nemoclaw-shim"
with open(tmp, "w") as fh: json.dump(retained, fh)
os.chmod(tmp, 0o600)
try: os.chown(tmp, st.st_uid, st.st_gid)
except OSError: pass
os.replace(tmp, path)
done(True, "removed generated legacy profile; kept other profiles")
`

export async function retireLegacyOpenClawAuthProfile(sandboxName: string) {
  const result = await runSandboxShell(sandboxName, `python3 -c ${shellQuote(RETIRE_LEGACY_AUTH_PROFILE_PY)}`)
  const line = result.stdout.split(/\r?\n/).reverse().find((entry) => entry.trim().startsWith("{"))
  if (result.code !== 0 || !line) {
    throw new Error(result.stderr || "failed to inspect OpenClaw auth-profiles.json")
  }
  const parsed = JSON.parse(line) as { changed: boolean; reason: string }
  return { sandboxName, changed: Boolean(parsed.changed), reason: parsed.reason }
}
