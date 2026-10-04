// Source-level guards for scripts/pii-router (the Python suite needs laya +
// litellm installed, which a normal checkout does not have; this runs in
// `npm test` everywhere). Each assertion protects a fail-closed property.

import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "scripts/pii-router")
const read = (p) => readFileSync(path.join(ROOT, p), "utf8")
const render = read("pii_router/render_config.py")
const hook = read("pii_router/hook.py")
const policy = read("pii_router/policy.py")
const install = read("install.sh")

// The public model must resolve to the LOCAL backend, so an unloaded hook never reaches the cloud.
assert.match(render, /\{"model_name": PUBLIC, "litellm_params": dict\(local_params\)\}/,
  "the public 'pii-router' model must point at the local backend")
assert.match(render, /"num_retries": 0/, "retries could move a request to the other backend")

// The hook decides for every chat call regardless of the requested model (no bypass) and fails closed.
assert.doesNotMatch(hook, /if requested != /, "the hook must not skip requests by model name")
assert.match(hook, /except Exception as error:[\s\S]*"route": LOCAL/, "a router bug must route local")

// Laya failures and oversize must fail closed; defaults must be local.
assert.match(policy, /reasons\.add\("laya_unavailable"\)/)
assert.match(policy, /oversize_route: str = LOCAL/)
assert.match(policy, /media_route: str = LOCAL/)

// The installer must preserve the master key across re-runs (the OpenShell provider holds it).
assert.match(install, /MASTER_KEY="\$\(existing LITELLM_MASTER_KEY\)"/)

console.log("PASS: pii-router fail-closed guards")
