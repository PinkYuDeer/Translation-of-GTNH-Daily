/**
 * Step 4 — merge-final.
 *
 * Build the authoritative final PT-file contents locally from three sources:
 *
 *   1. `.build/en/`         — latest English source of truth
 *   2. `.build/zh-current/` — current PT 18818 state ("our PT")
 *   3. `.build/zh-4964/`    — upstream reviewed Chinese source
 *
 * Merge rules:
 *   - English key/original set is authoritative for the normal daily keyspace.
 *   - Current PT 18818 translations are preserved when key+original still match.
 *   - If English changed and 4964 has no fresh exact match, emit a stale marker
 *     `${newEnglish}|旧译：|${oldTranslation}` at stage=0.
 *   - If 4964 has a non-blank fresh exact match, it fills current PT gaps.
 *     When both 18818 and 4964 already have different exact translations, query
 *     row timestamps; 4964 wins if it is newer or timestamps are unavailable.
 *   - If 4964 has a translated key but with older English, it also becomes a stale
 *     marker, overriding current PT's older translation payload.
 *   - 4964 rows/files without an English counterpart are ignored. The upstream
 *     PT project is a translation source only, never an English key source.
 *   - Final rows whose translation is blank after trim stay blank at stage=0.
 *
 * Outputs:
 *   - `.build/zh-final/<pt-path>.json` — final PT-shaped files
 *   - `.build/merge-plan.json`         — which files/strings need upload / archive
 */

import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join, relative, sep } from 'node:path'

import { BUILD_DIR, PT_18818_ID, PT_4964_ID, assertToken } from './lib/config.ts'
import { readFileIds, writeJson } from './lib/cache.ts'
import type { PtStringItem } from './lib/lang-parser.ts'
import { normalizeNewlines, normalizePtNewlines } from './lib/newlines.ts'
import {
  indexFilesByLowerName,
  listFileStrings,
  listProjectFiles,
  type PtStringRow,
} from './lib/pt-client.ts'
import {
  indexByModId,
  resolve4964To18818,
  toPtJsonPath,
} from './lib/path-map.ts'

interface MergePlan {
  push: string[]
  archive: string[]
  archiveStrings: Record<string, string[]>
  /**
   * Backward-compatible diagnostic list. push-final now imports translation
   * deltas through POST /files/{fileId}/translation instead of per-string PUTs.
   */
  overrideTranslations: string[]
}

interface CurrentPtFile {
  raw: PtStringItem[]
  normalized: PtStringItem[]
}

interface DriftEntry {
  translation: string
}

interface MergeStats {
  files: number
  filesChanged: number
  filesCreated: number
  filesArchived: number
  stringsArchived: number
  currentPreserved: number
  sourceApplied: number
  sourceAppliedByRemoteTime: number
  sourceAppliedNoRemoteTime: number
  sourceSkippedByCurrent: number
  remoteTimeChecks: number
  staleFromCurrent: number
  staleFrom4964: number
  unresolved4964: number
  blankTranslations: number
  originalFallbacksPreserved: number
}

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

async function loadPtItems(abs: string): Promise<PtStringItem[]> {
  const data: unknown = JSON.parse(await readFile(abs, 'utf8'))
  if (Array.isArray(data))
    return data as PtStringItem[]
  const results = (data as { results?: PtStringItem[] }).results
  return Array.isArray(results) ? results : []
}

function normalizeItem(item: PtStringItem): PtStringItem {
  return {
    ...(item.id != null ? { id: item.id } : {}),
    key: item.key,
    original: normalizePtNewlines(item.original ?? ''),
    translation: normalizePtNewlines(item.translation ?? ''),
    stage: item.stage ?? 0,
    ...(item.createdAt != null ? { createdAt: item.createdAt } : {}),
    ...(item.updatedAt != null ? { updatedAt: item.updatedAt } : {}),
    ...(item.uid != null ? { uid: item.uid } : {}),
    ...(item.context != null && item.context !== '' ? { context: item.context } : {}),
  }
}

function hasLegacyPlaceholder(items: PtStringItem[] | undefined): boolean {
  return (items ?? []).some(item =>
    (item.original ?? '').includes('<BR>')
    || (item.original ?? '').includes('<br>')
    || (item.original ?? '').includes('\\\\n')
    || (item.original ?? '').includes('\\n')
    || (item.original ?? '').includes('%n')
    || (item.translation ?? '').includes('<BR>')
    || (item.translation ?? '').includes('<br>')
    || (item.translation ?? '').includes('\\\\n')
    || (item.translation ?? '').includes('\\n')
    || (item.translation ?? '').includes('%n')
  )
}

function itemsEqual(a: PtStringItem[] | undefined, b: PtStringItem[]): boolean {
  const aa = (a ?? []).map(normalizeItem)
  const bb = b.map(normalizeItem)
  if (aa.length !== bb.length)
    return false
  for (let i = 0; i < aa.length; i++) {
    const x = aa[i]
    const y = bb[i]
    if (
      x.key !== y.key
      || x.original !== y.original
      || x.translation !== y.translation
      || x.stage !== y.stage
      || (x.context ?? '') !== (y.context ?? '')
    ) {
      return false
    }
  }
  return true
}

function staleMarker(newOriginal: string, oldTranslation: string): string {
  return `${normalizeNewlines(newOriginal)}|旧译：|${normalizeNewlines(oldTranslation)}`
}

function hasText(value: string | undefined): value is string {
  return (value ?? '').trim().length > 0
}

function normalize4964Key(key: string): string {
  return key.replace(/^(?:gt-)?lang\|/, '').trim()
}

function timestampMs(item: PtStringItem | undefined): number | undefined {
  const raw = item?.updatedAt ?? item?.createdAt
  if (!raw)
    return undefined
  const ms = Date.parse(raw)
  return Number.isFinite(ms) ? ms : undefined
}

function rowToItem(row: PtStringRow, normalizeKey: (key: string) => string): PtStringItem {
  return normalizeItem({
    id: row.id,
    key: normalizeKey(row.key),
    original: row.original,
    translation: row.translation ?? '',
    stage: row.stage ?? 0,
    ...(row.createdAt != null ? { createdAt: row.createdAt } : {}),
    ...(row.updatedAt != null ? { updatedAt: row.updatedAt } : {}),
    ...(row.uid != null ? { uid: row.uid } : {}),
    ...(row.context != null ? { context: row.context } : {}),
  })
}

function findRemoteExact(items: PtStringItem[], key: string, original: string): PtStringItem | undefined {
  return items.find(item => item.key === key && item.original === original)
}

type RemoteTimeDecision = 'source-newer' | 'current-newer-or-equal' | 'missing-time'

class RemoteTimestampResolver {
  remoteTimeChecks = 0

  private tokenAsserted = false
  private currentFileIds: Record<string, number> | undefined
  private currentRemoteFiles: Promise<Map<string, { id: number, name: string }>> | undefined
  private sourceRemoteFiles: Promise<Map<string, { id: number, name: string }>> | undefined
  private currentStrings = new Map<string, Promise<PtStringItem[]>>()
  private sourceStrings = new Map<string, Promise<PtStringItem[]>>()

  async compare(
    ptPath: string,
    sourceName: string | undefined,
    key: string,
    original: string,
    current: PtStringItem,
    source: PtStringItem,
  ): Promise<RemoteTimeDecision> {
    this.remoteTimeChecks++
    const [remoteCurrent, remoteSource] = await Promise.all([
      this.currentItem(ptPath, key, original),
      sourceName != null ? this.sourceItem(sourceName, key, original) : Promise.resolve(undefined),
    ])
    const currentForTime = remoteCurrent ?? current
    const sourceForTime = remoteSource ?? source
    const currentMs = timestampMs(currentForTime)
    const sourceMs = timestampMs(sourceForTime)
    if (currentMs == null || sourceMs == null)
      return 'missing-time'
    return sourceMs > currentMs ? 'source-newer' : 'current-newer-or-equal'
  }

  private assertTokenOnce(): void {
    if (this.tokenAsserted)
      return
    assertToken()
    this.tokenAsserted = true
  }

  private async currentFileId(ptPath: string): Promise<number | undefined> {
    this.currentFileIds ??= await readFileIds()
    const cached = this.currentFileIds[ptPath]
    if (typeof cached === 'number')
      return cached
    const files = await this.currentFiles()
    return files.get(toPtJsonPath(ptPath).toLowerCase())?.id
  }

  private async sourceFileId(sourceName: string): Promise<number | undefined> {
    const files = await this.sourceFiles()
    return files.get(sourceName.toLowerCase())?.id
      ?? files.get(toPtJsonPath(sourceName).toLowerCase())?.id
  }

  private async currentFiles(): Promise<Map<string, { id: number, name: string }>> {
    this.assertTokenOnce()
    this.currentRemoteFiles ??= listProjectFiles(PT_18818_ID)
      .then(files => indexFilesByLowerName(files))
    return this.currentRemoteFiles
  }

  private async sourceFiles(): Promise<Map<string, { id: number, name: string }>> {
    this.assertTokenOnce()
    this.sourceRemoteFiles ??= listProjectFiles(PT_4964_ID)
      .then(files => indexFilesByLowerName(files))
    return this.sourceRemoteFiles
  }

  private async currentItem(ptPath: string, key: string, original: string): Promise<PtStringItem | undefined> {
    const items = await this.currentFileStrings(ptPath)
    return findRemoteExact(items, key, original)
  }

  private async sourceItem(sourceName: string, key: string, original: string): Promise<PtStringItem | undefined> {
    const items = await this.sourceFileStrings(sourceName)
    return findRemoteExact(items, key, original)
  }

  private currentFileStrings(ptPath: string): Promise<PtStringItem[]> {
    const cached = this.currentStrings.get(ptPath)
    if (cached)
      return cached
    const promise = this.currentFileId(ptPath).then(async (fileId) => {
      if (fileId == null)
        return []
      this.assertTokenOnce()
      const rows = await listFileStrings(PT_18818_ID, fileId)
      return rows.map(row => rowToItem(row, key => key))
    })
    this.currentStrings.set(ptPath, promise)
    return promise
  }

  private sourceFileStrings(sourceName: string): Promise<PtStringItem[]> {
    const cached = this.sourceStrings.get(sourceName)
    if (cached)
      return cached
    const promise = this.sourceFileId(sourceName).then(async (fileId) => {
      if (fileId == null)
        return []
      this.assertTokenOnce()
      const rows = await listFileStrings(PT_4964_ID, fileId)
      return rows.map(row => rowToItem(row, normalize4964Key))
    })
    this.sourceStrings.set(sourceName, promise)
    return promise
  }
}

function needsTranslationOverride(
  currentItems: PtStringItem[],
  finalItems: PtStringItem[],
): boolean {
  const currentByKey = new Map(currentItems.map(item => [item.key, item]))
  return finalItems.some((item) => {
    const current = currentByKey.get(item.key)
    if (current == null)
      return item.translation.length > 0 || (item.stage ?? 0) > 0
    return current.translation !== item.translation
      || (current.stage ?? 0) !== (item.stage ?? 0)
  })
}

async function main(): Promise<void> {
  const enRoot = join(BUILD_DIR, 'en')
  const currentRoot = join(BUILD_DIR, 'zh-current')
  const sourceRoot = join(BUILD_DIR, 'zh-4964')
  const finalRoot = join(BUILD_DIR, 'zh-final')
  const mergePlanPath = join(BUILD_DIR, 'merge-plan.json')
  const mergeStatsPath = join(BUILD_DIR, 'merge-stats.json')
  const force = (process.env.FORCE ?? '').length > 0

  const enFiles = new Map<string, PtStringItem[]>()
  let emptyEnFilesSkipped = 0
  for await (const abs of walkJson(enRoot)) {
    const rel = toPosix(relative(enRoot, abs))
    const ptPath = rel.endsWith('.en.json') ? rel.slice(0, -'.en.json'.length) : rel
    const items = (await loadPtItems(abs)).map(normalizeItem)
    if (items.length === 0) {
      emptyEnFilesSkipped++
      continue
    }
    enFiles.set(ptPath, items)
  }

  const currentFiles = new Map<string, CurrentPtFile>()
  for await (const abs of walkJson(currentRoot)) {
    const rel = toPosix(relative(currentRoot, abs))
    const ptPath = rel.endsWith('.json') ? rel.slice(0, -'.json'.length) : rel
    const raw = await loadPtItems(abs)
    currentFiles.set(ptPath, {
      raw,
      normalized: raw.map(normalizeItem),
    })
  }

  const targetEntries = [...enFiles.keys()].map(ptPath => ({ name: `${ptPath}.json` }))
  const targetByName = new Map(targetEntries.map(entry => [entry.name, entry]))
  const targetByModId = indexByModId(targetEntries)

  const sourceFiles = new Map<string, PtStringItem[]>()
  const sourceOrigins = new Map<string, Map<string, string>>()
  const duplicateExamples: string[] = []
  let unresolved4964 = 0

  // Multiple 4964 source files can resolve to the same 18818 ptPath — typically
  // a canonical `config/txloader/forceload/Foo[foo]/...` co-existing with a
  // legacy `resources/Foo[foo]/...` that 4964 still maintains. Earlier this
  // step kept the first one and dropped the rest, silently losing every key
  // unique to the dropped file. Now we merge: the first-encountered file's
  // entries win on key conflicts, and later files contribute any keys the
  // first one is missing.
  for await (const abs of walkJson(sourceRoot)) {
    const sourceName = toPosix(relative(sourceRoot, abs))
    const resolved = resolve4964To18818(sourceName, targetByName, targetByModId)
    if (!resolved) {
      unresolved4964++
      continue
    }
    const ptPath = resolved.name.slice(0, -'.json'.length)
    const incoming = (await loadPtItems(abs)).map(normalizeItem)
    const existing = sourceFiles.get(ptPath)
    const origins = sourceOrigins.get(ptPath) ?? new Map<string, string>()
    if (existing == null) {
      sourceFiles.set(ptPath, incoming)
      for (const item of incoming)
        origins.set(item.key, sourceName)
      sourceOrigins.set(ptPath, origins)
      continue
    }
    const byKey = new Map(existing.map(item => [item.key, item]))
    let added = 0
    for (const item of incoming) {
      if (!byKey.has(item.key)) {
        byKey.set(item.key, item)
        origins.set(item.key, sourceName)
        added++
      }
    }
    sourceFiles.set(ptPath, [...byKey.values()])
    sourceOrigins.set(ptPath, origins)
    if (duplicateExamples.length < 10)
      duplicateExamples.push(`${sourceName} -> ${ptPath} (+${added} keys)`)
  }

  await rm(finalRoot, { recursive: true, force: true })
  await mkdir(finalRoot, { recursive: true })

  const plan: MergePlan = { push: [], archive: [], archiveStrings: {}, overrideTranslations: [] }
  const stats: MergeStats = {
    files: enFiles.size,
    filesChanged: 0,
    filesCreated: 0,
    filesArchived: 0,
    stringsArchived: 0,
    currentPreserved: 0,
    sourceApplied: 0,
    sourceAppliedByRemoteTime: 0,
    sourceAppliedNoRemoteTime: 0,
    sourceSkippedByCurrent: 0,
    remoteTimeChecks: 0,
    staleFromCurrent: 0,
    staleFrom4964: 0,
    unresolved4964,
    blankTranslations: 0,
    originalFallbacksPreserved: 0,
  }
  const remoteTimestamps = new RemoteTimestampResolver()

  for (const [ptPath, enItems] of enFiles) {
    const currentFile = currentFiles.get(ptPath)
    const currentItems = currentFile?.normalized ?? []
    const sourceItems = sourceFiles.get(ptPath) ?? []
    const sourceOriginByKey = sourceOrigins.get(ptPath) ?? new Map<string, string>()
    const hasReviewedSource = sourceItems.some(item => (item.stage ?? 0) > 0)

    const currentByKey = new Map(currentItems.map(item => [item.key, item]))
    const sourceByKey = new Map(sourceItems.map(item => [item.key, item]))
    const enByKey = new Set(enItems.map(item => item.key))
    const currentDrift = new Map<string, DriftEntry>()
    const finalItems: PtStringItem[] = []

    for (const enItem of enItems) {
      const current = currentByKey.get(enItem.key)
      const source = sourceByKey.get(enItem.key)

      let translation = ''
      let stage = 0
      const context = current?.context ?? enItem.context
      const hasCurrentExactTranslation = current?.original === enItem.original && !!current.translation
      const sourceHasTranslation = hasText(source?.translation)
      const sourceExact = source?.original === enItem.original
      const currentExact = current?.original === enItem.original
      let handledBySource = false

      if (current && currentExact) {
        translation = current.translation
        stage = current.stage ?? 0
        if (translation)
          stats.currentPreserved++
      }
      else if (current?.translation) {
        currentDrift.set(enItem.key, { translation: current.translation })
      }

      if (
        current != null
        && currentExact
        && current.translation === enItem.original
        && (current.stage ?? 0) > 0
        && source != null
        && sourceExact
        && !sourceHasTranslation
      ) {
        stats.originalFallbacksPreserved++
      }

      if (source && sourceHasTranslation) {
        if (sourceExact) {
          const sourceConflictsWithCurrent = currentExact
            && hasText(current?.translation)
            && current.translation !== source.translation
          const remoteDecision = sourceConflictsWithCurrent
            ? await remoteTimestamps.compare(
                ptPath,
                sourceOriginByKey.get(enItem.key),
                enItem.key,
                enItem.original,
                current,
                source,
              )
            : undefined
          const useSource = !sourceConflictsWithCurrent
            || remoteDecision === 'source-newer'
            || remoteDecision === 'missing-time'
          if (useSource) {
            translation = source.translation
            stage = source.stage ?? 0
            currentDrift.delete(enItem.key)
            stats.sourceApplied++
            if (remoteDecision === 'source-newer')
              stats.sourceAppliedByRemoteTime++
            else if (remoteDecision === 'missing-time')
              stats.sourceAppliedNoRemoteTime++
            handledBySource = true
          }
          else {
            stats.sourceSkippedByCurrent++
          }
        }
        else if ((source.stage ?? 0) > 0 && !hasCurrentExactTranslation) {
          translation = staleMarker(enItem.original, source.translation)
          stage = 0
          currentDrift.delete(enItem.key)
          stats.staleFrom4964++
          handledBySource = true
        }
      }

      if (!handledBySource) {
        const drift = currentDrift.get(enItem.key)
        if (drift) {
          translation = staleMarker(enItem.original, drift.translation)
          stage = 0
          stats.staleFromCurrent++
        }
      }

      if (!hasText(translation)) {
        translation = ''
        stage = 0
        stats.blankTranslations++
      }
      finalItems.push({
        key: enItem.key,
        original: enItem.original,
        translation,
        stage,
        ...(context != null && context !== '' ? { context } : {}),
      })
    }

    const out = join(finalRoot, `${ptPath}.json`)
    await mkdir(dirname(out), { recursive: true })
    await writeJson(out, finalItems)

    const existed = currentFile != null
    const removedKeys = currentItems
      .filter(item => !enByKey.has(item.key))
      .map(item => item.key)
    if (removedKeys.length > 0) {
      plan.archiveStrings[ptPath] = removedKeys
      stats.stringsArchived += removedKeys.length
    }
    const legacyPlaceholderRewrite = hasLegacyPlaceholder(currentFile?.raw)
    if (!existed)
      stats.filesCreated++
    if (force || !itemsEqual(currentItems, finalItems) || legacyPlaceholderRewrite) {
      plan.push.push(ptPath)
      stats.filesChanged++
      if (
        existed
        && (force || legacyPlaceholderRewrite || hasReviewedSource || needsTranslationOverride(currentItems, finalItems))
      )
        plan.overrideTranslations.push(ptPath)
    }
  }

  for (const ptPath of currentFiles.keys()) {
    if (enFiles.has(ptPath))
      continue
    plan.archive.push(ptPath)
    stats.filesArchived++
  }

  stats.files = enFiles.size
  stats.remoteTimeChecks = remoteTimestamps.remoteTimeChecks

  await writeFile(mergeStatsPath, `${JSON.stringify(stats, null, 2)}\n`, 'utf8')
  await writeJson(mergePlanPath, plan)

  if (force)
    // eslint-disable-next-line no-console
    console.log('[merge-final] FORCE mode: every merged file will be re-uploaded to PT 18818')
  if (emptyEnFilesSkipped > 0)
    // eslint-disable-next-line no-console
    console.log(`[merge-final] skipped ${emptyEnFilesSkipped} empty English file(s); existing PT copies will be archived`)

  // eslint-disable-next-line no-console
  console.log(
    `[merge-final] files=${stats.files} push=${plan.push.length} archive=${plan.archive.length} `
    + `override=${plan.overrideTranslations.length} `
    + `created=${stats.filesCreated} preserved=${stats.currentPreserved} source-applied=${stats.sourceApplied} `
    + `source-applied-by-time=${stats.sourceAppliedByRemoteTime} `
    + `source-applied-no-time=${stats.sourceAppliedNoRemoteTime} `
    + `source-skipped-current=${stats.sourceSkippedByCurrent} `
    + `remote-time-checks=${stats.remoteTimeChecks} `
    + `stale-current=${stats.staleFromCurrent} stale-4964=${stats.staleFrom4964} `
    + `blank=${stats.blankTranslations} archived-strings=${stats.stringsArchived} `
    + `preserved-original-equals-translation=${stats.originalFallbacksPreserved} `
    + `unresolved-4964=${stats.unresolved4964}`,
  )
  if (duplicateExamples.length > 0)
    // eslint-disable-next-line no-console
    console.warn(`[merge-final] duplicate 4964 mappings merged: ${duplicateExamples.join(', ')}`)
}

void main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[merge-final] failed:', err)
  process.exit(1)
})
