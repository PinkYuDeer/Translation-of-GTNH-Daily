/**
 * Step 3 — push-en.
 *
 * Upload every pt-path listed in `changed-en.json` to PT 18818. One file = one
 * REST call: either a replace (`POST /projects/{id}/files/{fileId}`) when we
 * already know the fileId, or a create (`POST /projects/{id}/files`) when we
 * don't. The file body is the PT-skeleton JSON that fetch-en produced under
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
  readFileIds,
  readJson,
  writeEnLastrun,
  writeFileIds,
  writeJson,
} from './lib/cache.ts'
import {
  apiPostMultipart,
  indexFilesByLowerName,
  listProjectFiles,
  runBounded,
} from './lib/pt-client.ts'
import type { PtStringItem } from './lib/lang-parser.ts'
import { toPtJsonPath } from './lib/path-map.ts'

/** Shape of PT's POST /files response (the fields we care about). */
interface PtFileCreateResponse {
  file?: { id: number, name: string }
  // Some PT versions inline the fields at the top level.
  id?: number
  name?: string
}

async function loadItems(ptPath: string): Promise<PtStringItem[]> {
  const abs = join(BUILD_DIR, 'en', `${ptPath}.en.json`)
  if (!existsSync(abs))
    throw new Error(`changed pt-path missing from .build/en: ${ptPath}`)
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

/** Upload a single file. Returns the fileId (new or existing). */
async function uploadOne(
  ptPath: string,
  existingFileId: number | undefined,
  items: PtStringItem[],
): Promise<number> {
  const body = JSON.stringify(items)
  const filename = ptBasename(ptPath)
  if (existingFileId != null) {
    await apiPostMultipart(`/projects/${PT_18818_ID}/files/${existingFileId}`, {}, {
      name: 'file',
      filename,
      content: body,
    })
    return existingFileId
  }
  const res = await apiPostMultipart<PtFileCreateResponse>(
    `/projects/${PT_18818_ID}/files`,
    { path: ptDirname(ptPath) },
    { name: 'file', filename, content: body },
  )
  const newId = res.file?.id ?? res.id
  if (typeof newId !== 'number')
    throw new Error(`POST /files returned no id for ${ptPath}: ${JSON.stringify(res)}`)
  return newId
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
    const id = await uploadOne(ptPath, existing, items)
    fileIds[ptPath] = id
    staleSet.add(ptPath)
    await writeEnLastrun(ptPath, items)
    return { ptPath, id }
  })

  const { successes, failures, results } = await runBounded(tasks, CONCURRENCY)

  // Always flush shared state, even on partial failure.
  await writeFileIds(fileIds)
  await mkdir(dirname(join(CACHE_DIR, CACHE_PATHS.staleIds)), { recursive: true })
  await writeJson(join(CACHE_DIR, CACHE_PATHS.staleIds), [...staleSet])

  // eslint-disable-next-line no-console
  console.log(`[push-en] ${successes} ok / ${failures} failed (of ${changed.length})`)
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
