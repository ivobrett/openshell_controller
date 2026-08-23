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
// Relaxed 2026-08-23: this used to pin the EXACT destructured field list, so
// adding any new field to useInventory() broke it (hit when
// awaitingFirstSandbox was added for the fresh-box gateway empty state). The
// assertion's purpose is that the page reads its startup/error state from the
// authoritative hook — not that the field list is frozen. Check each required
// field individually so the guard survives additions but still fails if one of
// them is dropped.
const inventoryDestructure = pageSource.match(/const \{([^}]*)\} = useInventory\(/)
assert.ok(inventoryDestructure, 'page must destructure useInventory()')
for (const field of ['sandboxes', 'nemoclaw', 'isLoading', 'error', 'refetch']) {
  assert.match(
    inventoryDestructure[1],
    new RegExp(`\\b${field}\\b`),
    `page must read ${field} from useInventory — startup/error state must stay hook-owned`,
  )
}
assert.match(pageSource, /isLoading \? \(/, 'page must render initializing from authoritative inventory state')
assert.match(pageSource, /data-testid="inventory-loading-state"/, 'page must expose loading state marker')
assert.match(pageSource, /error &&/, 'page must render error state from authoritative inventory state')
assert.match(pageSource, /data-testid="inventory-error-state"/, 'page must expose error state marker')
assert.match(pageSource, /sandboxes\.length === 0 \? \(/, 'page must render explicit empty state when inventory is valid but empty')
assert.match(pageSource, /data-testid="inventory-empty-state"/, 'page must expose empty state marker')

console.log('initializing-hang-check: PASS page-owned startup/error/empty state assertions')
