/**
 * Step 5.5 — refresh-ids.
 *
 * For every pt-path that push-zh will touch (new push, updated push, or stale
 * marker), ensure we have up-to-date `{key → stringId}` mapping on disk.
 * Two input lists feed this:
 *
 *   - stale-ids.json        pt-paths whose ids changed because push-en just
 *                           replaced the file on PT (ids are re-minted on every
 *                           file replace)
 *   - files-to-refresh.json pt-paths that push-zh intends to hit (from diff-zh)
 *
 * Their union = refresh set. For each pt-path, we paginate
 * `GET /projects/18818/strings?file={fileId}` and persist the mapping.
 *
 * Files whose fileId we don't know yet (newly-created) are logged and skipped;
 * push-en should have filled files.json but a prior partial run may have left
 * a gap. Those gaps heal on the next daily run.
 *
 * After a successful refresh, the pt-path is cleared from `stale-ids.json`.
 */

import { mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import {
  CACHE_DIR,
  CACHE_PATHS,
  CONCURRENCY,
  PT_18818_ID,
  assertToken,
} from './lib/config.ts'
import {
  readFileIds,
  readJson,
  writeJson,
  writeStringIds,
} from './lib/cache.ts'
import { apiGet, fetchAllPages, runBounded } from './lib/pt-client.ts'

interface PtStringRow { id: number, key: string }
const PAGE_SIZE = 1000

async function refreshOne(fileId: number): Promise<Record<string, number>> {
  const rows = await fetchAllPages<PtStringRow>(page =>
    apiGet(`/projects/${PT_18818_ID}/strings?file=${fileId}&page=${page}&pageSize=${PAGE_SIZE}`),
  )
  const out: Record<string, number> = {}
  for (const r of rows) out[r.key] = r.id
  return out
}

async function main(): Promise<void> {
  assertToken()

  const stale = (await readJson<string[]>(join(CACHE_DIR, CACHE_PATHS.staleIds))) ?? []
  const fromDiff = (await readJson<string[]>(join(CACHE_DIR, CACHE_PATHS.filesToRefresh))) ?? []
  const fileIds = await readFileIds()

  const union = new Set([...stale, ...fromDiff])
  if (union.size === 0) {
    // eslint-disable-next-line no-console
    console.log('[refresh-ids] nothing to refresh')
    return
  }

  const targets: Array<{ ptPath: string, fileId: number }> = []
  const missing: string[] = []
  for (const ptPath of union) {
    const fileId = fileIds[ptPath]
    if (typeof fileId !== 'number')
      missing.push(ptPath)
    else
      targets.push({ ptPath, fileId })
  }
  if (missing.length > 0)
    // eslint-disable-next-line no-console
    console.warn(`[refresh-ids] ${missing.length} path(s) have no known fileId: ${missing.slice(0, 5).join(', ')}${missing.length > 5 ? '…' : ''}`)

  const tasks = targets.map(t => async () => {
    const map = await refreshOne(t.fileId)
    await writeStringIds(t.ptPath, map)
    return { ptPath: t.ptPath, count: Object.keys(map).length }
  })
  const { successes, failures, results } = await runBounded(tasks, CONCURRENCY)

  // Clear stale-ids for pt-paths that refreshed successfully. Leave the
  // failures in place so the next run retries them.
  const remainingStale = new Set(stale)
  for (let i = 0; i < results.length; i++) {
    const r = results[i]
    if (!(r instanceof Error))
      remainingStale.delete(targets[i].ptPath)
  }
  await mkdir(dirname(join(CACHE_DIR, CACHE_PATHS.staleIds)), { recursive: true })
  await writeJson(join(CACHE_DIR, CACHE_PATHS.staleIds), [...remainingStale])

  // eslint-disable-next-line no-console
  console.log(`[refresh-ids] ${successes} ok / ${failures} failed (of ${targets.length}); missing fileIds: ${missing.length}`)
  if (failures > 0) {
    for (let i = 0; i < results.length; i++) {
      const r = results[i]
      if (r instanceof Error)
        // eslint-disable-next-line no-console
        console.error(`  fail ${targets[i].ptPath}: ${r.message}`)
    }
    process.exit(1)
  }
}

void main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[refresh-ids] failed:', err)
  process.exit(1)
})
