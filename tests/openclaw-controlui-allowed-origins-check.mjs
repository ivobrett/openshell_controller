// Guards the controller-managed OpenClaw Control-UI Origin allowlist seed.
//
// Background: OpenClaw's gateway enforces a browser-Origin allowlist
// (gateway.controlUi.allowedOrigins). External clients — the Obsidian plugin
// (Origin: app://obsidian.md), other desktop apps, a browser Control UI opened
// at the public host — are otherwise rejected with ws close 4008 "origin not
// allowed" AFTER a successful 101 + connect.challenge, which masquerades as a
// token/transport failure. Enumerating every client origin is unworkable; the
// gateway honours "*". We gate real access behind Pangolin auth + IP allowlist
// and the gateway auth token, so "*" is the right default for controller-managed
// sandboxes. These asserts stop the seed from silently regressing.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const here = path.dirname(fileURLToPath(import.meta.url))
const repo = path.join(here, '..')
const read = (rel) => readFileSync(path.join(repo, rel), 'utf8')

const LIB = 'app/lib/openclawPairing.ts'
const CREATE = 'app/api/sandbox/create/route.ts'
const EXPOSE = 'app/api/sandbox/[sandboxId]/openclaw-remote/route.ts'

// ── 1. The helper exists and writes allowedOrigins=['*'] on gateway.controlUi ──
{
  const lib = read(LIB)
  assert.match(
    lib,
    /export async function ensureControlUiAllowedOriginsOpen\(sandboxName: string\): Promise<\{ changed: boolean \}>/,
    'ensureControlUiAllowedOriginsOpen must be exported from openclawPairing.ts',
  )
  const fnStart = lib.indexOf('export async function ensureControlUiAllowedOriginsOpen')
  const body = lib.slice(fnStart, fnStart + 900)
  assert.match(
    body,
    /setdefault\('gateway',\{\}\)\.setdefault\('controlUi',\{\}\)/,
    'must target gateway.controlUi',
  )
  assert.match(
    body,
    /cu\['allowedOrigins'\]=\['\*'\]/,
    "must set allowedOrigins to the ['*'] wildcard",
  )
  // Atomic write (tmp + os.replace) like ensureAutoApproveNodes — never a partial
  // openclaw.json that would brick the gateway on its next start.
  assert.match(body, /os\.replace\(tmp,p\)/, 'must write openclaw.json atomically (tmp + os.replace)')
}

// ── 2. The create route seeds it for every OpenClaw sandbox ──
{
  const create = read(CREATE)
  assert.match(
    create,
    /import \{[^}]*ensureControlUiAllowedOriginsOpen[^}]*\} from "@\/app\/lib\/openclawPairing"/,
    'create route must import ensureControlUiAllowedOriginsOpen',
  )
  // Gated on the OpenClaw agent + successful create, same as autoApproveNodes.
  assert.match(
    create,
    /created && isOpenClawAgent\s*\?\s*await ensureControlUiAllowedOriginsOpen\(sandboxName\)/,
    'create route must call ensureControlUiAllowedOriginsOpen guarded by (created && isOpenClawAgent)',
  )
}

// ── 3. The remote-expose route seeds it when a gateway is exposed ──
{
  const expose = read(EXPOSE)
  assert.match(
    expose,
    /import \{[^}]*ensureControlUiAllowedOriginsOpen[^}]*\} from "@\/app\/lib\/openclawPairing"/,
    'openclaw-remote route must import ensureControlUiAllowedOriginsOpen',
  )
  assert.match(
    expose,
    /await ensureControlUiAllowedOriginsOpen\(sandboxName\)/,
    'openclaw-remote route must call ensureControlUiAllowedOriginsOpen on expose',
  )
}

console.log('PASS: openclaw-controlui-allowed-origins-check')
