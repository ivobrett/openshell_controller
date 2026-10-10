// Behavioural checks for scripts/inter-sandbox/isc.py against a mock broker.
//
// The helper is what agents rely on to talk to each other, and the controller
// writes it into every sandbox on MCP sync. Each assertion is a failure seen
// on the Oracle BYOVPS before 2026-10-10: backlog answered after a restart,
// agents answering each other's answers until quota ran out, a mention of
// "ivos-hermes2" waking "ivos-hermes", and listeners printing errors that the
// runtime then treated as messages.

import assert from 'node:assert/strict'
import { execFile, spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import http from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const ISC = path.join(root, 'scripts/inter-sandbox/isc.py')

if (spawnSync('python3', ['--version']).status !== 0 || spawnSync('curl', ['--version']).status !== 0) {
  console.log('SKIP: python3 and curl are required for the isc.py behavioural checks')
  process.exit(0)
}

// --- mock broker ---
const messages = []
let seq = 0
const tools = ['read_messages', 'post_message'].map((name) => ({ name: `inter-sandbox-chat__${name}` }))
function handle(body) {
  if (body.method === 'tools/list') return { tools }
  const { name, arguments: args } = body.params
  let out
  if (name.endsWith('__post_message')) {
    const entry = {
      id: `${1000 + ++seq}-mock${seq}`,
      at: new Date(1e12 + seq * 1000).toISOString(),
      room: args.room,
      sender: args.sender,
      message: args.message,
      targets: { sandboxNames: args.targetSandboxNames || [], sandboxIds: [], agentIds: [] },
    }
    messages.push(entry)
    out = { ok: true, room: args.room, message: entry }
  } else {
    assert.ok(args.limit >= 1 && args.limit <= 100, 'read_messages limit must stay within the broker schema')
    const start = args.afterId ? messages.findIndex((m) => m.id === args.afterId) + 1 : 0
    out = { ok: true, room: args.room, messages: messages.slice(start).slice(-args.limit) }
  }
  return { content: [{ type: 'text', text: JSON.stringify(out) }] }
}
const server = http.createServer((req, res) => {
  let raw = ''
  req.on('data', (chunk) => { raw += chunk })
  req.on('end', () => {
    res.setHeader('content-type', 'application/json')
    if (!String(req.headers['x-openshell-mcp-token'] || '').startsWith('osmcp_')) {
      res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32001, message: 'unavailable' } }))
      return
    }
    const body = JSON.parse(raw)
    res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: handle(body) }))
  })
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const url = `http://127.0.0.1:${server.address().port}/api/mcp/broker/mcp`

// --- two sandboxes ---
const dir = await mkdtemp(path.join(tmpdir(), 'isc-check-'))
async function sandbox(name) {
  const home = path.join(dir, name)
  const manifest = path.join(dir, `${name}.md`)
  await writeFile(manifest, `# OpenShell Control MCP Broker\n\nSandbox: ${name}\n\n- MCP: \`${url}\`\n\n\`\`\`\nosmcp_test-${name}\n\`\`\`\n`)
  const env = { ...process.env, ISC_HOME: home, ISC_MANIFEST: manifest, NO_PROXY: '*', no_proxy: '*' }
  // Async on purpose: the mock broker lives in this process, so a blocking
  // spawn would stop it from answering.
  const run = (...args) => new Promise((resolve) => {
    execFile('python3', [ISC, ...args], { env, encoding: 'utf8' }, (error, stdout, stderr) => {
      resolve({ code: error?.code ?? 0, out: stdout.trim(), err: stderr.trim() })
    })
  })
  const runAsync = run
  return { name, run, runAsync, home }
}
const inboxLines = (r) => r.out.split('\n').filter(Boolean).map((line) => {
  assert.ok(line.startsWith('ISC-MESSAGE '), `listener lines must carry the match prefix: ${line}`)
  return JSON.parse(line.slice('ISC-MESSAGE '.length))
})

try {
  const hermes = await sandbox('ivos-hermes')
  const claw = await sandbox('ivos-openclaw')
  const hermes2 = await sandbox('ivos-hermes2')

  // identity + reachability come from the manifest alone
  const check = JSON.parse((await hermes.run('check')).out)
  assert.equal(check.ok, true)
  assert.equal(check.me, 'ivos-hermes')
  assert.equal(check.broker, url)

  // backlog from before the first look is never delivered
  messages.push({ id: '900-old', at: 'x', sender: 'ivos-openclaw', message: '@ivos-hermes old question', targets: {} })
  assert.equal((await hermes.run('inbox')).out, '', 'the first poll must only baseline')
  assert.equal((await hermes2.run('inbox')).out, '')
  assert.equal((await claw.run('inbox')).out, '')

  // a request is delivered once, to the addressed sandbox only
  const sent = JSON.parse((await claw.run('send', 'ivos-hermes', 'what time is it?')).out)
  assert.equal(sent.ok, true)
  assert.ok(sent.id)
  const got = inboxLines((await hermes.run('inbox')))
  assert.equal(got.length, 1)
  assert.deepEqual({ from: got[0].from, kind: got[0].kind, text: got[0].text }, { from: 'ivos-openclaw', kind: 'request', text: 'what time is it?' })
  assert.equal((await hermes.run('inbox')).out, '', 'a message must not be delivered twice')
  assert.equal((await hermes2.run('inbox')).out, '', 'a longer sandbox name must not receive a shorter name\'s mail')
  assert.equal((await claw.run('inbox')).out, '', 'a sender never receives its own message')

  // a bare @mention without target fields is still delivered, on a name boundary
  messages.push({ id: '2000-raw', at: 'x', sender: 'someone', message: 'hey @ivos-hermes2 are you there', targets: {} })
  assert.equal((await hermes.run('inbox')).out, '')
  assert.equal(inboxLines((await hermes2.run('inbox')))[0].text, 'hey are you there')

  // reply: answers the right sender, carries the marker, cannot be repeated
  const replied = JSON.parse((await hermes.run('reply', got[0].id, 'half past nine')).out)
  assert.deepEqual(replied.to, ['ivos-openclaw'])
  assert.match(messages.at(-1).message, new RegExp(`^@ivos-openclaw \\[re:${got[0].id}\\] half past nine$`))
  assert.equal((await hermes.run('reply', got[0].id, 'again')).code, 3, 'a message may be answered only once')

  // the answer arrives as kind=reply, and answering an answer is refused
  const answer = inboxLines((await claw.run('inbox')))
  assert.equal(answer[0].kind, 'reply')
  assert.equal(answer[0].text, 'half past nine')
  const refused = (await claw.run('reply', answer[0].id, 'thanks!'))
  assert.equal(refused.code, 3, 'answers must never be answered (ping-pong loops)')
  assert.equal((await hermes.run('inbox')).out, '')

  // ask: blocks for the matching answer and keeps it away from the listener
  const pending = claw.runAsync('ask', 'ivos-hermes', 'capital of Portugal?', '--wait', '20')
  let question
  for (let i = 0; i < 40 && !question; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 250))
    question = inboxLines((await hermes.run('inbox')))[0]
  }
  assert.ok(question, 'the question must reach the peer')
  assert.equal((await hermes.run('reply', question.id, 'Lisbon')).code, 0)
  assert.equal((await claw.run('inbox')).out, '', 'an awaited answer must not also wake the background listener')
  const asked = JSON.parse((await pending).out)
  assert.deepEqual(asked, { ok: true, from: 'ivos-hermes', answer: 'Lisbon' })

  // monitor (Hermes): output changes only when a new message arrives
  const before = (await hermes.run('monitor')).out
  assert.equal((await hermes.run('monitor')).out, before, 'monitor output must be byte-stable while nothing arrives')
  await claw.run('send', 'ivos-hermes', 'one more')
  const after = (await hermes.run('monitor')).out
  assert.notEqual(after, before)
  assert.ok(after.startsWith(before) || before === '', 'monitor output must be append-only so the diff is just the new message')
  assert.equal((await hermes.run('monitor')).out, after)

  // loop guard
  let last
  for (let i = 0; i < 12; i += 1) last = (await hermes2.run('send', 'ivos-openclaw', `spam ${i}`))
  assert.equal(last.code, 3, 'the per-peer loop guard must stop a runaway sender')
  assert.match(last.err, /loop guard/)

  // refusals
  assert.equal((await hermes.run('send', 'ivos-hermes', 'hi me')).code, 2)
  assert.equal((await hermes.run('send', 'bad name; rm -rf', 'x')).code, 2)

  // a broker that rejects the token gives an instruction, not a stack trace
  const locked = await sandbox('locked-out')
  await writeFile(path.join(dir, 'locked-out.md'), `Sandbox: locked-out\n\n- MCP: \`${url}\`\n\n\`\`\`\nnot-a-token\n\`\`\`\n`)
  const denied = (await locked.run('check'))
  assert.equal(denied.code, 2)
  assert.match(denied.err, /re-issue MCP access/)
  assert.doesNotMatch(denied.err, /Traceback/)

  // --- source guards ---
  const source = await readFile(ISC, 'utf8')
  assert.match(source, /^ISC_VERSION = 7$/m)
  assert.doesNotMatch(source, /^import (requests|httpx|yaml)|urllib\.request/m, 'standard library + curl only: sandboxes route HTTP through a proxy that curl honours')
  assert.match(source, /stderr=subprocess\.DEVNULL/, 'the listener must not leak poll errors into lines the runtime reads')
  assert.match(source, /"--stream-mode", "match"/, 'the OpenClaw listener must only fire on ISC-MESSAGE lines')
  assert.match(source, /"--monitor-script"/, 'the Hermes listener must use monitor mode, which runs the model only on change')
  assert.match(source, /"--no-deliver"/)
  assert.match(source, /"--deliver", "local"/)

  const manifest = await readFile(path.join(root, 'app/lib/sandboxMcpManifest.ts'), 'utf8')
  assert.match(manifest, /installInterSandboxHelper\(sandboxName\)/, 'MCP sync must write the helper into the sandbox')
  assert.match(manifest, /## Talking to other sandboxes/)

  const store = await readFile(path.join(root, 'app/lib/mcpBrokerStore.ts'), 'utf8')
  assert.match(store, /session\.expiresAt = renewed/, 'a broker token in use must be renewed, not expire after a week')
} finally {
  server.close()
  await rm(dir, { recursive: true, force: true })
}
