import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'

const root = process.cwd()
const pagePath = path.join(root, 'app/(shell)/page.tsx')
const hookPath = path.join(root, 'app/hooks/queries.ts')

const pageSource = await readFile(pagePath, 'utf8')
const hookSource = await readFile(hookPath, 'utf8')

assert.match(hookSource, /useQuery\(/, 'authoritative inventory hook must use TanStack Query for SSR-safe loading state')
assert.match(hookSource, /keepPreviousData/, 'authoritative inventory hook must preserve previous data during refetch')
assert.match(pageSource, /const \{ sandboxes, nemoclaw, isLoading, error, refetch \} = useInventory\(/, 'page must read loading and error from useInventory')
assert.match(pageSource, /isLoading \? \(/, 'page must render initializing from authoritative inventory state')
assert.match(pageSource, /data-testid="inventory-loading-state"/, 'page must expose loading state marker')
assert.match(pageSource, /error &&/, 'page must render error state from authoritative inventory state')
assert.match(pageSource, /data-testid="inventory-error-state"/, 'page must expose error state marker')
assert.match(pageSource, /sandboxes\.length === 0 \? \(/, 'page must render explicit empty state when inventory is valid but empty')
assert.match(pageSource, /data-testid="inventory-empty-state"/, 'page must expose empty state marker')

console.log('initializing-hang-check: PASS page-owned startup/error/empty state assertions')
