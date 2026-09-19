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

// RESTORED 2026-09-19 when the OpenClaw pin was reverted 2026.9.1 -> 2026.7.1.
// 2026.7.1 still leaves a SYMLINK at /sandbox/.openclaw/exec-approvals.json,
// which the agent cannot write through, so this normalises it to a real
// sandbox-owned file. It was removed while we were on 2026.9.1 (which writes a
// real file itself, making the repair actively harmful — it would delete and
// rewrite live approvals state). If the OpenClaw pin ever moves to 2026.9.1+
// again, remove this AND its call sites again.

async function sandboxHasOpenClaw(sandboxName: string) {
  const probe = await runSandboxShell(sandboxName, "test -f /sandbox/.openclaw/openclaw.json")
  return probe.code === 0
}

export async function repairOpenClawExecApprovalsFile(sandboxName: string) {
  if (!(await sandboxHasOpenClaw(sandboxName))) {
    return {
      sandboxName,
      path: "/sandbox/.openclaw/exec-approvals.json",
      skipped: true,
      reason: "OpenClaw is not installed in this sandbox; nothing to repair.",
    }
  }
  const normalizeScript = [
    `const fs = require("fs")`,
    `const approval = "/sandbox/.openclaw/exec-approvals.json"`,
    `const tmp = process.argv[1]`,
    `let source = ""`,
    `try { source = fs.readFileSync(approval, "utf8") } catch {}`,
    `const trimmed = source.trim()`,
    `let payload = "{}\\n"`,
    `if (trimmed) { try { payload = JSON.stringify(JSON.parse(trimmed), null, 2) + "\\n" } catch {} }`,
    `fs.writeFileSync(tmp, payload)`,
  ].join("; ")
  const script = [
    `mkdir -p /sandbox/.openclaw`,
    `tmp="/sandbox/.openclaw/.exec-approvals.json.$$"`,
    `node -e ${shellQuote(normalizeScript)} "$tmp"`,
    `rm -f /sandbox/.openclaw/exec-approvals.json`,
    `mv "$tmp" /sandbox/.openclaw/exec-approvals.json`,
    `chown sandbox:sandbox /sandbox/.openclaw/exec-approvals.json 2>/dev/null || chown 998:998 /sandbox/.openclaw/exec-approvals.json`,
    `chmod 0600 /sandbox/.openclaw/exec-approvals.json`,
  ].join(" && ")
  const result = await runSandboxShell(sandboxName, script)
  if (result.code !== 0) throw new Error(result.stderr || "failed to repair OpenClaw exec approvals file")
  return {
    sandboxName,
    path: "/sandbox/.openclaw/exec-approvals.json",
    note: "Replaced OpenClaw exec approvals symlink with a real sandbox-owned file for newer OpenClaw versions.",
  }
}
