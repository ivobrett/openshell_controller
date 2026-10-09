// The controller terminal must open a SHELL in the sandbox, not attach to its
// main process.
//
// `openshell sandbox connect <name>` gave a shell up to OpenShell 0.0.106. From
// 0.0.111 it attaches to the sandbox's main process (Ctrl-P Ctrl-Q to detach):
// on an agent sandbox the operator sees the gateway's log stream, input is
// ignored, and Ctrl-C can stop the agent gateway — which puts the sandbox in
// OpenShell's sticky Error phase. Found 2026-10-09 on the Oracle BYOVPS right
// after its 0.0.85 -> 0.0.116 upgrade.

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const source = await readFile(new URL('../terminal-server.mjs', import.meta.url), 'utf8')

assert.doesNotMatch(
  source,
  /return `\$\{safeBin\} sandbox connect /,
  'terminal must not run `openshell sandbox connect` (attaches to the main process on OpenShell >= 0.0.111)',
)
assert.match(
  source,
  /return `\$\{safeBin\} sandbox exec -n \$\{safeName\} --tty -- sh -c \$\{loginShell\}`/,
  'terminal must open an interactive shell with `openshell sandbox exec --tty`',
)
assert.match(source, /exec bash -l \|\| exec sh -l/, 'fall back to sh when the sandbox image has no bash')
assert.match(source, /OPENSHELL_TERMINAL_ATTACH_TEMPLATE/, 'the operator override must remain available')
