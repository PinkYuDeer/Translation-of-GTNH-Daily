/**
 * Step 3 — push-en.
 *
 * Upload every pt-path listed in `changed-en.json` to PT 18818. One file = one
 * REST call: either a replace (`POST /projects/{id}/files/{fileId}`) when we
 * already know the fileId, or a create (`POST /projects/{id}/files`) when we
 * don't. For files that vanished from the current daily but existed last run,
 * we do not delete them: we rename them in PT via `PUT /files/{id}` to
 * `*.achive.json` and prune the active-path caches locally.
 *
 * The upload body is the PT-skeleton JSON that fetch-en produced under
 * `.build/en/<pt-path>.en.json`.
 *
 * Side effects (atomic per file, so a mid-run crash leaves a consistent cache):
 *   1. files.json      — freshly-assigned fileIds recorded
 *   2. en-lastrun/     — copy of what we just uploaded (diff-en reads this)
 *   3. stale-ids.json  — list of pt-paths whose stringIds must be refreshed
 *                        before push-zh runs (a file replace reallocates ids)
 *
 * Upstream parity improvement: if local `files.json` is cold or partially
 * missing, we first re-list remote PT files and recover fileIds by filename,
 * so we update-in-place instead of accidentally attempting a duplicate create.
 *
 * Internal pt-path convention: short form without `.json` suffix (matches
 * filesystem layout under `.build/en/`). Only converted to PT's `.lang.json`
 * shape when talking to the server.
 */

import { existsSync } from 'node:fs'
import { mkdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { BUILD_DIR, CACHE_DIR, CACHE_PATHS, CONCURRENCY, PT_18818_ID, assertToken } from './lib/config.ts'
import {
  deleteEnLastrun,
  deleteStringIds,
  deleteZhLastrun,
  readFileIds,
  readJson,
  writeEnLastrun,
  writeFileIds,
  writeJson,
} from './lib/cache.ts'
import {
  apiPostMultipart,
  apiPutJson,
  indexFilesByLowerName,
  listProjectFiles,
  runBounded,
} from './lib/pt-client.ts'
import type { PtStringItem } from './lib/lang-parser.ts'
import { toArchivePtPath, toPtJsonPath } from './lib/path-map.ts'

/** Shape of PT's POST /files response (the fields we care about). */
interface PtFileCreateResponse {
  file?: { id: number, name: string }
  // Some PT versions inline the fields at the top level.
  id?: number
  name?: string
}

interface PtFileMutationResult {
  id: number
  name: string
}

interface PushResult {
  ptPath: string
  action: 'upload' | 'archive' | 'prune'
  id?: number
  archivedTo?: string
}

async function loadItems(ptPath: string): Promise<PtStringItem[] | undefined> {
  const abs = join(BUILD_DIR, 'en', `${ptPath}.en.json`)
  if (!existsSync(abs))
    return undefined
  return JSON.parse(await readFile(abs, 'utf8')) as PtStringItem[]
}

/** PT's `files` endpoints key on the `.lang.json` form. */
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

function normalizeMutationResult(
  ptPath: string,
  response: PtFileCreateResponse,
  existingFileId: number | undefined,
): PtFileMutationResult {
  const id = response.file?.id ?? response.id ?? existingFileId
  const name = response.file?.name ?? response.name
  if (typeof id !== 'number' || typeof name !== 'string')
    throw new Error(`POST /files returned incomplete metadata for ${ptPath}: ${JSON.stringify(response)}`)
  return { id, name }
}

/** Upload or rename a single file. Returns the resulting PT file metadata. */
async function uploadOne(
  ptPath: string,
  existingFileId: number | undefined,
  items: PtStringItem[],
): Promise<PtFileMutationResult> {
  const body = JSON.stringify(items)
  const filename = ptBasename(ptPath)
  if (existingFileId != null) {
    const res = await apiPostMultipart<PtFileCreateResponse>(`/projects/${PT_18818_ID}/files/${existingFileId}`, {}, {
      name: 'file',
      filename,
      content: body,
    })
    return normalizeMutationResult(ptPath, res, existingFileId)
  }
  const res = await apiPostMultipart<PtFileCreateResponse>(
    `/projects/${PT_18818_ID}/files`,
    { path: ptDirname(ptPath) },
    { name: 'file', filename, content: body },
  )
  return normalizeMutationResult(ptPath, res, existingFileId)
}

async function renameOne(
  oldPtPath: string,
  existingFileId: number,
  newPtPath: string,
): Promise<PtFileMutationResult> {
  const res = await apiPutJson<PtFileCreateResponse>(
    `/projects/${PT_18818_ID}/files/${existingFileId}`,
    { name: toPtJsonPath(newPtPath) },
  )
  return normalizeMutationResult(oldPtPath, res, existingFileId)
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

async function pruneActiveCaches(
  ptPath: string,
  fileIds: Record<string, number>,
  staleSet: Set<string>,
): Promise<void> {
  delete fileIds[ptPath]
  staleSet.delete(ptPath)
  await Promise.all([
    deleteEnLastrun(ptPath),
    deleteZhLastrun(ptPath),
    deleteStringIds(ptPath),
  ])
}

async function main(): Promise<void> {
  assertToken()

  const changed = (await readJson<string[]>(join(CACHE_DIR, CACHE_PATHS.changedEn))) ?? []
  if (changed.length === 0) {
    // eslint-disable-next-line no-console
    console.log('[push-en] no changes to push')
    return
  }

  const fileIds = await readFileIds()
  const recovered = await hydrateMissingFileIds(changed, fileIds)
  if (recovered > 0)
    // eslint-disable-next-line no-console
    console.log(`[push-en] recovered ${recovered} fileId(s) from remote file list`)
  const staleIds: string[] = (await readJson<string[]>(join(CACHE_DIR, CACHE_PATHS.staleIds))) ?? []
  const staleSet = new Set(staleIds)

  // Updates to shared state (fileIds, staleSet, en-lastrun) happen inside each
  // task on success — so a partial run still leaves the cache self-consistent
  // for the files that did make it through.
  const tasks = changed.map(ptPath => async () => {
    const items = await loadItems(ptPath)
    const existing = fileIds[ptPath]
    if (items) {
      const res = await uploadOne(ptPath, existing, items)
      const expected = toPtJsonPath(ptPath)
      if (res.name !== expected)
        throw new Error(`upload path mismatch for ${ptPath}: expected ${expected}, got ${res.name}`)
      fileIds[ptPath] = res.id
      staleSet.add(ptPath)
      await writeEnLastrun(ptPath, items)
      return { ptPath, action: 'upload', id: res.id } satisfies PushResult
    }

    if (existing == null) {
      await pruneActiveCaches(ptPath, fileIds, staleSet)
      return { ptPath, action: 'prune' } satisfies PushResult
    }

    const archivedPtPath = toArchivePtPath(ptPath)
    const res = await renameOne(ptPath, existing, archivedPtPath)
    const expected = toPtJsonPath(archivedPtPath)
    if (res.name !== expected) {
      throw new Error(
        `archive rename did not stick for ${ptPath}: expected ${expected}, got ${res.name}`,
      )
    }
    await pruneActiveCaches(ptPath, fileIds, staleSet)
    return { ptPath, action: 'archive', id: res.id, archivedTo: archivedPtPath } satisfies PushResult
  })

  const { successes, failures, results } = await runBounded(tasks, CONCURRENCY, {
    onSettled: ({ completed, total, failures, result }) => {
      if (completed === 1 || completed === total || completed % 25 === 0 || result instanceof Error)
        // eslint-disable-next-line no-console
        console.log(`[push-en] progress ${completed}/${total} (fail=${failures})`)
    },
  })

  // Always flush shared state, even on partial failure.
  await writeFileIds(fileIds)
  await mkdir(dirname(join(CACHE_DIR, CACHE_PATHS.staleIds)), { recursive: true })
  await writeJson(join(CACHE_DIR, CACHE_PATHS.staleIds), [...staleSet])

  let uploaded = 0
  let archived = 0
  let pruned = 0
  for (const r of results) {
    if (r instanceof Error)
      continue
    if (r.action === 'upload')
      uploaded++
    else if (r.action === 'archive')
      archived++
    else
      pruned++
  }
  // eslint-disable-next-line no-console
  console.log(
    `[push-en] ${successes} ok / ${failures} failed (of ${changed.length}); `
    + `uploaded=${uploaded} archived=${archived} pruned=${pruned}`,
  )
  if (archived > 0) {
    for (const r of results) {
      if (r instanceof Error || r.action !== 'archive')
        continue
      // eslint-disable-next-line no-console
      console.log(`[push-en] archived ${r.ptPath} -> ${r.archivedTo}`)
    }
  }
  if (failures > 0) {
    for (let i = 0; i < results.length; i++) {
      const r = results[i]
      if (r instanceof Error)
        // eslint-disable-next-line no-console
        console.error(`  fail ${changed[i]}: ${r.message}`)
    }
    process.exit(1)
  }
}

void main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[push-en] failed:', err)
  process.exit(1)
})
