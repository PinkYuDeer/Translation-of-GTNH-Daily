/**
 * Step 6 — push-zh.
 *
 * Two independent push phases, both using per-string
 * `POST /projects/18818/strings/{stringId}/translation`:
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
  CACHE_DIR,
  CACHE_PATHS,
  CONCURRENCY,
  PT_18818_ID,
  assertToken,
} from './lib/config.ts'
import {
  readJson,
  readStringIds,
  readZhLastrun,
  writePendingUpdate,
  writeZhLastrun,
  type PendingUpdateEntry,
} from './lib/cache.ts'
import { apiPostJson, runBounded } from './lib/pt-client.ts'
import { normalizeNewlines } from './lib/newlines.ts'
import type { PtStringItem } from './lib/lang-parser.ts'

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
  translation: string
  stage: number
}

async function postOneTranslation(stringId: number, translation: string, stage: number): Promise<void> {
  await apiPostJson(`/projects/${PT_18818_ID}/strings/${stringId}/translation`, {
    translation,
    stage,
  })
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

async function main(): Promise<void> {
  assertToken()

  // --- (a) Normal push ------------------------------------------------------
  const queue = (await readJson<PushEntry[]>(join(CACHE_DIR, CACHE_PATHS.pushQueue))) ?? []
  const byPath = groupByPtPath(queue)

  // Preload stringId maps once per pt-path (avoids re-reading the same file
  // inside the task closure for every row).
  const stringIdsByPath = new Map<string, Record<string, number>>()
  for (const ptPath of byPath.keys())
    stringIdsByPath.set(ptPath, await readStringIds(ptPath))

  const resolvedRows: Row[] = []
  let droppedNormal = 0
  for (const [ptPath, rows] of byPath) {
    const ids = stringIdsByPath.get(ptPath) ?? {}
    for (const r of rows) {
      const sid = ids[r.key]
      if (typeof sid !== 'number') {
        droppedNormal++
        continue
      }
      resolvedRows.push({ ptPath, key: r.key, stringId: sid, translation: r.translation, stage: r.stage })
    }
  }

  const perFileUpdates = new Map<string, Map<string, { translation: string, stage: number }>>()

  const normalTasks = resolvedRows.map(r => async () => {
    await postOneTranslation(r.stringId, r.translation, r.stage)
    let m = perFileUpdates.get(r.ptPath)
    if (!m) {
      m = new Map()
      perFileUpdates.set(r.ptPath, m)
    }
    m.set(r.key, { translation: r.translation, stage: r.stage })
  })

  const normalRes = await runBounded(normalTasks, CONCURRENCY)
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
    const lastrun = await readZhLastrun(ptPath) ?? []
    const lastrunByKey = new Map<string, PtStringItem>(lastrun.map(i => [i.key, i]))

    for (const [key, { newOriginal }] of Object.entries(perFile)) {
      const sid = ids[key]
      if (typeof sid !== 'number') {
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
      staleRows.push({ ptPath, key, stringId: sid, translation: marker, stage: 0, pendingKey: key })
    }
  }

  const staleTasks = staleRows.map(r => async () => {
    await postOneTranslation(r.stringId, r.translation, r.stage)
    let m = perFileUpdates.get(r.ptPath)
    if (!m) {
      m = new Map()
      perFileUpdates.set(r.ptPath, m)
    }
    m.set(r.key, { translation: r.translation, stage: r.stage })
  })
  const staleRes = await runBounded(staleTasks, CONCURRENCY)
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
