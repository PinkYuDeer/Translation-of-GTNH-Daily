/**
 * Step 5 — push-final.
 *
 * Upload the merged local final state from `.build/zh-final/` back to PT 18818
 * as source-file updates plus translation imports. Files retired from the
 * active English source are written to the repository `archive/` tree using
 * their pack path, then deleted from PT so the project does not keep `.disable`
 * / `.achive` leftovers.
 *
 * PT's source-file update endpoint only mutates originals. Existing/new
 * translations are imported through POST /files/{fileId}/translation so PT
 * records a file import revision rather than assigning every row to the bot.
 *
 * This script consumes `.build/merge-plan.json`:
 *   - `push[]`    — active files to create/update via POST /files
 *   - `archive[]` — retired PT files to write under archive/ and delete
 *   - `archiveStrings{}` — retired strings inside still-active files
 */

import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { BUILD_DIR, CONCURRENCY, PT_18818_ID, assertToken } from './lib/config.ts'
import { readFileIds, readNewlines, resolveNewlineForm, writeFileIds, type NewlineFileForms } from './lib/cache.ts'
import {
  apiDeleteJson,
  apiPostMultipart,
  importFileTranslations,
  indexFilesByLowerName,
  listFileTranslations,
  listFileStrings,
  listProjectFiles,
  runBounded,
} from './lib/pt-client.ts'
import {
  type LangEntry,
  type PtStringItem,
  parseLang,
  serializeGregTechLang,
  serializeLang,
} from './lib/lang-parser.ts'
import { restoreNewlines, toPtNewlines } from './lib/newlines.ts'
import { stripArchiveSuffix, toPtJsonPath } from './lib/path-map.ts'
import { entriesToTips } from './lib/tips-parser.ts'

const REPO_ARCHIVE_DIR = process.env.REPO_ARCHIVE_DIR ?? 'archive'
const TIPS_PT_PATH = 'config/Betterloadingscreen/tips/zh_CN.lang'

interface PtFileMutationResponse {
  file?: { id: number, name: string }
  id?: number
  name?: string
  status?: string
}

interface PtFileMutationResult {
  id: number
  name: string
}

interface MergePlan {
  push: string[]
  archive: string[]
  archiveStrings?: Record<string, string[]>
  overrideTranslations?: string[]
}

function ptBasename(ptPath: string): string {
  const full = toPtJsonPath(ptPath)
  const slash = full.lastIndexOf('/')
  return slash < 0 ? full : full.slice(slash + 1)
}

function ptDirname(ptPath: string): string {
  const full = toPtJsonPath(ptPath)
  const slash = full.lastIndexOf('/')
  return slash < 0 ? '' : full.slice(0, slash)
}

async function loadItems(ptPath: string): Promise<PtStringItem[]> {
  const abs = join(BUILD_DIR, 'zh-final', `${ptPath}.json`)
  return JSON.parse(await readFile(abs, 'utf8')) as PtStringItem[]
}

function toPtSourceItems(items: PtStringItem[]): PtStringItem[] {
  return items.map(item => ({
    key: item.key,
    original: toPtNewlines(item.original ?? ''),
    translation: '',
    stage: 0,
    ...(item.context != null && item.context !== '' ? { context: item.context } : {}),
  }))
}

function archivePackPath(ptPath: string): string {
  const activePtPath = stripArchiveSuffix(ptPath)
  if (activePtPath === 'GregTech.lang')
    return 'GregTech_zh_CN.lang'
  if (activePtPath === TIPS_PT_PATH)
    return 'config/Betterloadingscreen/tips/zh_CN.txt'
  return activePtPath
}

async function loadCurrentItems(ptPath: string, fileId: number): Promise<PtStringItem[]> {
  const abs = join(BUILD_DIR, 'zh-current', `${ptPath}.json`)
  if (existsSync(abs))
    return JSON.parse(await readFile(abs, 'utf8')) as PtStringItem[]

  const rows = await listFileTranslations(PT_18818_ID, fileId)
  return rows.map(r => ({
    key: r.key,
    original: r.original,
    translation: r.translation ?? '',
    stage: r.stage ?? 0,
    ...(r.context != null ? { context: r.context } : {}),
  }))
}

function archiveEntries(
  ptPath: string,
  items: PtStringItem[],
  newlineForms: NewlineFileForms | undefined,
): LangEntry[] {
  const entries: LangEntry[] = []
  for (const item of items) {
    if (!item.key)
      continue
    const valueSource = item.translation && item.translation.length > 0
      ? item.translation
      : (item.original ?? '')
    if (valueSource.length === 0)
      continue
    const form = resolveNewlineForm(newlineForms, item.key)
    entries.push({
      key: item.key,
      value: restoreNewlines(valueSource, form),
    })
  }
  return entries
}

function serializeArchiveEntries(ptPath: string, entries: LangEntry[]): string {
  const activePtPath = stripArchiveSuffix(ptPath)
  if (activePtPath === 'GregTech.lang')
    return serializeGregTechLang(entries)
  if (activePtPath === TIPS_PT_PATH)
    return entriesToTips(entries)
  return serializeLang(entries)
}

async function readExistingArchiveEntries(ptPath: string, out: string): Promise<LangEntry[]> {
  if (!existsSync(out))
    return []
  const activePtPath = stripArchiveSuffix(ptPath)
  const content = await readFile(out, 'utf8')
  if (activePtPath === TIPS_PT_PATH)
    return content
      .split(/\r?\n/)
      .filter(line => line.length > 0)
      .map((line, i) => ({ key: `archived.tip.${String(i + 1).padStart(4, '0')}`, value: line }))
  return parseLang(content)
}

async function writeMergedArchive(
  ptPath: string,
  items: PtStringItem[],
  newlineForms: NewlineFileForms | undefined,
): Promise<string> {
  const rel = archivePackPath(ptPath)
  const out = join(REPO_ARCHIVE_DIR, rel)
  const incoming = archiveEntries(ptPath, items, newlineForms)
  if (incoming.length === 0)
    return rel

  await mkdir(dirname(out), { recursive: true })
  const activePtPath = stripArchiveSuffix(ptPath)
  if (activePtPath === TIPS_PT_PATH && existsSync(out)) {
    const oldLines = (await readFile(out, 'utf8')).split(/\r?\n/).filter(line => line.length > 0)
    const seen = new Set(oldLines)
    for (const line of entriesToTips(incoming).split(/\r?\n/)) {
      if (line.length > 0 && !seen.has(line)) {
        oldLines.push(line)
        seen.add(line)
      }
    }
    await writeFile(out, `${oldLines.join('\n')}\n`, 'utf8')
    return rel
  }

  const merged = new Map<string, LangEntry>()
  for (const entry of await readExistingArchiveEntries(ptPath, out))
    merged.set(entry.key, entry)
  for (const entry of incoming)
    merged.set(entry.key, entry)
  await writeFile(out, serializeArchiveEntries(ptPath, [...merged.values()]), 'utf8')
  return rel
}

async function writeRetiredFileArchive(
  ptPath: string,
  items: PtStringItem[],
  newlineForms: NewlineFileForms | undefined,
): Promise<string> {
  return writeMergedArchive(ptPath, items, newlineForms)
}

function normalizeMutationResult(
  ptPath: string,
  response: PtFileMutationResponse,
  existingFileId: number | undefined,
): PtFileMutationResult {
  if (existingFileId != null && (response.status === 'hashMatched' || response.status === 'empty'))
    return { id: existingFileId, name: toPtJsonPath(ptPath) }

  const id = response.file?.id ?? response.id ?? existingFileId
  const name = response.file?.name ?? response.name
  if (typeof id !== 'number' || typeof name !== 'string')
    throw new Error(`PT mutation returned incomplete metadata for ${ptPath}: ${JSON.stringify(response)}`)
  return { id, name }
}

async function recoverMutationResultByName(
  ptPath: string,
  response: PtFileMutationResponse,
): Promise<PtFileMutationResult | undefined> {
  if (response.status !== 'hashMatched' && response.status !== 'empty')
    return undefined
  const expected = toPtJsonPath(ptPath)
  const remote = indexFilesByLowerName(await listProjectFiles(PT_18818_ID))
  const hit = remote.get(expected.toLowerCase())
  return hit ? { id: hit.id, name: hit.name } : undefined
}

async function uploadOne(
  ptPath: string,
  existingFileId: number | undefined,
  items: PtStringItem[],
): Promise<PtFileMutationResult> {
  const body = JSON.stringify(toPtSourceItems(items))
  const filename = ptBasename(ptPath)
  if (existingFileId != null) {
    const res = await apiPostMultipart<PtFileMutationResponse>(`/projects/${PT_18818_ID}/files/${existingFileId}`, {}, {
      name: 'file',
      filename,
      content: body,
    })
    return normalizeMutationResult(ptPath, res, existingFileId)
  }
  const res = await apiPostMultipart<PtFileMutationResponse>(
    `/projects/${PT_18818_ID}/files`,
    { path: ptDirname(ptPath) },
    { name: 'file', filename, content: body },
  )
  const recovered = await recoverMutationResultByName(ptPath, res)
  return recovered ?? normalizeMutationResult(ptPath, res, existingFileId)
}

function toTranslationImportItems(items: PtStringItem[]): PtStringItem[] {
  return items.map(item => ({
    key: item.key,
    original: toPtNewlines(item.original ?? ''),
    translation: toPtNewlines(item.translation ?? ''),
    stage: item.stage ?? 0,
    ...(item.context != null && item.context !== '' ? { context: item.context } : {}),
  }))
}

async function importTranslationBatch(
  ptPath: string,
  fileId: number,
  items: PtStringItem[],
  force: boolean,
): Promise<void> {
  if (items.length === 0)
    return
  await importFileTranslations(
    PT_18818_ID,
    fileId,
    ptBasename(ptPath),
    JSON.stringify(toTranslationImportItems(items)),
    { force },
  )
}

async function importChangedTranslations(
  ptPath: string,
  fileId: number,
  items: PtStringItem[],
): Promise<{ imported: number, forced: number }> {
  const remoteRows = await listFileTranslations(PT_18818_ID, fileId)
  const remoteByKey = new Map(remoteRows.map(row => [row.key, row]))
  const normal: PtStringItem[] = []
  const forced: PtStringItem[] = []

  for (const item of items) {
    const remote = remoteByKey.get(item.key)
    if (!remote)
      throw new Error(`PT file ${ptPath} missing string after source upload: ${item.key}`)

    const desiredTranslation = toPtNewlines(item.translation ?? '')
    const desiredStage = item.stage ?? 0
    const remoteTranslation = remote.translation ?? ''
    const remoteStage = remote.stage ?? 0
    if (remoteTranslation === desiredTranslation && remoteStage === desiredStage)
      continue

    if (desiredTranslation.length === 0 || remoteTranslation === desiredTranslation)
      forced.push(item)
    else
      normal.push(item)
  }

  await importTranslationBatch(ptPath, fileId, normal, false)
  await importTranslationBatch(ptPath, fileId, forced, true)
  return { imported: normal.length, forced: forced.length }
}

async function deleteOne(
  existingFileId: number,
): Promise<void> {
  await apiDeleteJson(`/projects/${PT_18818_ID}/files/${existingFileId}`)
}

async function hydrateMissingFileIds(
  ptPaths: string[],
  fileIds: Record<string, number>,
): Promise<number> {
  const missing = ptPaths.filter(ptPath => typeof fileIds[ptPath] !== 'number')
  if (missing.length === 0)
    return 0
  const remote = indexFilesByLowerName(await listProjectFiles(PT_18818_ID))
  let recovered = 0
  for (const ptPath of missing) {
    const hit = remote.get(toPtJsonPath(ptPath).toLowerCase())
    if (!hit)
      continue
    fileIds[ptPath] = hit.id
    recovered++
  }
  return recovered
}

async function main(): Promise<void> {
  assertToken()

  const planPath = join(BUILD_DIR, 'merge-plan.json')
  if (!existsSync(planPath)) {
    // eslint-disable-next-line no-console
    console.log('[push-final] no merge-plan.json; nothing to do')
    return
  }
  const plan = JSON.parse(await readFile(planPath, 'utf8')) as MergePlan
  const archiveStringPlan = plan.archiveStrings ?? {}
  const archiveStringPaths = Object.keys(archiveStringPlan)
  if (plan.push.length === 0 && plan.archive.length === 0 && archiveStringPaths.length === 0) {
    // eslint-disable-next-line no-console
    console.log('[push-final] no file changes to push')
    return
  }

  const fileIds = await readFileIds()
  const recovered = await hydrateMissingFileIds([...plan.push, ...plan.archive, ...archiveStringPaths], fileIds)
  if (recovered > 0)
    // eslint-disable-next-line no-console
    console.log(`[push-final] recovered ${recovered} fileId(s) from remote file list`)

  const newlineCache = await readNewlines()

  const pushTasks = plan.push.map(ptPath => async () => {
    const items = await loadItems(ptPath)
    const existingFileId = fileIds[ptPath]
    let archivedStrings = 0
    const retiredKeys = archiveStringPlan[ptPath] ?? []
    if (existingFileId != null && retiredKeys.length > 0) {
      const retiredKeySet = new Set(retiredKeys)
      const currentItems = await loadCurrentItems(ptPath, existingFileId)
      const retiredItems = currentItems.filter(item => retiredKeySet.has(item.key))
      if (retiredItems.length > 0) {
        const activePtPath = stripArchiveSuffix(ptPath)
        await writeRetiredFileArchive(
          ptPath,
          retiredItems,
          newlineCache[activePtPath] ?? newlineCache[ptPath],
        )
        archivedStrings = retiredItems.length
      }
    }

    const res = await uploadOne(ptPath, existingFileId, items)
    const expected = toPtJsonPath(ptPath)
    if (res.name !== expected)
      throw new Error(`upload path mismatch for ${ptPath}: expected ${expected}, got ${res.name}`)
    fileIds[ptPath] = res.id
    const translationResult = await importChangedTranslations(ptPath, res.id, items)
    return { ptPath, archivedStrings, ...translationResult }
  })

  const archiveTasks = plan.archive.map(ptPath => async () => {
    const existing = fileIds[ptPath]
    if (existing == null)
      return `${ptPath} (missing-fileId, skipped)`
    const items = await loadCurrentItems(ptPath, existing)
    const activePtPath = stripArchiveSuffix(ptPath)
    const archivedRel = await writeRetiredFileArchive(
      ptPath,
      items,
      newlineCache[activePtPath] ?? newlineCache[ptPath],
    )
    await deleteOne(existing)
    delete fileIds[ptPath]
    return `${ptPath} -> archive/${archivedRel} (deleted from PT)`
  })

  const pushRun = await runBounded(pushTasks, CONCURRENCY, {
    onSettled: ({ completed, total, failures, result }) => {
      if (total > 0 && (completed === 1 || completed === total || completed % 25 === 0 || result instanceof Error))
        // eslint-disable-next-line no-console
        console.log(`[push-final] upload progress ${completed}/${total} (fail=${failures})`)
    },
  })

  const archiveRun = await runBounded(archiveTasks, CONCURRENCY, {
    onSettled: ({ completed, total, failures, result }) => {
      if (total > 0 && (completed === 1 || completed === total || completed % 25 === 0 || result instanceof Error))
        // eslint-disable-next-line no-console
        console.log(`[push-final] archive progress ${completed}/${total} (fail=${failures})`)
    },
  })

  await writeFileIds(fileIds)

  const totalFailures = pushRun.failures + archiveRun.failures
  const imported = pushRun.results.reduce((sum, r) => sum + (!(r instanceof Error) ? r.imported : 0), 0)
  const forced = pushRun.results.reduce((sum, r) => sum + (!(r instanceof Error) ? r.forced : 0), 0)
  const archivedStrings = pushRun.results.reduce((sum, r) => sum + (!(r instanceof Error) ? r.archivedStrings : 0), 0)
  // eslint-disable-next-line no-console
  console.log(
    `[push-final] uploaded=${pushRun.successes}/${plan.push.length} `
    + `translation-imported=${imported} forced-clears=${forced} archived-strings=${archivedStrings} `
    + `archived=${archiveRun.successes}/${plan.archive.length} failed=${totalFailures}`,
  )

  if (totalFailures > 0) {
    for (let i = 0; i < pushRun.results.length; i++) {
      const r = pushRun.results[i]
      if (r instanceof Error)
        // eslint-disable-next-line no-console
        console.error(`  upload fail ${plan.push[i]}: ${r.message}`)
    }
    for (let i = 0; i < archiveRun.results.length; i++) {
      const r = archiveRun.results[i]
      if (r instanceof Error)
        // eslint-disable-next-line no-console
        console.error(`  archive fail ${plan.archive[i]}: ${r.message}`)
    }
    process.exit(1)
  }
}

void main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[push-final] failed:', err)
  process.exit(1)
})
