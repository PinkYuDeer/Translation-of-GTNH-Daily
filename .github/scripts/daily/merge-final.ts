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
 *     However, reviewed 4964 rows/files that still have no English counterpart
 *     are preserved as source-only entries instead of being dropped.
 *   - Current PT 18818 translations are preserved when key+original still match.
 *   - If English changed and 4964 has no fresh exact match, emit a stale marker
 *     `${newEnglish}|旧译：|${oldTranslation}` at stage=0.
 *   - If 4964 has a fresh exact match, it overrides current PT.
 *   - If 4964 has the key but with older English, it also becomes a stale
 *     marker, overriding current PT's older translation payload.
 *
 * Outputs:
 *   - `.build/zh-final/<pt-path>.json` — final PT-shaped files
 *   - `.build/merge-plan.json`         — which files need upload / archive
 */

import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join, relative, sep } from 'node:path'

import { BUILD_DIR } from './lib/config.ts'
import { writeJson } from './lib/cache.ts'
import type { PtStringItem } from './lib/lang-parser.ts'
import { normalizeNewlines, normalizePtNewlines } from './lib/newlines.ts'
import {
  indexByModId,
  isArchivedPtPath,
  map4964PathTo18818,
  resolve4964To18818,
} from './lib/path-map.ts'

interface MergePlan {
  push: string[]
  archive: string[]
  /**
   * Subset of `push`: files whose existing translations on PT 18818 must also
   * be overwritten per-string after the file-level POST, because PT does not
   * update existing translations through the file upload endpoint. Populated
   * when force mode is on or the current PT file still contains legacy newline
   * placeholders (`<BR>`, `<br>`, literal `\n`, `%n`).
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
  sourceOnlyFiles: number
  sourceOnlyKeys: number
  currentPreserved: number
  sourceApplied: number
  staleFromCurrent: number
  staleFrom4964: number
  unresolved4964: number
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
    key: item.key,
    original: normalizePtNewlines(item.original ?? ''),
    translation: normalizePtNewlines(item.translation ?? ''),
    stage: item.stage ?? 0,
    ...(item.context != null && item.context !== '' ? { context: item.context } : {}),
  }
}

function hasLegacyPlaceholder(items: PtStringItem[] | undefined): boolean {
  return (items ?? []).some(item =>
    (item.original ?? '').includes('<BR>')
    || (item.original ?? '').includes('<br>')
    || (item.original ?? '').includes('\\n')
    || (item.original ?? '').includes('%n')
    || (item.translation ?? '').includes('<BR>')
    || (item.translation ?? '').includes('<br>')
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

function mergeSourceOnlyItem(
  sourceItem: PtStringItem,
  current: PtStringItem | undefined,
): PtStringItem {
  const keepCurrent = current?.original === sourceItem.original && !!current.translation && !sourceItem.translation
  // Upstream 4964 context never carries into 18818 — only preserve context that
  // 18818 already had for this key.
  const context = current?.context
  return {
    key: sourceItem.key,
    original: sourceItem.original,
    translation: keepCurrent ? current.translation : sourceItem.translation,
    stage: keepCurrent
      ? (current.stage ?? 0)
      : (sourceItem.translation ? Math.max(sourceItem.stage ?? 0, 1) : (sourceItem.stage ?? 0)),
    ...(context != null && context !== '' ? { context } : {}),
  }
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
  for await (const abs of walkJson(enRoot)) {
    const rel = toPosix(relative(enRoot, abs))
    const ptPath = rel.endsWith('.en.json') ? rel.slice(0, -'.en.json'.length) : rel
    enFiles.set(ptPath, (await loadPtItems(abs)).map(normalizeItem))
  }

  const currentFiles = new Map<string, CurrentPtFile>()
  for await (const abs of walkJson(currentRoot)) {
    const rel = toPosix(relative(currentRoot, abs))
    const ptPath = rel.endsWith('.json') ? rel.slice(0, -'.json'.length) : rel
    if (isArchivedPtPath(ptPath))
      continue
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
  const duplicateExamples: string[] = []

  for await (const abs of walkJson(sourceRoot)) {
    const sourceName = toPosix(relative(sourceRoot, abs))
    const resolved = resolve4964To18818(sourceName, targetByName, targetByModId)
    const ptPath = resolved
      ? resolved.name.slice(0, -'.json'.length)
      : map4964PathTo18818(sourceName)
    if (sourceFiles.has(ptPath)) {
      if (duplicateExamples.length < 10)
        duplicateExamples.push(`${sourceName} -> ${ptPath}`)
      continue
    }
    sourceFiles.set(ptPath, (await loadPtItems(abs)).map(normalizeItem))
  }

  await rm(finalRoot, { recursive: true, force: true })
  await mkdir(finalRoot, { recursive: true })

  const plan: MergePlan = { push: [], archive: [], overrideTranslations: [] }
  const stats: MergeStats = {
    files: enFiles.size,
    filesChanged: 0,
    filesCreated: 0,
    filesArchived: 0,
    sourceOnlyFiles: 0,
    sourceOnlyKeys: 0,
    currentPreserved: 0,
    sourceApplied: 0,
    staleFromCurrent: 0,
    staleFrom4964: 0,
    unresolved4964: 0,
  }

  for (const [ptPath, enItems] of enFiles) {
    const currentFile = currentFiles.get(ptPath)
    const currentItems = currentFile?.normalized ?? []
    const sourceItems = sourceFiles.get(ptPath) ?? []

    const currentByKey = new Map(currentItems.map(item => [item.key, item]))
    const sourceByKey = new Map(sourceItems.map(item => [item.key, item]))
    const currentDrift = new Map<string, DriftEntry>()
    const finalItems: PtStringItem[] = []

    for (const enItem of enItems) {
      const current = currentByKey.get(enItem.key)
      const source = sourceByKey.get(enItem.key)

      let translation = ''
      let stage = 0
      const context = current?.context ?? enItem.context
      const hasCurrentExactTranslation = current?.original === enItem.original && !!current.translation

      if (current && current.original === enItem.original) {
        translation = current.translation
        stage = current.stage ?? 0
        if (translation)
          stats.currentPreserved++
      }
      else if (current?.translation) {
        currentDrift.set(enItem.key, { translation: current.translation })
      }

      if (source?.translation) {
        if (source.original === enItem.original) {
          translation = source.translation
          stage = Math.max(source.stage ?? 0, 1)
          currentDrift.delete(enItem.key)
          stats.sourceApplied++
        }
        else if (!hasCurrentExactTranslation) {
          translation = staleMarker(enItem.original, source.translation)
          stage = 0
          currentDrift.delete(enItem.key)
          stats.staleFrom4964++
        }
      }
      else {
        const drift = currentDrift.get(enItem.key)
        if (drift) {
          translation = staleMarker(enItem.original, drift.translation)
          stage = 0
          stats.staleFromCurrent++
        }
      }

      finalItems.push({
        key: enItem.key,
        original: enItem.original,
        translation,
        stage,
        ...(context != null && context !== '' ? { context } : {}),
      })
    }

    for (const sourceItem of sourceItems) {
      if (enItems.some(en => en.key === sourceItem.key))
        continue
      finalItems.push(mergeSourceOnlyItem(sourceItem, currentByKey.get(sourceItem.key)))
      stats.sourceOnlyKeys++
    }

    const out = join(finalRoot, `${ptPath}.json`)
    await mkdir(dirname(out), { recursive: true })
    await writeJson(out, finalItems)

    const existed = currentFile != null
    const legacyPlaceholderRewrite = hasLegacyPlaceholder(currentFile?.raw)
    if (!existed)
      stats.filesCreated++
    if (force || !itemsEqual(currentItems, finalItems) || legacyPlaceholderRewrite) {
      plan.push.push(ptPath)
      stats.filesChanged++
      if (existed && (force || legacyPlaceholderRewrite))
        plan.overrideTranslations.push(ptPath)
    }
  }

  for (const [ptPath, sourceItems] of sourceFiles) {
    if (enFiles.has(ptPath))
      continue

    const currentFile = currentFiles.get(ptPath)
    const currentItems = currentFile?.normalized ?? []
    const currentByKey = new Map(currentItems.map(item => [item.key, item]))
    const finalItems = sourceItems.map(sourceItem => mergeSourceOnlyItem(sourceItem, currentByKey.get(sourceItem.key)))

    const out = join(finalRoot, `${ptPath}.json`)
    await mkdir(dirname(out), { recursive: true })
    await writeJson(out, finalItems)

    stats.sourceOnlyFiles++
    stats.sourceOnlyKeys += finalItems.length
    const legacyPlaceholderRewrite = hasLegacyPlaceholder(currentFile?.raw)
    if (currentFile == null)
      stats.filesCreated++
    if (force || !itemsEqual(currentItems, finalItems) || legacyPlaceholderRewrite) {
      plan.push.push(ptPath)
      stats.filesChanged++
      if (currentFile != null && (force || legacyPlaceholderRewrite))
        plan.overrideTranslations.push(ptPath)
    }
  }

  for (const ptPath of currentFiles.keys()) {
    if (enFiles.has(ptPath) || sourceFiles.has(ptPath) || isArchivedPtPath(ptPath))
      continue
    plan.archive.push(ptPath)
    stats.filesArchived++
  }

  stats.files = enFiles.size + stats.sourceOnlyFiles

  await writeFile(mergeStatsPath, `${JSON.stringify(stats, null, 2)}\n`, 'utf8')
  await writeJson(mergePlanPath, plan)

  if (force)
    // eslint-disable-next-line no-console
    console.log('[merge-final] FORCE mode: every merged file will be re-uploaded to PT 18818')

  // eslint-disable-next-line no-console
  console.log(
    `[merge-final] files=${stats.files} push=${plan.push.length} archive=${plan.archive.length} `
    + `override=${plan.overrideTranslations.length} `
    + `created=${stats.filesCreated} source-only-files=${stats.sourceOnlyFiles} source-only-keys=${stats.sourceOnlyKeys} `
    + `preserved=${stats.currentPreserved} source-applied=${stats.sourceApplied} `
    + `stale-current=${stats.staleFromCurrent} stale-4964=${stats.staleFrom4964} unresolved-4964=${stats.unresolved4964}`,
  )
  if (duplicateExamples.length > 0)
    // eslint-disable-next-line no-console
    console.warn(`[merge-final] duplicate 4964 mappings ignored: ${duplicateExamples.join(', ')}`)
}

void main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[merge-final] failed:', err)
  process.exit(1)
})
