import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import ts from 'typescript'
import { createRequire } from 'node:module'

const root = process.cwd()
const sourcePath = path.join(root, 'app/lib/controlAuth.ts')

// controlAuth.ts is a shim over app/lib/auth/*.ts, which Node cannot require
// directly. Transpile each relative .ts import on demand; everything else
// (.mjs, node:, packages) goes through Node's own require.
const tsCache = new Map()
function loadTs(file) {
  if (tsCache.has(file)) return tsCache.get(file).exports
  const compiled = ts.transpileModule(readFileSync(file, 'utf8'), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
  }).outputText
  const module = { exports: {} }
  tsCache.set(file, module)
  const nodeRequire = createRequire(file)
  const localRequire = (spec) => {
    if (spec.startsWith('.')) {
      const base = path.resolve(path.dirname(file), spec)
      for (const candidate of [base, `${base}.ts`, path.join(base, 'index.ts')]) {
        if (candidate.endsWith('.ts') && existsSync(candidate)) return loadTs(candidate)
      }
    }
    return nodeRequire(spec)
  }
  vm.runInNewContext(compiled, {
    require: localRequire,
    exports: module.exports,
    module,
    process,
    URL,
    TextEncoder,
    TextDecoder,
    crypto: globalThis.crypto,
    atob,
    btoa,
    console,
  }, { filename: file })
  return module.exports
}

function mockRequest(protocol, headers = {}) {
  return {
    nextUrl: { protocol },
    headers: {
      get(name) {
        return headers[name.toLowerCase()] || null
      },
    },
  }
}

const originalEnv = {
  cookieSecure: process.env.OPENSHELL_CONTROL_COOKIE_SECURE,
  publicBaseUrl: process.env.PUBLIC_BASE_URL,
}

try {
  delete process.env.OPENSHELL_CONTROL_COOKIE_SECURE
  delete process.env.PUBLIC_BASE_URL

  const module = { exports: loadTs(sourcePath) }

  assert.equal(module.exports.shouldUseSecureSessionCookie(mockRequest('http:')), false)
  assert.equal(module.exports.sessionCookieOptionsForRequest(mockRequest('http:')).secure, false)
  assert.equal(module.exports.shouldUseSecureSessionCookie(mockRequest('https:')), true)
  assert.equal(
    module.exports.shouldUseSecureSessionCookie(mockRequest('http:', { 'x-forwarded-proto': 'https' })),
    true,
  )

  process.env.PUBLIC_BASE_URL = 'https://control.example.test'
  assert.equal(module.exports.shouldUseSecureSessionCookie(), true)

  process.env.OPENSHELL_CONTROL_COOKIE_SECURE = 'false'
  assert.equal(module.exports.shouldUseSecureSessionCookie(mockRequest('https:')), false)

  process.env.OPENSHELL_CONTROL_COOKIE_SECURE = 'true'
  assert.equal(module.exports.shouldUseSecureSessionCookie(mockRequest('http:')), true)
} finally {
  if (originalEnv.cookieSecure === undefined) {
    delete process.env.OPENSHELL_CONTROL_COOKIE_SECURE
  } else {
    process.env.OPENSHELL_CONTROL_COOKIE_SECURE = originalEnv.cookieSecure
  }

  if (originalEnv.publicBaseUrl === undefined) {
    delete process.env.PUBLIC_BASE_URL
  } else {
    process.env.PUBLIC_BASE_URL = originalEnv.publicBaseUrl
  }
}

console.log('control-auth-cookie-check: PASS request-aware secure cookie assertions')
