import assert from 'node:assert/strict'
import { readFile, mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

const root = process.cwd()
const listRoutePath = path.join(root, 'app/api/skills/route.ts')
const detailRoutePath = path.join(root, 'app/api/skills/[skillId]/route.ts')

const [listSource, detailSource] = await Promise.all([
  readFile(listRoutePath, 'utf8'),
  readFile(detailRoutePath, 'utf8'),
])

// Traversal guard: the detail route must resolve the path and assert it starts with the resolved SKILLS_DIR
assert.match(detailSource, /path\.resolve\(p\)\.startsWith\(resolvedDir \+ path\.sep\)/, 'detail route must assert resolved path starts with resolved SKILLS_DIR + sep (traversal guard)')

// ID regex present in both routes
assert.match(listSource, /ID_RE\s*=\s*\/\^/, 'list route must define the ID regex')
assert.match(detailSource, /ID_RE\s*=\s*\/\^/, 'detail route must define the ID regex')
assert.match(detailSource, /ID_RE\.test\(skillId\)/, 'detail route must validate skillId against ID regex')

// Neither route exports POST, PUT, or DELETE
assert.doesNotMatch(listSource, /export\s+(async\s+)?function\s+POST/, 'list route must not export POST')
assert.doesNotMatch(listSource, /export\s+(async\s+)?function\s+PUT/, 'list route must not export PUT')
assert.doesNotMatch(listSource, /export\s+(async\s+)?function\s+DELETE/, 'list route must not export DELETE')
assert.doesNotMatch(detailSource, /export\s+(async\s+)?function\s+POST/, 'detail route must not export POST')
assert.doesNotMatch(detailSource, /export\s+(async\s+)?function\s+PUT/, 'detail route must not export PUT')
assert.doesNotMatch(detailSource, /export\s+(async\s+)?function\s+DELETE/, 'detail route must not export DELETE')

// List route skips files missing name/description (source check — the logic is present)
assert.match(listSource, /meta\.name.*meta\.description|meta\.description.*meta\.name/, 'list route must skip files missing name or description')

// List route reads from SKILLS_DIR (env override for testability)
assert.match(listSource, /process\.env\.SKILLS_DIR/, 'list route must support SKILLS_DIR env override for testability')
assert.match(detailSource, /process\.env\.SKILLS_DIR/, 'detail route must support SKILLS_DIR env override for testability')

console.log('skills-route-check: PASS traversal guard, id regex, no-write exports, name/description skip, env override')
