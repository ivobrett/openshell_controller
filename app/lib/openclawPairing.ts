import { spawn } from "node:child_process"
import { OPENSHELL_BIN, hostCommandEnv } from "./hostCommands"

// Controller-driven OpenClaw device+node pairing for the mobile apps.
//
// PROVEN FLOW (2026-07-05, AgentGateway sandbox, OpenClaw 2026.6.10):
//   1. Operator scans a QR (openclaw qr --public-url wss://… --token <gwtok>) whose
//      short-lived bootstrapToken AUTO-approves DEVICE pairing (no manual step).
//   2. The app then files a NODE-capability request that must be approved by an
//      operator-scoped client (`openclaw nodes approve <id>`).
//
// The roadblocks we hit — and how this module avoids each:
//   A. `sh -lc` login shell inside the sandbox installs a wrapper (nemoclaw-start)
//      that UNSETS OPENCLAW_GATEWAY_* → the CLI silently reverts to a loopback URL
//      the gateway doesn't listen on (1006). FIX: run the CLI as DIRECT argv with an
//      explicit `env …` prefix (never `sh -lc`).
//   B. The gateway binds its eth0 IP (10.200.0.2), NOT loopback, so the "local
//      loopback" operator-trust path is unavailable; a plain CLI connection is
//      treated as an unpaired device ("device pairing required"). FIX: the CLI runs
//      with OPENCLAW_GATEWAY_TOKEN (= gateway.auth.token) for transport auth AND its
//      device identity (/sandbox/.openclaw/identity/device.json → a DETERMINISTIC
//      per-sandbox deviceId) is pre-seeded into devices/paired.json with full
//      operator scopes. The gateway reads paired.json per-connect, so this grants the
//      CLI operator scope with no manual approval and no self-approval catch-22.
//   C. `nodes approve` needs operator.write; a CLI that only has operator.read files
//      a scope-upgrade request that then WEDGES it. Pre-seeding full scopes up front
//      avoids the upgrade entirely.
//
// All sandbox access is via `openshell sandbox exec` (the same privileged channel
// used for MCP config writes).

const OPENCLAW_STATE_DIR = "/sandbox/.openclaw"
const GATEWAY_PORT = 18789
const OPERATOR_SCOPES = ["operator.pairing", "operator.read", "operator.write", "operator.approvals"]

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

// `openshell sandbox exec` rejects argv entries containing newlines, so multi-line
// python must be base64-encoded into a single flat arg.
function pyExec(script: string): string[] {
  const b64 = Buffer.from(script, "utf8").toString("base64")
  return ["python3", "-c", `import base64;exec(base64.b64decode('${b64}').decode())`]
}

// Strip the noisy plugin banner + node warnings openclaw prints on every run.
function cleanOpenClawOutput(raw: string): string {
  return raw
    .split(/\r?\n/)
    .filter((line) => !/UNDICI|trace-warnings|\[plugins\]|NemoClaw registered|Endpoint:|Provider:|Model:|Slash:|[└┌│◇]/.test(line))
    .join("\n")
    .trim()
}

// One round-trip: read the gateway token, the deterministic device identity, and
// the sandbox eth0 IP (the gateway bind address). These are the env the openclaw
// CLI needs to reach the gateway with operator authority. `sh -c` (non-login) is
// fine here — none of these read commands need OPENCLAW_GATEWAY_* so the wrapper
// is irrelevant; the openclaw CLI itself is always run via runOpenClaw (env+argv).
async function getGatewayContext(sandboxName: string): Promise<{ ip: string; token: string; deviceId: string }> {
  const script =
    "import json,socket;" +
    "cfg=json.load(open('/sandbox/.openclaw/openclaw.json'));" +
    "did=json.load(open('/sandbox/.openclaw/identity/device.json'))['deviceId'];" +
    "s=socket.socket(socket.AF_INET,socket.SOCK_DGRAM);\n" +
    "try:\n s.connect(('10.255.255.255',1));ip=s.getsockname()[0]\nexcept Exception:\n ip='127.0.0.1'\nfinally:\n s.close()\n" +
    "print(json.dumps({'ip':ip,'token':cfg['gateway']['auth']['token'],'deviceId':did}))"
  const res = await runSandboxExec(sandboxName, pyExec(script))
  const clean = cleanOpenClawOutput(res.stdout)
  const match = clean.match(/\{[\s\S]*\}/)
  if (!match) throw new Error(`could not read gateway context: ${res.stderr || clean || "empty"}`)
  const parsed = JSON.parse(match[0]) as { ip: string; token: string; deviceId: string }
  if (!parsed.token || !parsed.deviceId) throw new Error("gateway token or device identity missing")
  return parsed
}

// Pre-seed the controller's operator CLI device (the gateway's own deterministic
// identity) into devices/paired.json with full operator scopes. Idempotent; the
// gateway honours the change per-connect (no restart). This is what lets `nodes
// approve` run without any manual/web-UI approval of the CLI device itself.
async function ensureOperatorDevice(sandboxName: string): Promise<void> {
  const script = [
    "import json,os",
    "base='/sandbox/.openclaw'",
    "did=json.load(open(base+'/identity/device.json'))['deviceId']",
    "pp=base+'/devices/paired.json'",
    "d=json.load(open(pp)) if os.path.exists(pp) else {}",
    "d=d if isinstance(d,dict) else {}",
    `scopes=${JSON.stringify(OPERATOR_SCOPES)}`,
    "e=d.get(did) or {'deviceId':did,'clientId':'cli','clientMode':'cli','platform':'linux'}",
    "e['deviceId']=did",
    "e['roles']=sorted(set((e.get('roles') or [])+['operator']))",
    "e['scopes']=scopes; e['approvedScopes']=scopes",
    "t=e.get('tokens') or {}",
    "op=t.get('operator')",
    "if isinstance(op,dict): op['scopes']=scopes; t['operator']=op; e['tokens']=t",
    "d[did]=e",
    "os.makedirs(os.path.dirname(pp),exist_ok=True)",
    "tmp=pp+'.tmp'; json.dump(d,open(tmp,'w'),indent=2); os.replace(tmp,pp)",
    "print('seeded '+did)",
  ].join("\n")
  const res = await runSandboxExec(sandboxName, pyExec(script))
  if (res.code !== 0 && !/seeded/.test(res.stdout)) {
    throw new Error(`failed to seed operator device: ${res.stderr || res.stdout || "unknown"}`)
  }
}

// Run the openclaw CLI inside the sandbox with the gateway env, as DIRECT argv via
// `env …` (roadblock A). Returns cleaned stdout.
async function runOpenClaw(sandboxName: string, ctx: { ip: string; token: string }, args: string[]): Promise<ExecResult> {
  const envPrefix = [
    "env",
    "HOME=/sandbox",
    "OPENCLAW_HOME=/sandbox",
    `OPENCLAW_STATE_DIR=${OPENCLAW_STATE_DIR}`,
    `OPENCLAW_CONFIG_PATH=${OPENCLAW_STATE_DIR}/openclaw.json`,
    `OPENCLAW_GATEWAY_URL=ws://${ctx.ip}:${GATEWAY_PORT}`,
    `OPENCLAW_GATEWAY_TOKEN=${ctx.token}`,
    "XDG_STATE_HOME=/tmp/.local/state",
    "XDG_CONFIG_HOME=/tmp/.config",
    "XDG_CACHE_HOME=/tmp/.cache",
    "XDG_DATA_HOME=/tmp/.local/share",
    "openclaw",
    ...args,
  ]
  const res = await runSandboxExec(sandboxName, envPrefix)
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

// Make node pairing fully automatic for this sandbox: set
// gateway.nodes.pairing.autoApproveCidrs=["0.0.0.0/0"] so a first-time node-role
// device pairing auto-approves (the app connects → auto-approved, no operator
// Approve click, no operator-device DB bootstrap). Safe here because the gateway
// token already gates all access (single-tenant, token-gated ingress).
//
// gateway.nodes is NOT hot-reloadable, so if we changed the config we restart the
// gateway with the same relaunch nemoclaw-start uses (best-effort; a failed
// restart doesn't fail the expose — the operator can still Approve manually).
export async function ensureAutoApproveNodes(sandboxName: string): Promise<{ changed: boolean }> {
  let ctx: { ip: string; token: string; deviceId: string }
  try {
    ctx = await getGatewayContext(sandboxName)
  } catch {
    return { changed: false }
  }
  const patch = [
    "import json,os",
    "p='/sandbox/.openclaw/openclaw.json'",
    "d=json.load(open(p))",
    "pr=d.setdefault('gateway',{}).setdefault('nodes',{}).setdefault('pairing',{})",
    "changed=(pr.get('autoApproveCidrs') or [])!=['0.0.0.0/0']",
    "pr['autoApproveCidrs']=['0.0.0.0/0']",
    "port=(d.get('gateway') or {}).get('port',18789)",
    "tmp=p+'.tmp'; json.dump(d,open(tmp,'w'),indent=2); os.replace(tmp,p)",
    "print(json.dumps({'changed':changed,'port':port}))",
  ].join("\n")
  const res = await runSandboxExec(sandboxName, pyExec(patch))
  const m = cleanOpenClawOutput(res.stdout).match(/\{[\s\S]*\}/)
  const parsed = m ? (JSON.parse(m[0]) as { changed: boolean; port: number }) : { changed: false, port: GATEWAY_PORT }
  if (!parsed.changed) return { changed: false }

  const port = parsed.port || GATEWAY_PORT
  const restart = [
    "env",
    "HOME=/sandbox",
    "OPENCLAW_HOME=/sandbox",
    `OPENCLAW_STATE_DIR=${OPENCLAW_STATE_DIR}`,
    `OPENCLAW_CONFIG_PATH=${OPENCLAW_STATE_DIR}/openclaw.json`,
    `OPENCLAW_GATEWAY_URL=ws://${ctx.ip}:${port}`,
    `OPENCLAW_GATEWAY_PORT=${port}`,
    `OPENCLAW_GATEWAY_TOKEN=${ctx.token}`,
    "OPENCLAW_ALLOW_INSECURE_PRIVATE_WS=1",
    "XDG_STATE_HOME=/tmp/.local/state",
    "XDG_CONFIG_HOME=/tmp/.config",
    "XDG_CACHE_HOME=/tmp/.cache",
    "XDG_DATA_HOME=/tmp/.local/share",
    "sh",
    "-c",
    `pkill -f 'openclaw.*gateway run' 2>/dev/null; sleep 3; setsid nohup openclaw gateway run --port ${port} >>/tmp/gateway.log 2>&1 </dev/null & sleep 6`,
  ]
  await runSandboxExec(sandboxName, restart)
  return { changed: true }
}

// Generate a mobile-pairing QR setup code. Returns the base64 setupCode (opaque,
// short-lived bootstrapToken inside — safe to render) AND the raw ascii QR block
// the CLI draws, so the panel can show either.
export async function generateOpenClawQr(sandboxName: string, publicUrl: string): Promise<{ setupCode: string }> {
  const ctx = await getGatewayContext(sandboxName)
  const json = await runOpenClaw(sandboxName, ctx, ["qr", "--public-url", publicUrl, "--token", ctx.token, "--json"])
  const m = json.stdout.match(/\{[\s\S]*\}/)
  if (!m) throw new Error(json.stderr || json.stdout || "openclaw qr produced no setup code")
  const setupCode = String((JSON.parse(m[0]) as { setupCode?: string }).setupCode || "")
  if (!setupCode) throw new Error("openclaw qr returned no setupCode")
  return { setupCode }
}

// List pending NODE-capability requests (what the app files after device pairing).
export async function listOpenClawPairingRequests(sandboxName: string): Promise<{ requests: OpenClawPairingRequest[]; raw: string }> {
  const ctx = await getGatewayContext(sandboxName)
  await ensureOperatorDevice(sandboxName)
  const res = await runOpenClaw(sandboxName, ctx, ["nodes", "pending", "--json"])
  return { requests: parseNodeRequests(res.stdout), raw: res.stdout }
}

// Approve a pending NODE request (or the latest). Ensures the operator device is
// seeded first so the approve never hits the pairing/scope-upgrade wall.
export async function approveOpenClawPairing(sandboxName: string, requestId?: string): Promise<{ output: string }> {
  const ctx = await getGatewayContext(sandboxName)
  await ensureOperatorDevice(sandboxName)

  let targetId = requestId
  if (targetId) {
    if (!REQUEST_ID_RE.test(targetId)) throw new Error("invalid pairing requestId")
  } else {
    const res = await runOpenClaw(sandboxName, ctx, ["nodes", "pending", "--json"])
    const pending = parseNodeRequests(res.stdout)
    if (pending.length === 0) throw new Error("no pending node requests — open the app so it re-files, then retry")
    targetId = pending[pending.length - 1].requestId
  }

  const res = await runOpenClaw(sandboxName, ctx, ["nodes", "approve", targetId])
  if (res.code !== 0 || /failed|error|unknown requestId|pairing required/i.test(res.stdout)) {
    throw new Error(res.stdout || res.stderr || "failed to approve node request")
  }
  return { output: res.stdout || "approved" }
}
