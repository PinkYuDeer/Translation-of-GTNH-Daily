/**
 * Step 2 — pull-current-18818.
 *
 * Pull the current state of PT 18818 before we start any merge work. This is
 * the "our PT" side in the new daily flow:
 *
 *   upstream English + current PT 18818 + upstream PT 4964 -> local final files
 *
 * We persist two things:
 *   1. `.build/zh-current/<pt-path>.json`  — current PT file contents
 *   2. `.cache/file-ids/files.json`        — current PT fileId map
 *
 * Preferred path: artifact endpoint (one build + one download) for file
 * contents, plus a regular `/files` listing for numeric ids. Fallback: per-file
 * `/strings` fetch for files missing from the artifact payload.
 */

import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import {
  BUILD_DIR,
  CONCURRENCY,
  PT_18818_ID,
  assertToken,
} from './lib/config.ts'
import { writeFileIds, writeJson } from './lib/cache.ts'
import {
  apiGet,
  apiGetRaw,
  apiPostJson,
  listProjectFiles,
  listFileStrings,
  runBounded,
  sleep,
} from './lib/pt-client.ts'
import { stripPtJsonSuffix } from './lib/path-map.ts'

const POLL_INTERVAL_MS = 15_000
const POLL_MAX = 20

interface ArtifactInfo {
  createdAt?: string
}

async function flattenIfSingleDir(root: string): Promise<void> {
  const ents = await readdir(root, { withFileTypes: true, encoding: 'utf8' })
  if (ents.length !== 1 || !ents[0].isDirectory())
    return
  const inner = join(root, ents[0].name)
  const innerEnts = await readdir(inner, { withFileTypes: true, encoding: 'utf8' })
  for (const e of innerEnts)
    await rename(join(inner, e.name), join(root, e.name))
  await rm(inner, { recursive: true, force: true })
}

async function tryArtifactFlow(outRoot: string): Promise<boolean> {
  try {
    const before = await apiGet<ArtifactInfo>(`/projects/${PT_18818_ID}/artifacts`).catch(() => ({} as ArtifactInfo))
    const beforeTs = before.createdAt ?? ''
    await apiPostJson(`/projects/${PT_18818_ID}/artifacts`, {})
    // eslint-disable-next-line no-console
    console.log('[pull-current] artifact build triggered; polling…')

    let ready = false
    for (let i = 0; i < POLL_MAX; i++) {
      await sleep(POLL_INTERVAL_MS)
      const info = await apiGet<ArtifactInfo>(`/projects/${PT_18818_ID}/artifacts`).catch(() => ({} as ArtifactInfo))
      if (info.createdAt && info.createdAt !== beforeTs) {
        ready = true
        // eslint-disable-next-line no-console
        console.log(`[pull-current] artifact ready after ${(i + 1) * POLL_INTERVAL_MS / 1000}s`)
        break
      }
    }
    if (!ready)
      // eslint-disable-next-line no-console
      console.warn('[pull-current] artifact poll timed out; attempting download anyway')

    const res = await apiGetRaw(`/projects/${PT_18818_ID}/artifacts/download`)
    const buf = Buffer.from(await res.arrayBuffer())
    const zipPath = join(BUILD_DIR, 'current-18818.zip')
    await mkdir(dirname(zipPath), { recursive: true })
    await writeFile(zipPath, buf)
    await rm(outRoot, { recursive: true, force: true })
    await mkdir(outRoot, { recursive: true })

    const unzip = spawnSync('unzip', ['-o', '-q', zipPath, '-d', outRoot], { stdio: 'inherit' })
    if (unzip.status !== 0)
      throw new Error(`unzip exited ${unzip.status}`)

    await flattenIfSingleDir(outRoot)
    return true
  }
  catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`[pull-current] artifact flow failed, falling back: ${err instanceof Error ? err.message : err}`)
    return false
  }
}

async function fetchFilesById(outRoot: string, entries: Array<[string, number]>, label: string): Promise<void> {
  await mkdir(outRoot, { recursive: true })
  // eslint-disable-next-line no-console
  console.log(`[pull-current] ${label}: pulling ${entries.length} file(s) per-file`)

  const tasks = entries.map(([ptPath, fileId]) => async () => {
    const rows = await listFileStrings(PT_18818_ID, fileId)
    const items = rows.map(r => ({
      id: r.id,
      key: r.key,
      original: r.original,
      translation: r.translation ?? '',
      stage: r.stage ?? 0,
      ...(r.createdAt != null ? { createdAt: r.createdAt } : {}),
      ...(r.updatedAt != null ? { updatedAt: r.updatedAt } : {}),
      ...(r.uid != null ? { uid: r.uid } : {}),
      ...(r.context != null ? { context: r.context } : {}),
    }))
    const out = join(outRoot, `${ptPath}.json`)
    await mkdir(dirname(out), { recursive: true })
    await writeJson(out, items)
  })

  const { successes, failures, results } = await runBounded(tasks, CONCURRENCY, {
    onSettled: ({ completed, total, failures, result }) => {
      if (completed === 1 || completed === total || completed % 25 === 0 || result instanceof Error)
        // eslint-disable-next-line no-console
        console.log(`[pull-current] ${label} progress ${completed}/${total} files (fail=${failures})`)
    },
  })
  // eslint-disable-next-line no-console
  console.log(`[pull-current] ${label}: ${successes} ok / ${failures} failed`)
  if (failures > 0) {
    for (let i = 0; i < results.length; i++) {
      const r = results[i]
      if (r instanceof Error)
        // eslint-disable-next-line no-console
        console.error(`  fail ${entries[i][0]}: ${r.message}`)
    }
    process.exit(1)
  }
}

async function fallbackFileByFile(outRoot: string, entries: Array<[string, number]>): Promise<void> {
  await rm(outRoot, { recursive: true, force: true })
  await fetchFilesById(outRoot, entries, 'fallback')
}

async function hydrateMissingArtifactFiles(outRoot: string, entries: Array<[string, number]>): Promise<void> {
  const missing = entries.filter(([ptPath]) => !existsSync(join(outRoot, `${ptPath}.json`)))
  if (missing.length === 0)
    return
  await fetchFilesById(outRoot, missing, 'artifact-missing')
}

async function main(): Promise<void> {
  assertToken()

  const files = await listProjectFiles(PT_18818_ID)
  const fileIds = Object.fromEntries(files.map(f => [stripPtJsonSuffix(f.name), f.id]))
  await writeFileIds(fileIds)

  const fileEntries = Object.entries(fileIds)
  // eslint-disable-next-line no-console
  console.log(`[pull-current] ${files.length} total files in project ${PT_18818_ID}`)

  const outRoot = join(BUILD_DIR, 'zh-current')
  const ok = await tryArtifactFlow(outRoot)
  if (!ok)
    await fallbackFileByFile(outRoot, fileEntries)
  else
    await hydrateMissingArtifactFiles(outRoot, fileEntries)

  // eslint-disable-next-line no-console
  console.log(`[pull-current] wrote ${outRoot}`)
}

void main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[pull-current] failed:', err)
  process.exit(1)
})
