/**
 * Step 2 — diff-en.
 *
 * Compare each file in `.build/en/` against the matching `en-lastrun/` copy
 * from the previous run and classify per-key changes. Emits two cache files:
 *
 *   - changed-en.json    list of pt-paths whose upload content changed in any
 *                        way (new key, updated key, deleted key, or whole-
 *                        file add/remove). push-en replaces each listed file
 *                        wholesale on PT 18818, so the classification here is
 *                        only "dirty vs clean" at the file level.
 *
 *   - pending-update.json per-entry record of *updated English* strings —
 *                        keys whose `original` changed vs. last run. The zh
 *                        side uses this later: if 4964 already has a new
 *                        translation we clear the entry, otherwise push-zh
 *                        emits a `"{new}|旧译|{old}"` stale marker so
 *                        translators notice.
 *
 * Newly-added keys do NOT get a pending-update entry (no prior translation
 * exists to mark stale). Deleted keys also don't — the file-level replace on
 * PT will drop them naturally.
 */

import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile } from 'node:fs/promises'
import { dirname, join, relative, sep } from 'node:path'

import { BUILD_DIR, CACHE_DIR, CACHE_PATHS } from './lib/config.ts'
import {
  readJson,
  writePendingUpdate,
  writeJson,
  type PendingUpdateEntry,
} from './lib/cache.ts'
import type { PtStringItem } from './lib/lang-parser.ts'

function toPosix(p: string): string {
  return p.split(sep).join('/')
}

async function* walkJson(dir: string): AsyncGenerator<string> {
  let ents
  try {
    ents = await readdir(dir, { withFileTypes: true, encoding: 'utf8' })
  }
  catch {
    return
  }
  for (const e of ents) {
    const p = join(dir, e.name)
    if (e.isDirectory())
      yield* walkJson(p)
    else if (e.isFile() && e.name.endsWith('.en.json'))
      yield p
  }
}

async function loadItems(absPath: string): Promise<PtStringItem[] | undefined> {
  if (!existsSync(absPath))
    return undefined
  return JSON.parse(await readFile(absPath, 'utf8')) as PtStringItem[]
}

interface FileDiff {
  ptPath: string
  dirty: boolean
  /** key → { oldOriginal, newOriginal } for *updated* entries only. */
  updated: Record<string, PendingUpdateEntry>
}

function diffOne(
  ptPath: string,
  curr: PtStringItem[] | undefined,
  prev: PtStringItem[] | undefined,
): FileDiff {
  if (curr && !prev)
    return { ptPath, dirty: true, updated: {} } // whole file new
  if (!curr && prev)
    return { ptPath, dirty: true, updated: {} } // whole file gone
  if (!curr && !prev)
    return { ptPath, dirty: false, updated: {} }

  const prevMap = new Map(prev!.map(i => [i.key, i.original]))
  const currMap = new Map(curr!.map(i => [i.key, i.original]))
  const updated: Record<string, PendingUpdateEntry> = {}
  let dirty = false

  for (const [key, newOriginal] of currMap) {
    const oldOriginal = prevMap.get(key)
    if (oldOriginal === undefined) {
      dirty = true // new key
    }
    else if (oldOriginal !== newOriginal) {
      dirty = true
      updated[key] = { oldOriginal, newOriginal }
    }
  }
  for (const key of prevMap.keys()) {
    if (!currMap.has(key)) {
      dirty = true // deleted key
    }
  }
  return { ptPath, dirty, updated }
}

async function main(): Promise<void> {
  const buildRoot = join(BUILD_DIR, 'en')
  const lastrunRoot = join(CACHE_DIR, CACHE_PATHS.enLastrun)

  // Build the universe of pt-paths = (files in .build/en) ∪ (files in en-lastrun).
  const ptPaths = new Set<string>()
  for await (const abs of walkJson(buildRoot))
    ptPaths.add(toPosix(relative(buildRoot, abs)).replace(/\.en\.json$/, ''))
  for await (const abs of walkJson(lastrunRoot))
    ptPaths.add(toPosix(relative(lastrunRoot, abs)).replace(/\.en\.json$/, ''))

  const changed: string[] = []
  const pending: Record<string, Record<string, PendingUpdateEntry>> = {}

  for (const ptPath of [...ptPaths].sort()) {
    const curr = await loadItems(join(buildRoot, `${ptPath}.en.json`))
    const prev = await loadItems(join(lastrunRoot, `${ptPath}.en.json`))
    const diff = diffOne(ptPath, curr, prev)
    if (diff.dirty)
      changed.push(ptPath)
    if (Object.keys(diff.updated).length > 0)
      pending[ptPath] = diff.updated
  }

  await mkdir(dirname(join(CACHE_DIR, CACHE_PATHS.changedEn)), { recursive: true })
  await writeJson(join(CACHE_DIR, CACHE_PATHS.changedEn), changed)

  // Merge into existing pending-update rather than overwriting: a pending
  // entry from an earlier run that hasn't been cleared by diff-zh yet must
  // survive until push-zh sees it. But a key that just got re-updated needs
  // its newOriginal refreshed — which the merge does key-by-key.
  const existingPending = (await readJson<Record<string, Record<string, PendingUpdateEntry>>>(
    join(CACHE_DIR, CACHE_PATHS.pendingUpdate),
  )) ?? {}
  for (const [ptPath, perFile] of Object.entries(pending)) {
    existingPending[ptPath] = { ...existingPending[ptPath], ...perFile }
  }
  // Prune pt-paths that no longer exist upstream (whole-file delete).
  for (const ptPath of Object.keys(existingPending)) {
    if (!existsSync(join(buildRoot, `${ptPath}.en.json`)))
      delete existingPending[ptPath]
  }
  await writePendingUpdate(existingPending)

  // eslint-disable-next-line no-console
  console.log(`[diff-en] changed=${changed.length} pending-keys=${Object.values(pending).reduce((n, m) => n + Object.keys(m).length, 0)}`)
  if (changed.length > 0 && changed.length <= 20)
    // eslint-disable-next-line no-console
    console.log(`[diff-en] files:\n  ${changed.join('\n  ')}`)
}

void main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[diff-en] failed:', err)
  process.exit(1)
})
