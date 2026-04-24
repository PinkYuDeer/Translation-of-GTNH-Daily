/**
 * Step 5 — diff-zh.
 *
 * Compare PT-4964 translations against the last snapshot we pushed to 18818
 * (`zh-lastrun/`) and emit a push queue of only the rows that actually need
 * updating. Also cleans `pending-update.json`: if the 4964 side already has a
 * fresh translation for an English-updated key, we drop it from pending (so
 * push-zh won't emit a stale marker for it).
 *
 * Skip rules for a 4964 row `s`:
 *   1. s.stage < 1                           untranslated / rejected
 *   2. s.translation empty                   no content
 *   3. normalize(s.original) != new EN       4964 is still on the old English
 *                                            (translation was written against
 *                                            a now-obsolete string; can't use)
 *   4. (normalized) s.translation + s.stage  already pushed, no-op
 *      equal lastrun
 *
 * `files-to-refresh-ids.json` collects every pt-path that push-zh will touch:
 *   - every file with an entry in the push queue
 *   - every file with a leftover pending-update entry (push-zh emits stale
 *     markers for these, which also need stringIds)
 */

import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile } from 'node:fs/promises'
import { dirname, join, relative, sep } from 'node:path'

import { BUILD_DIR, CACHE_DIR, CACHE_PATHS } from './lib/config.ts'
import {
  readFileIds,
  readJson,
  writeJson,
  writePendingUpdate,
  type PendingUpdateEntry,
} from './lib/cache.ts'
import { indexByModId, isArchivedPtPath, resolve4964To18818 } from './lib/path-map.ts'
import { normalizeNewlines } from './lib/newlines.ts'
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
    else if (e.isFile() && e.name.endsWith('.json'))
      yield p
  }
}

interface PushEntry {
  ptPath: string
  key: string
  translation: string
  stage: number
}

async function loadItems(absPath: string): Promise<PtStringItem[] | undefined> {
  if (!existsSync(absPath))
    return undefined
  return JSON.parse(await readFile(absPath, 'utf8')) as PtStringItem[]
}

async function main(): Promise<void> {
  const root4964 = join(BUILD_DIR, 'zh-4964')
  const rootEn = join(BUILD_DIR, 'en')
  const rootLastrun = join(CACHE_DIR, CACHE_PATHS.zhLastrun)

  // Build an index of 18818's known files so we can resolve 4964 paths that
  // use the bare-modid convention to 18818's `<Display>[<modid>]` form.
  const fileIds = await readFileIds()
  const fileEntries: { name: string }[] = Object.keys(fileIds)
    .filter(ptPath => !isArchivedPtPath(ptPath))
    .map(ptPath => ({
      // Index on PT's canonical form — `name` always includes `.json`.
      name: ptPath.endsWith('.json') ? ptPath : `${ptPath}.json`,
    }))
  const targetByName = new Map(fileEntries.map(f => [f.name, f]))
  const targetByModId = indexByModId(fileEntries)

  const pending = (await readJson<Record<string, Record<string, PendingUpdateEntry>>>(
    join(CACHE_DIR, CACHE_PATHS.pendingUpdate),
  )) ?? {}

  const pushQueue: PushEntry[] = []
  const touched = new Set<string>()
  let unresolved = 0
  const unresolvedNames: string[] = []

  for await (const abs of walkJson(root4964)) {
    // 4964-side name exactly as PT stores it (ends with .json).
    const source4964Name = toPosix(relative(root4964, abs))
    const resolved = resolve4964To18818(source4964Name, targetByName, targetByModId)
    if (!resolved) {
      // No matching 18818 file — this is common for upstream-only 4964 content
      // (glossary files etc.) and safe to skip silently at info level.
      unresolved++
      if (unresolvedNames.length < 10)
        unresolvedNames.push(source4964Name)
      continue
    }
    // Strip the `.json` suffix to get our internal pt-path.
    const ptPath = resolved.name.endsWith('.json') ? resolved.name.slice(0, -'.json'.length) : resolved.name

    const [curr4964, enItems, lastrun] = await Promise.all([
      loadItems(abs) as Promise<PtStringItem[]>,
      loadItems(join(rootEn, `${ptPath}.en.json`)),
      loadItems(join(rootLastrun, `${ptPath}.zh.json`)),
    ])
    if (!enItems) {
      // We only push into files that also exist on our English side; if the
      // en file doesn't exist we have nothing to align against.
      continue
    }

    const enByKey = new Map(enItems.map(i => [i.key, i]))
    const lastrunByKey = new Map((lastrun ?? []).map(i => [i.key, i]))
    const pendingForFile = pending[ptPath] ?? {}

    for (const s of curr4964) {
      if ((s.stage ?? 0) < 1)
        continue
      if (!s.translation)
        continue
      const enRow = enByKey.get(s.key)
      if (!enRow)
        continue
      if (normalizeNewlines(s.original) !== normalizeNewlines(enRow.original))
        continue

      // The 4964 row covers this key's current English → clear any stale-
      // marker intent we might have queued from diff-en.
      if (pendingForFile[s.key] != null)
        delete pendingForFile[s.key]

      const normalized = normalizeNewlines(s.translation)
      const prev = lastrunByKey.get(s.key)
      if (
        prev
        && normalizeNewlines(prev.translation ?? '') === normalized
        && (prev.stage ?? 0) === (s.stage ?? 0)
      )
        continue

      pushQueue.push({ ptPath, key: s.key, translation: normalized, stage: s.stage })
      touched.add(ptPath)
    }

    if (Object.keys(pendingForFile).length === 0)
      delete pending[ptPath]
    else
      pending[ptPath] = pendingForFile
  }

  // Any remaining pending-update file also needs stringIds (for the stale
  // marker push in step 6).
  for (const ptPath of Object.keys(pending))
    touched.add(ptPath)

  await mkdir(dirname(join(CACHE_DIR, CACHE_PATHS.pushQueue)), { recursive: true })
  await writeJson(join(CACHE_DIR, CACHE_PATHS.pushQueue), pushQueue)
  await writeJson(join(CACHE_DIR, CACHE_PATHS.filesToRefresh), [...touched])
  await writePendingUpdate(pending)

  // eslint-disable-next-line no-console
  console.log(
    `[diff-zh] push-queue=${pushQueue.length} touched-files=${touched.size} pending-keys=${
      Object.values(pending).reduce((n, m) => n + Object.keys(m).length, 0)
    } unresolved-4964=${unresolved}`,
  )
  if (unresolvedNames.length > 0)
    // eslint-disable-next-line no-console
    console.warn(`[diff-zh] unresolved examples: ${unresolvedNames.join(', ')}`)
}

void main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[diff-zh] failed:', err)
  process.exit(1)
})
