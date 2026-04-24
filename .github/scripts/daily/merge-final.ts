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
 *   - English key/original set is authoritative: keys/files absent from English
 *     disappear from the active final tree.
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
import { normalizePtNewlines } from './lib/newlines.ts'
import {
  indexByModId,
  isArchivedPtPath,
  resolve4964To18818,
} from './lib/path-map.ts'

interface MergePlan {
  push: string[]
  archive: string[]
}

interface DriftEntry {
  translation: string
}

interface MergeStats {
  files: number
  filesChanged: number
  filesCreated: number
  filesArchived: number
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
    || (item.translation ?? '').includes('<BR>')
    || (item.translation ?? '').includes('<br>'),
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

async function main(): Promise<void> {
  const enRoot = join(BUILD_DIR, 'en')
  const currentRoot = join(BUILD_DIR, 'zh-current')
  const sourceRoot = join(BUILD_DIR, 'zh-4964')
  const finalRoot = join(BUILD_DIR, 'zh-final')
  const mergePlanPath = join(BUILD_DIR, 'merge-plan.json')
  const mergeStatsPath = join(BUILD_DIR, 'merge-stats.json')

  const enFiles = new Map<string, PtStringItem[]>()
  for await (const abs of walkJson(enRoot)) {
    const rel = toPosix(relative(enRoot, abs))
    const ptPath = rel.endsWith('.en.json') ? rel.slice(0, -'.en.json'.length) : rel
    enFiles.set(ptPath, (await loadPtItems(abs)).map(normalizeItem))
  }

  const currentFiles = new Map<string, PtStringItem[]>()
  for await (const abs of walkJson(currentRoot)) {
    const rel = toPosix(relative(currentRoot, abs))
    const ptPath = rel.endsWith('.json') ? rel.slice(0, -'.json'.length) : rel
    if (isArchivedPtPath(ptPath))
      continue
    currentFiles.set(ptPath, (await loadPtItems(abs)).map(normalizeItem))
  }

  const targetEntries = [...enFiles.keys()].map(ptPath => ({ name: `${ptPath}.json` }))
  const targetByName = new Map(targetEntries.map(entry => [entry.name, entry]))
  const targetByModId = indexByModId(targetEntries)

  const sourceFiles = new Map<string, PtStringItem[]>()
  let unresolved4964 = 0
  const unresolvedExamples: string[] = []
  const duplicateExamples: string[] = []

  for await (const abs of walkJson(sourceRoot)) {
    const sourceName = toPosix(relative(sourceRoot, abs))
    const resolved = resolve4964To18818(sourceName, targetByName, targetByModId)
    if (!resolved) {
      unresolved4964++
      if (unresolvedExamples.length < 10)
        unresolvedExamples.push(sourceName)
      continue
    }
    const ptPath = resolved.name.slice(0, -'.json'.length)
    if (sourceFiles.has(ptPath)) {
      if (duplicateExamples.length < 10)
        duplicateExamples.push(`${sourceName} -> ${ptPath}`)
      continue
    }
    sourceFiles.set(ptPath, (await loadPtItems(abs)).map(normalizeItem))
  }

  await rm(finalRoot, { recursive: true, force: true })
  await mkdir(finalRoot, { recursive: true })

  const plan: MergePlan = { push: [], archive: [] }
  const stats: MergeStats = {
    files: enFiles.size,
    filesChanged: 0,
    filesCreated: 0,
    filesArchived: 0,
    currentPreserved: 0,
    sourceApplied: 0,
    staleFromCurrent: 0,
    staleFrom4964: 0,
    unresolved4964,
  }

  for (const [ptPath, enItems] of enFiles) {
    const currentItems = currentFiles.get(ptPath) ?? []
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

    const out = join(finalRoot, `${ptPath}.json`)
    await mkdir(dirname(out), { recursive: true })
    await writeJson(out, finalItems)

    const existed = currentFiles.has(ptPath)
    const legacyPlaceholderRewrite = hasLegacyPlaceholder(currentItems)
    if (!existed)
      stats.filesCreated++
    if (!itemsEqual(currentFiles.get(ptPath), finalItems) || legacyPlaceholderRewrite) {
      plan.push.push(ptPath)
      stats.filesChanged++
    }
  }

  for (const ptPath of currentFiles.keys()) {
    if (enFiles.has(ptPath) || isArchivedPtPath(ptPath))
      continue
    plan.archive.push(ptPath)
    stats.filesArchived++
  }

  await writeFile(mergeStatsPath, `${JSON.stringify(stats, null, 2)}\n`, 'utf8')
  await writeJson(mergePlanPath, plan)

  // eslint-disable-next-line no-console
  console.log(
    `[merge-final] files=${stats.files} push=${plan.push.length} archive=${plan.archive.length} `
    + `created=${stats.filesCreated} preserved=${stats.currentPreserved} source-applied=${stats.sourceApplied} `
    + `stale-current=${stats.staleFromCurrent} stale-4964=${stats.staleFrom4964} unresolved-4964=${stats.unresolved4964}`,
  )
  if (unresolvedExamples.length > 0)
    // eslint-disable-next-line no-console
    console.warn(`[merge-final] unresolved 4964 examples: ${unresolvedExamples.join(', ')}`)
  if (duplicateExamples.length > 0)
    // eslint-disable-next-line no-console
    console.warn(`[merge-final] duplicate 4964 mappings ignored: ${duplicateExamples.join(', ')}`)
}

void main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[merge-final] failed:', err)
  process.exit(1)
})
