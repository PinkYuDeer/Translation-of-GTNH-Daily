/**
 * Step 6 — push-zh.
 *
 * Two independent push phases, both trying batch
 * `PUT /projects/18818/strings` first, then falling back to per-string
 * `PUT /projects/18818/strings/{stringId}` when the batch endpoint rejects the
 * payload or is unavailable:
 *
 * (a) Normal push: every row queued in `push-queue.json` (from diff-zh) is
 *     pushed as-is with its (normalized) translation and stage.
 *
 * (b) Stale-marker push: whatever is left in `pending-update.json` after
 *     diff-zh had its turn represents keys whose English changed but 4964
 *     has no matching new translation. We synthesise a translation of the
 *     form `"${newEnglish}|旧译|${oldChinese}"` with stage=0 so the PT UI
 *     surfaces it as "needs review".
 *
 * Both phases read stringIds from `file-ids/<pt-path>.strings.json`
 * (populated by refresh-ids.ts). A row whose key is missing from that map is
 * dropped with a warning — refresh-ids will see it again on the next run,
 * and it'll heal itself.
 *
 * zh-lastrun is updated per pt-path *after* all its rows succeed, so a crash
 * mid-file doesn't leave an inconsistent snapshot that would cause push-zh
 * to re-push the same rows tomorrow.
 */

import { join } from 'node:path'

import {
  BUILD_DIR,
  CACHE_DIR,
  CACHE_PATHS,
  CONCURRENCY,
  PT_18818_ID,
  assertToken,
} from './lib/config.ts'
import {
  readJson,
  readFileIds,
  readStringIds,
  readZhLastrun,
  writePendingUpdate,
  writeZhLastrun,
  type PendingUpdateEntry,
} from './lib/cache.ts'
import { apiPutJson, apiPutJsonRaw, runBounded } from './lib/pt-client.ts'
import { normalizeNewlines } from './lib/newlines.ts'
import type { PtStringItem } from './lib/lang-parser.ts'

const BATCH_SIZE = 100

interface PushEntry {
  ptPath: string
  key: string
  translation: string
  stage: number
}

interface Row {
  ptPath: string
  key: string
  stringId: number
  fileId: number
  original: string
  translation: string
  stage: number
  context?: string
}

interface BatchRowPayload {
  id: number
  key: string
  original: string
  translation: string
  file: number
  stage: number
  context?: string
}

async function putOneString(row: Row): Promise<void> {
  await apiPutJson(`/projects/${PT_18818_ID}/strings/${row.stringId}`, {
    key: row.key,
    original: row.original,
    translation: row.translation,
    file: row.fileId,
    stage: row.stage,
    ...(row.context != null ? { context: row.context } : {}),
  })
}

function toBatchPayload(row: Row): BatchRowPayload {
  return {
    id: row.stringId,
    key: row.key,
    original: row.original,
    translation: row.translation,
    file: row.fileId,
    stage: row.stage,
    ...(row.context != null ? { context: row.context } : {}),
  }
}

function chunkRows<T>(rows: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < rows.length; i += size)
    out.push(rows.slice(i, i + size))
  return out
}

function recordSuccess(
  perFileUpdates: Map<string, Map<string, { translation: string, stage: number }>>,
  row: Row,
): void {
  let m = perFileUpdates.get(row.ptPath)
  if (!m) {
    m = new Map()
    perFileUpdates.set(row.ptPath, m)
  }
  m.set(row.key, { translation: row.translation, stage: row.stage })
}

async function pushRows(
  label: string,
  rows: Row[],
  perFileUpdates: Map<string, Map<string, { translation: string, stage: number }>>,
): Promise<{ successes: number, failures: number, results: (true | Error | undefined)[] }> {
  const results: (true | Error | undefined)[] = new Array(rows.length)
  if (rows.length === 0)
    return { successes: 0, failures: 0, results }

  let warnedFallback = false
  const chunks = chunkRows(rows, BATCH_SIZE)
  const tasks = chunks.map((chunk, chunkIndex) => async () => {
    const start = chunkIndex * BATCH_SIZE
    try {
      await apiPutJsonRaw(`/projects/${PT_18818_ID}/strings`, chunk.map(toBatchPayload))
      for (let i = 0; i < chunk.length; i++) {
        recordSuccess(perFileUpdates, chunk[i])
        results[start + i] = true
      }
      return
    }
    catch (err) {
      if (!warnedFallback) {
        warnedFallback = true
        // eslint-disable-next-line no-console
        console.warn(`[push-zh] ${label}: batch PUT /strings failed, fallback to per-string PUT: ${err instanceof Error ? err.message : err}`)
      }
    }

    for (let i = 0; i < chunk.length; i++) {
      try {
        await putOneString(chunk[i])
        recordSuccess(perFileUpdates, chunk[i])
        results[start + i] = true
      }
      catch (err) {
        results[start + i] = err as Error
      }
    }
  })
  await runBounded(tasks, CONCURRENCY)

  let successes = 0
  let failures = 0
  for (const r of results) {
    if (r instanceof Error)
      failures++
    else if (r === true)
      successes++
    else
      failures++
  }
  return { successes, failures, results }
}

/**
 * Group entries by pt-path so we can write each zh-lastrun file once per
 * pt-path *after all its rows succeed*, rather than once per row.
 */
function groupByPtPath<T extends { ptPath: string }>(rows: T[]): Map<string, T[]> {
  const out = new Map<string, T[]>()
  for (const r of rows) {
    const arr = out.get(r.ptPath) ?? []
    arr.push(r)
    out.set(r.ptPath, arr)
  }
  return out
}

/**
 * Merge outgoing rows into the existing zh-lastrun file. We need *all*
 * previously-pushed keys to carry over (so future diffs still see the full
 * snapshot), not just the ones we pushed today.
 */
async function flushLastrun(ptPath: string, updates: Map<string, { translation: string, stage: number }>): Promise<void> {
  const existing = (await readZhLastrun(ptPath)) ?? []
  const byKey = new Map(existing.map(i => [i.key, i]))
  for (const [key, v] of updates) {
    const prev = byKey.get(key)
    if (prev) {
      prev.translation = v.translation
      prev.stage = v.stage
    }
    else {
      byKey.set(key, { key, original: '', translation: v.translation, stage: v.stage })
    }
  }
  await writeZhLastrun(ptPath, [...byKey.values()])
}

async function loadSourceByKey(ptPath: string): Promise<Map<string, PtStringItem>> {
  const items = (await readJson<PtStringItem[]>(join(BUILD_DIR, 'en', `${ptPath}.en.json`))) ?? []
  return new Map(items.map(item => [item.key, item]))
}

async function main(): Promise<void> {
  assertToken()

  // --- (a) Normal push ------------------------------------------------------
  const queue = (await readJson<PushEntry[]>(join(CACHE_DIR, CACHE_PATHS.pushQueue))) ?? []
  const byPath = groupByPtPath(queue)
  const fileIds = await readFileIds()

  // Preload stringId maps once per pt-path (avoids re-reading the same file
  // inside the task closure for every row).
  const stringIdsByPath = new Map<string, Record<string, number>>()
  const sourceByPath = new Map<string, Map<string, PtStringItem>>()
  for (const ptPath of byPath.keys())
    stringIdsByPath.set(ptPath, await readStringIds(ptPath))
  for (const ptPath of byPath.keys())
    sourceByPath.set(ptPath, await loadSourceByKey(ptPath))

  const resolvedRows: Row[] = []
  let droppedNormal = 0
  for (const [ptPath, rows] of byPath) {
    const ids = stringIdsByPath.get(ptPath) ?? {}
    const fileId = fileIds[ptPath]
    const sourceByKey = sourceByPath.get(ptPath) ?? new Map<string, PtStringItem>()
    for (const r of rows) {
      const sid = ids[r.key]
      const sourceRow = sourceByKey.get(r.key)
      if (typeof sid !== 'number' || typeof fileId !== 'number' || !sourceRow) {
        droppedNormal++
        continue
      }
      resolvedRows.push({
        ptPath,
        key: r.key,
        stringId: sid,
        fileId,
        original: sourceRow.original,
        translation: r.translation,
        stage: r.stage,
        ...(sourceRow.context != null ? { context: sourceRow.context } : {}),
      })
    }
  }

  const perFileUpdates = new Map<string, Map<string, { translation: string, stage: number }>>()
  const normalRes = await pushRows('normal', resolvedRows, perFileUpdates)
  // eslint-disable-next-line no-console
  console.log(`[push-zh] normal: ${normalRes.successes} ok / ${normalRes.failures} failed (dropped-no-id=${droppedNormal})`)

  // --- (b) Stale marker push ------------------------------------------------
  const pending = (await readJson<Record<string, Record<string, PendingUpdateEntry>>>(
    join(CACHE_DIR, CACHE_PATHS.pendingUpdate),
  )) ?? {}

  interface StaleRow extends Row { pendingKey: string }
  const staleRows: StaleRow[] = []
  let droppedStaleNoId = 0
  let droppedStaleNoPrior = 0

  for (const [ptPath, perFile] of Object.entries(pending)) {
    if (Object.keys(perFile).length === 0) continue
    let ids = stringIdsByPath.get(ptPath)
    if (!ids) {
      ids = await readStringIds(ptPath)
      stringIdsByPath.set(ptPath, ids)
    }
    let sourceByKey = sourceByPath.get(ptPath)
    if (!sourceByKey) {
      sourceByKey = await loadSourceByKey(ptPath)
      sourceByPath.set(ptPath, sourceByKey)
    }
    const fileId = fileIds[ptPath]
    const lastrun = await readZhLastrun(ptPath) ?? []
    const lastrunByKey = new Map<string, PtStringItem>(lastrun.map(i => [i.key, i]))

    for (const [key, { newOriginal }] of Object.entries(perFile)) {
      const sid = ids[key]
      const sourceRow = sourceByKey.get(key)
      if (typeof sid !== 'number' || typeof fileId !== 'number') {
        droppedStaleNoId++
        continue
      }
      const prev = lastrunByKey.get(key)
      const oldChinese = prev?.translation ?? ''
      if (!oldChinese) {
        // No prior translation to mark stale — nothing useful to signal.
        droppedStaleNoPrior++
        continue
      }
      const marker = `${normalizeNewlines(newOriginal)}|旧译|${normalizeNewlines(oldChinese)}`
      staleRows.push({
        ptPath,
        key,
        stringId: sid,
        fileId,
        original: sourceRow?.original ?? normalizeNewlines(newOriginal),
        translation: marker,
        stage: 0,
        pendingKey: key,
        ...(sourceRow?.context != null ? { context: sourceRow.context } : {}),
      })
    }
  }

  const staleRes = await pushRows('stale', staleRows, perFileUpdates)
  // eslint-disable-next-line no-console
  console.log(`[push-zh] stale:  ${staleRes.successes} ok / ${staleRes.failures} failed (dropped-no-id=${droppedStaleNoId} no-prior=${droppedStaleNoPrior})`)

  // Flush per-file lastrun updates.
  for (const [ptPath, updates] of perFileUpdates)
    await flushLastrun(ptPath, updates)

  // Clear successfully-pushed stale markers from pending-update so future
  // runs don't re-emit them.
  for (let i = 0; i < staleRes.results.length; i++) {
    const r = staleRes.results[i]
    if (r instanceof Error) continue
    const row = staleRows[i]
    const perFile = pending[row.ptPath]
    if (perFile) {
      delete perFile[row.pendingKey]
      if (Object.keys(perFile).length === 0)
        delete pending[row.ptPath]
    }
  }
  await writePendingUpdate(pending)

  if (normalRes.failures > 0 || staleRes.failures > 0) {
    const report = (label: string, res: typeof normalRes, rows: Array<{ ptPath: string, key: string }>) => {
      for (let i = 0; i < res.results.length; i++) {
        const r = res.results[i]
        if (r instanceof Error)
          // eslint-disable-next-line no-console
          console.error(`  ${label} fail ${rows[i].ptPath}:${rows[i].key}: ${r.message}`)
      }
    }
    report('normal', normalRes, resolvedRows)
    report('stale', staleRes, staleRows)
    process.exit(1)
  }
}

void main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[push-zh] failed:', err)
  process.exit(1)
})
