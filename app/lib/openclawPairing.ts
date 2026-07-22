import { spawn } from "node:child_process"
import { OPENSHELL_BIN, hostCommandEnv } from "./hostCommands"

// Controller-driven OpenClaw device+node pairing for the mobile apps.
//
// TRANSPORT (rewritten 2026-07-12 after a live investigation on a manidae
// cloud AgentGateway sandbox):
//
// The in-sandbox OpenClaw gateway does NOT listen where the old code assumed.
// It binds the OpenShell sandbox↔gateway veth (e.g. 10.200.0.2:18789) inside a
// nested network namespace — NOT the container's eth0, and NOT the container's
// main-namespace loopback. On a cloud box eth0 is a Docker bridge (172.19.x)
// that owns the default route, so the old "connect to the default-route source
// IP" heuristic dialed the wrong network and every call died with a 1006
// abnormal closure ("check pending" showed nothing).
//
// Two things are therefore required to reach the gateway with operator
// authority, and both mirror what scripts/hermes-remote/launch.sh already does:
//
//   1. nsenter into the gateway's network namespace and connect via loopback
//      (127.0.0.1:18789). Discover the gateway PID with `pgrep -f
//      openclaw-gateway` (see findGatewayPid — the argv0 changed in 2026.7.1).
//   2. Authenticate with the gateway's STORED DEVICE CREDENTIAL, not the shared
//      gateway.auth.token. A plain-token connection is rejected with "device
//      pairing required"; a hand-written devices/paired.json is IGNORED (the
//      gateway requires a real pending->paired approve transition). Stripping
//      OPENCLAW_GATEWAY_URL/PORT/TOKEN from the child env forces OpenClaw onto
//      its local stored-device-credential path (same env-strip the NemoClaw
//      auto-pair pass uses). /tmp/nemoclaw-proxy-env.sh is sourced first for
//      the proxy/CA/HOME context the gateway netns needs.
//
// Bootstrap: the controller's own operator CLI device (identity/device.json's
// deviceId) is auto-filed as a pending operator.pairing device request. It must
// be self-approved (via the stored-cred path above) before the CLI can list or
// approve node requests — see ensureOperatorApproved.
//
// File reads/writes under /sandbox still go through `openshell sandbox exec`
// (the privileged channel); only gateway WS calls need the netns + docker.

const OPENCLAW_STATE_DIR = "/sandbox/.openclaw"
const GATEWAY_PORT = 18789

const REQUEST_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/

export type OpenClawPairingRequest = {
  requestId: string
  role?: string
  label?: string
  scopes?: string[]
  createdAt?: string
}

type ExecResult = { stdout: string; stderr: string; code: number | null }

function runSandboxExec(sandboxName: string, command: string[]): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(OPENSHELL_BIN, ["sandbox", "exec", "-n", sandboxName, "--", ...command], {
      env: hostCommandEnv({ OPENSHELL_GATEWAY: process.env.OPENSHELL_GATEWAY || "nemoclaw" }),
      stdio: ["ignore", "pipe", "pipe"],
    })
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (chunk) => { stdout += String(chunk) })
    child.stderr.on("data", (chunk) => { stderr += String(chunk) })
    child.on("error", reject)
    child.on("close", (code) => resolve({ stdout: stdout.trim(), stderr: stderr.trim(), code }))
  })
}

// Direct docker invocation for the gateway-netns transport. The controller runs
// as root on the VPS (same privilege the hermes-remote scripts use for
// docker/nsenter). Not used off the host.
function runDocker(args: string[]): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("docker", args, {
      env: hostCommandEnv(),
      stdio: ["ignore", "pipe", "pipe"],
    })
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (chunk) => { stdout += String(chunk) })
    child.stderr.on("data", (chunk) => { stderr += String(chunk) })
    child.on("error", reject)
    child.on("close", (code) => resolve({ stdout: stdout.trim(), stderr: stderr.trim(), code }))
  })
}

// `openshell sandbox exec` rejects argv entries containing newlines, so multi-line
// python must be base64-encoded into a single flat arg.
function pyExec(script: string): string[] {
  const b64 = Buffer.from(script, "utf8").toString("base64")
  return ["python3", "-c", `import base64;exec(base64.b64decode('${b64}').decode())`]
}

// Single-quote for embedding an argv value inside the `su -c '<command>'` string.
function shq(value: string): string {
  return "'" + value.replace(/'/g, "'\\''") + "'"
}

// Strip the noisy plugin banner + node warnings openclaw prints on every run.
function cleanOpenClawOutput(raw: string): string {
  return raw
    .split(/\r?\n/)
    .filter((line) => !/UNDICI|trace-warnings|\[plugins\]|NemoClaw registered|Endpoint:|Provider:|Model:|Slash:|[└┌│◇]/.test(line))
    .join("\n")
    .trim()
}

async function resolveContainer(sandboxName: string): Promise<string> {
  const res = await runDocker(["ps", "--format", "{{.Names}}"])
  const name = res.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.startsWith(`openshell-${sandboxName}-`))
  if (!name) throw new Error(`no running container for sandbox '${sandboxName}'`)
  return name
}

// Find the long-lived OpenClaw gateway process so we can nsenter its netns.
//
// OpenClaw 2026.7.1 renamed the gateway's argv0 from `openclaw` to
// `openclaw-gateway`. The bare `openclaw` process is now a TRANSIENT CLI child
// that comes and goes, so the old `pgrep -x openclaw` matched nothing whenever
// it wasn't running — findGatewayPid threw, every pairing WS call died, and
// "check pending" silently showed nothing. `pgrep -x` also can't match
// `openclaw-gateway` (comm is truncated to 15 chars), so we match the full
// command line with `-f`. All openclaw-family processes (gateway, the
// `openclaw-devices` watcher, transient CLIs) share the gateway netns, and the
// lowest PID is the long-lived gateway — so match `openclaw-gateway` first
// (2026.7.1+), then fall back to any `openclaw` process for older builds.
async function findGatewayPid(container: string): Promise<string> {
  for (const pattern of ["openclaw-gateway", "openclaw"]) {
    const res = await runDocker(["exec", container, "pgrep", "-f", pattern])
    const pids = res.stdout
      .split(/\r?\n/)
      .map((line) => Number(line.trim()))
      .filter((n) => Number.isInteger(n) && n > 0)
      .sort((a, b) => a - b)
    if (pids.length > 0) return String(pids[0])
  }
  throw new Error(`no openclaw gateway process in ${container}`)
}

// Read the shared gateway token (for the offline QR encoder) + the gateway port.
// No IP: gateway WS calls go via the netns loopback (runOpenClawGateway).
async function getGatewayToken(sandboxName: string): Promise<{ token: string; port: number }> {
  const script =
    "import json;" +
    "cfg=json.load(open('/sandbox/.openclaw/openclaw.json'));" +
    "print(json.dumps({'token':cfg['gateway']['auth']['token'],'port':cfg['gateway'].get('port',18789)}))"
  const res = await runSandboxExec(sandboxName, pyExec(script))
  const clean = cleanOpenClawOutput(res.stdout)
  const match = clean.match(/\{[\s\S]*\}/)
  if (!match) throw new Error(`could not read gateway token: ${res.stderr || clean || "empty"}`)
  const parsed = JSON.parse(match[0]) as { token: string; port: number }
  if (!parsed.token) throw new Error("gateway token missing")
  return parsed
}

// Run the openclaw CLI against the gateway from INSIDE its network namespace
// (loopback), on the stored-device-credential path (gateway env stripped). This
// is the only transport that reaches the gateway with operator authority — see
// the module header. Returns cleaned stdout.
async function runOpenClawGateway(sandboxName: string, args: string[]): Promise<ExecResult> {
  const container = await resolveContainer(sandboxName)
  const pid = await findGatewayPid(container)
  const inner =
    ". /tmp/nemoclaw-proxy-env.sh 2>/dev/null; " +
    "env -u OPENCLAW_GATEWAY_URL -u OPENCLAW_GATEWAY_PORT -u OPENCLAW_GATEWAY_TOKEN " +
    "HOME=/sandbox OPENCLAW_HOME=/sandbox " +
    `OPENCLAW_STATE_DIR=${OPENCLAW_STATE_DIR} OPENCLAW_CONFIG_PATH=${OPENCLAW_STATE_DIR}/openclaw.json ` +
    "XDG_STATE_HOME=/tmp/.local/state XDG_CONFIG_HOME=/tmp/.config XDG_CACHE_HOME=/tmp/.cache XDG_DATA_HOME=/tmp/.local/share " +
    ["openclaw", ...args].map(shq).join(" ")
  const res = await runDocker([
    "exec", "--privileged", container,
    "nsenter", "-t", pid, "-n", "--",
    "su", "-s", "/bin/bash", "sandbox", "-c", inner,
  ])
  return { ...res, stdout: cleanOpenClawOutput(res.stdout) }
}

function parseNodeRequests(raw: string): OpenClawPairingRequest[] {
  const match = raw.match(/\[[\s\S]*\]/)
  if (!match) return []
  let rows: unknown
  try { rows = JSON.parse(match[0]) } catch { return [] }
  if (!Array.isArray(rows)) return []
  const out: OpenClawPairingRequest[] = []
  for (const row of rows) {
    if (!row || typeof row !== "object") continue
    const r = row as Record<string, unknown>
    const requestId = typeof r.requestId === "string" ? r.requestId : ""
    if (!requestId) continue
    out.push({
      requestId,
      role: typeof r.role === "string" ? r.role : undefined,
      label: typeof r.label === "string" ? r.label : typeof r.displayName === "string" ? r.displayName : undefined,
      scopes: Array.isArray(r.scopes) ? r.scopes.filter((s): s is string => typeof s === "string") : undefined,
      createdAt: typeof r.createdAt === "string" ? r.createdAt : undefined,
    })
  }
  return out
}

// The controller's own operator CLI device (identity/device.json's deviceId) is
// auto-filed as a pending operator.pairing request by the in-sandbox watcher.
// Self-approve it via the stored-credential path so the CLI gains operator
// authority for the node list/approve calls below. Idempotent and best-effort:
// a no-op once the device is already paired (nothing pending for our deviceId).
async function ensureOperatorApproved(sandboxName: string): Promise<void> {
  const script = [
    "import json,os",
    "base='/sandbox/.openclaw'",
    "did=json.load(open(base+'/identity/device.json'))['deviceId']",
    "pp=base+'/devices/pending.json'",
    "d=json.load(open(pp)) if os.path.exists(pp) else {}",
    "rid=''",
    "for k,v in (d.items() if isinstance(d,dict) else []):",
    "  if isinstance(v,dict) and v.get('deviceId')==did:",
    "    rid=v.get('requestId') or k; break",
    "print(rid)",
  ].join("\n")
  const res = await runSandboxExec(sandboxName, pyExec(script))
  const requestId = cleanOpenClawOutput(res.stdout).trim()
  if (!requestId || !REQUEST_ID_RE.test(requestId)) return
  await runOpenClawGateway(sandboxName, ["devices", "approve", requestId, "--json"]).catch(() => undefined)
}

// Make node pairing fully automatic for this sandbox: set
// gateway.nodes.pairing.autoApproveCidrs=["0.0.0.0/0"]. NOTE (2026-07-12): this
// is NOT sufficient on its own — a real mobile still files a node-capability
// request that requires an explicit operator approve (approveOpenClawPairing).
// The config edit is a cheap best-effort and is left in place; gateway.nodes is
// not hot-reloadable, but the value is picked up on the gateway's next start.
export async function ensureAutoApproveNodes(sandboxName: string): Promise<{ changed: boolean }> {
  const patch = [
    "import json,os",
    "p='/sandbox/.openclaw/openclaw.json'",
    "d=json.load(open(p))",
    "pr=d.setdefault('gateway',{}).setdefault('nodes',{}).setdefault('pairing',{})",
    "changed=(pr.get('autoApproveCidrs') or [])!=['0.0.0.0/0']",
    "pr['autoApproveCidrs']=['0.0.0.0/0']",
    "tmp=p+'.tmp'; json.dump(d,open(tmp,'w'),indent=2); os.replace(tmp,p)",
    "print(json.dumps({'changed':changed}))",
  ].join("\n")
  const res = await runSandboxExec(sandboxName, pyExec(patch))
  const m = cleanOpenClawOutput(res.stdout).match(/\{[\s\S]*\}/)
  const parsed = m ? (JSON.parse(m[0]) as { changed: boolean }) : { changed: false }
  return { changed: Boolean(parsed.changed) }
}

// Open the Control-UI browser-Origin allowlist for controller-managed sandboxes:
// set gateway.controlUi.allowedOrigins=["*"]. External clients (the Obsidian
// plugin sends Origin: app://obsidian.md, third-party desktop apps, a browser
// Control UI opened at the public host, etc.) are otherwise rejected by the
// gateway's checkBrowserOrigin with ws close 4008 "origin not allowed" — the
// handshake reaches 101 + connect.challenge and then closes, so it looks like a
// token/transport failure. Enumerating every client origin is unworkable; the
// gateway honours "*" (checkBrowserOrigin does `allowlist.has("*")`). This is
// safe for our exposure model: the gateway STILL requires its auth token on
// every connection (the Origin check is CSRF-style defence-in-depth against a
// browser replaying AMBIENT credentials, which the token is not), and public
// exposures sit behind Pangolin auth + an IP allowlist. Non-hot-reloadable, like
// gateway.nodes: the value is picked up on the gateway's next start (the create
// flow's final gateway start, or the next recover). Best-effort; mirrors
// ensureAutoApproveNodes so both permissive defaults land in the same window.
export async function ensureControlUiAllowedOriginsOpen(sandboxName: string): Promise<{ changed: boolean }> {
  const patch = [
    "import json,os",
    "p='/sandbox/.openclaw/openclaw.json'",
    "d=json.load(open(p))",
    "cu=d.setdefault('gateway',{}).setdefault('controlUi',{})",
    "changed=(cu.get('allowedOrigins') or [])!=['*']",
    "cu['allowedOrigins']=['*']",
    "tmp=p+'.tmp'; json.dump(d,open(tmp,'w'),indent=2); os.replace(tmp,p)",
    "print(json.dumps({'changed':changed}))",
  ].join("\n")
  const res = await runSandboxExec(sandboxName, pyExec(patch))
  const m = cleanOpenClawOutput(res.stdout).match(/\{[\s\S]*\}/)
  const parsed = m ? (JSON.parse(m[0]) as { changed: boolean }) : { changed: false }
  return { changed: Boolean(parsed.changed) }
}

// Generate a mobile-pairing QR setup code. `openclaw qr` is an OFFLINE encoder
// (public URL + a short-lived bootstrapToken) — no gateway connection — so it
// runs on the plain sandbox-exec channel with a clean env.
export async function generateOpenClawQr(sandboxName: string, publicUrl: string): Promise<{ setupCode: string }> {
  const { token } = await getGatewayToken(sandboxName)
  const cmd = [
    "env", "HOME=/sandbox", "OPENCLAW_HOME=/sandbox",
    `OPENCLAW_STATE_DIR=${OPENCLAW_STATE_DIR}`,
    `OPENCLAW_CONFIG_PATH=${OPENCLAW_STATE_DIR}/openclaw.json`,
    "XDG_STATE_HOME=/tmp/.local/state", "XDG_CONFIG_HOME=/tmp/.config",
    "XDG_CACHE_HOME=/tmp/.cache", "XDG_DATA_HOME=/tmp/.local/share",
    "openclaw", "qr", "--public-url", publicUrl, "--token", token, "--json",
  ]
  const res = await runSandboxExec(sandboxName, cmd)
  const out = cleanOpenClawOutput(res.stdout)
  // openclaw qr --json can emit a trailing comma (invalid JSON), so pull the
  // setupCode field directly rather than JSON.parse the whole blob.
  const scMatch = out.match(/"setupCode"\s*:\s*"([^"]+)"/)
  const setupCode = scMatch ? scMatch[1] : ""
  if (!setupCode) throw new Error(res.stderr || out || "openclaw qr returned no setupCode")
  return { setupCode }
}

// List pending NODE-capability requests (what the mobile files after its device
// pairs via the QR bootstrap token).
export async function listOpenClawPairingRequests(sandboxName: string): Promise<{ requests: OpenClawPairingRequest[]; raw: string }> {
  await ensureOperatorApproved(sandboxName)
  const res = await runOpenClawGateway(sandboxName, ["nodes", "pending", "--json"])
  return { requests: parseNodeRequests(res.stdout), raw: res.stdout }
}

// Approve a pending NODE request (or the latest). Ensures our operator device is
// approved first so the approve carries operator authority.
export async function approveOpenClawPairing(sandboxName: string, requestId?: string): Promise<{ output: string }> {
  await ensureOperatorApproved(sandboxName)

  let targetId = requestId
  if (targetId) {
    if (!REQUEST_ID_RE.test(targetId)) throw new Error("invalid pairing requestId")
  } else {
    const res = await runOpenClawGateway(sandboxName, ["nodes", "pending", "--json"])
    const pending = parseNodeRequests(res.stdout)
    if (pending.length === 0) throw new Error("no pending node requests — open the app so it re-files, then retry")
    targetId = pending[pending.length - 1].requestId
  }

  const res = await runOpenClawGateway(sandboxName, ["nodes", "approve", targetId, "--json"])
  if (res.code !== 0 || /unknown requestId|pairing required|missing scope|"error"|not approved/i.test(res.stdout)) {
    throw new Error(res.stdout || res.stderr || "failed to approve node request")
  }
  return { output: res.stdout || "approved" }
}
