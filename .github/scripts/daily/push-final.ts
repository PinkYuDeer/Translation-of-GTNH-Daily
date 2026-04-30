/**
 * Step 5 — push-final.
 *
 * Upload the merged local final state from `.build/zh-final/` back to PT 18818
 * as full-file replacements. Files retired from the active English source are
 * written to the repository `archive/` tree using their pack path, then deleted
 * from PT so the project does not keep `.disable` / `.achive` leftovers.
 *
 * Special case: if an English file is brand-new and 18818 does not have it
 * yet, we do NOT create it with translated rows inline. Instead we:
 *   1. create the file from English originals only (empty translations)
 *   2. list the newborn stringIds
 *   3. push translated rows one-by-one
 *
 * This matches PT's create/update semantics more reliably for fresh files.
 *
 * This script consumes `.build/merge-plan.json`:
 *   - `push[]`    — active files to create/replace via POST /files
 *   - `archive[]` — retired PT files to write under archive/ and delete
 */

import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { BUILD_DIR, CONCURRENCY, PT_18818_ID, assertToken } from './lib/config.ts'
import { readFileIds, readNewlines, writeFileIds } from './lib/cache.ts'
import {
  apiDeleteJson,
  apiPostMultipart,
  apiPutJson,
  indexFilesByLowerName,
  listFileStrings,
  listProjectFiles,
  runBounded,
} from './lib/pt-client.ts'
import {
  type LangEntry,
  type PtStringItem,
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
  overrideTranslations?: string[]
}

interface PtStringWriteRow {
  stringId: number
  fileId: number
  key: string
  original: string
  translation: string
  stage: number
  context?: string
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

function toPtUploadItems(items: PtStringItem[]): PtStringItem[] {
  return items.map(item => ({
    key: item.key,
    original: toPtNewlines(item.original ?? ''),
    translation: toPtNewlines(item.translation ?? ''),
    stage: item.stage ?? 0,
    ...(item.context != null && item.context !== '' ? { context: item.context } : {}),
  }))
}

function toEnglishOnlyItems(items: PtStringItem[]): PtStringItem[] {
  return items.map(item => ({
    key: item.key,
    original: item.original,
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

  const rows = await listFileStrings(PT_18818_ID, fileId)
  return rows.map(r => ({
    key: r.key,
    original: r.original,
    translation: r.translation ?? '',
    stage: r.stage ?? 0,
    ...(r.context != null ? { context: r.context } : {}),
  }))
}

function archivedText(
  ptPath: string,
  items: PtStringItem[],
  newlineForms: Record<string, string> | undefined,
): string {
  const entries: LangEntry[] = []
  for (const item of items) {
    if (!item.key)
      continue
    const valueSource = item.translation && item.translation.length > 0
      ? item.translation
      : (item.original ?? '')
    if (valueSource.length === 0)
      continue
    const form = newlineForms?.[item.key] as '<BR>' | '<br>' | '\\n' | '\\\\n' | '%n' | undefined
    entries.push({
      key: item.key,
      value: restoreNewlines(valueSource, form),
    })
  }

  const activePtPath = stripArchiveSuffix(ptPath)
  if (activePtPath === 'GregTech.lang')
    return serializeGregTechLang(entries)
  if (activePtPath === TIPS_PT_PATH)
    return entriesToTips(entries)
  return serializeLang(entries)
}

async function writeRetiredFileArchive(
  ptPath: string,
  items: PtStringItem[],
  newlineForms: Record<string, string> | undefined,
): Promise<string> {
  const rel = archivePackPath(ptPath)
  const out = join(REPO_ARCHIVE_DIR, rel)
  await mkdir(dirname(out), { recursive: true })
  await writeFile(out, archivedText(ptPath, items, newlineForms), 'utf8')
  return rel
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

async function uploadOne(
  ptPath: string,
  existingFileId: number | undefined,
  items: PtStringItem[],
): Promise<PtFileMutationResult> {
  const body = JSON.stringify(toPtUploadItems(items))
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
  return normalizeMutationResult(ptPath, res, existingFileId)
}

async function putOneString(row: PtStringWriteRow): Promise<void> {
  await apiPutJson(`/projects/${PT_18818_ID}/strings/${row.stringId}`, {
    key: row.key,
    original: toPtNewlines(row.original),
    translation: toPtNewlines(row.translation),
    file: row.fileId,
    stage: row.stage,
    ...(row.context != null ? { context: row.context } : {}),
  })
}

async function pushTranslationsPerString(
  ptPath: string,
  fileId: number,
  items: PtStringItem[],
  label: 'new-file' | 'override',
): Promise<void> {
  const candidates = label === 'new-file'
    ? items.filter(item => item.translation.length > 0 || (item.stage ?? 0) > 0)
    : items
  if (candidates.length === 0)
    return

  const remoteRows = await listFileStrings(PT_18818_ID, fileId)
  const remoteByKey = new Map(remoteRows.map(row => [row.key, row]))
  const rowTasks: Array<() => Promise<void>> = []
  for (const item of candidates) {
    const remote = remoteByKey.get(item.key)
    if (!remote) {
      if (label === 'new-file')
        throw new Error(`new PT file ${ptPath} missing stringId for key ${item.key}`)
      // On override, a brand-new key will have been materialized by the file
      // POST but may not yet be visible; skip rather than fail the whole file.
      continue
    }
    // Skip PUT if PT's stored translation already matches what we want. File
    // uploads only refresh originals, but for matching translations there is
    // nothing to overwrite and we avoid burning rate-limited API calls.
    const desired = toPtNewlines(item.translation)
    const desiredStage = item.stage ?? 0
    if ((remote.translation ?? '') === desired && (remote.stage ?? 0) === desiredStage)
      continue
    rowTasks.push(async () => {
      await putOneString({
        stringId: remote.id,
        fileId,
        key: item.key,
        original: item.original,
        translation: item.translation,
        stage: item.stage ?? 0,
        ...(item.context != null && item.context !== '' ? { context: item.context } : {}),
      })
    })
  }

  if (rowTasks.length === 0)
    return

  const { failures, results } = await runBounded(rowTasks, CONCURRENCY, {
    onSettled: ({ completed, total, failures, result }) => {
      if (completed === 1 || completed === total || completed % 100 === 0 || result instanceof Error)
        // eslint-disable-next-line no-console
        console.log(`[push-final] ${label} row progress ${ptPath} ${completed}/${total} (fail=${failures})`)
    },
  })
  if (failures > 0) {
    const failed = results.find(r => r instanceof Error)
    throw failed instanceof Error ? failed : new Error(`${label} translation push failed for ${ptPath}`)
  }
}

async function pushTranslationsForNewFile(ptPath: string, fileId: number, items: PtStringItem[]): Promise<void> {
  return pushTranslationsPerString(ptPath, fileId, items, 'new-file')
}

async function overrideTranslationsForFile(ptPath: string, fileId: number, items: PtStringItem[]): Promise<void> {
  return pushTranslationsPerString(ptPath, fileId, items, 'override')
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
  if (plan.push.length === 0 && plan.archive.length === 0) {
    // eslint-disable-next-line no-console
    console.log('[push-final] no file changes to push')
    return
  }

  const fileIds = await readFileIds()
  const recovered = await hydrateMissingFileIds([...plan.push, ...plan.archive], fileIds)
  if (recovered > 0)
    // eslint-disable-next-line no-console
    console.log(`[push-final] recovered ${recovered} fileId(s) from remote file list`)

  const overrideSet = new Set(plan.overrideTranslations ?? [])
  const newlineCache = await readNewlines()

  const pushTasks = plan.push.map(ptPath => async () => {
    const items = await loadItems(ptPath)
    const existingFileId = fileIds[ptPath]
    const res = existingFileId != null
      ? await uploadOne(ptPath, existingFileId, items)
      : await uploadOne(ptPath, undefined, toEnglishOnlyItems(items))
    const expected = toPtJsonPath(ptPath)
    if (res.name !== expected)
      throw new Error(`upload path mismatch for ${ptPath}: expected ${expected}, got ${res.name}`)
    fileIds[ptPath] = res.id
    if (existingFileId == null)
      await pushTranslationsForNewFile(ptPath, res.id, items)
    else if (overrideSet.has(ptPath))
      await overrideTranslationsForFile(ptPath, res.id, items)
    return ptPath
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
  // eslint-disable-next-line no-console
  console.log(
    `[push-final] uploaded=${pushRun.successes}/${plan.push.length} `
    + `override=${overrideSet.size} `
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
