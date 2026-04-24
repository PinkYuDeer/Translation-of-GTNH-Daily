/**
 * Step 7 — pull-final-18818.
 *
 * Pull the *current* state of PT 18818 as the authoritative final translation.
 * PT 18818 may contain "forward translations" — edits made directly in the PT
 * UI that haven't flowed back into PT 4964 yet — so we can't reconstruct the
 * final state locally; we must download it.
 *
 * Preferred path: artifact endpoint. POST /artifacts triggers a zip build,
 * poll until the server-reported `createdAt` advances past our request time,
 * then GET /artifacts/download. One POST + one GET per run instead of ~500
 * per-file calls.
 *
 * Fallback path: if the artifact endpoint fails or poll times out, iterate
 * `files.json` and GET /strings each file individually (slower but correct).
 *
 * Output: `.build/zh-final/<pt-path>.lang.json` (matching PT's filename shape;
 * restore-and-pack strips `.json` to get back the short pt-path).
 */

import { spawnSync } from 'node:child_process'
import { mkdir, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import {
  BUILD_DIR,
  CONCURRENCY,
  PT_18818_ID,
  assertToken,
} from './lib/config.ts'
import { readFileIds, writeJson } from './lib/cache.ts'
import {
  apiGet,
  apiGetRaw,
  apiPostJson,
  fetchAllPages,
  runBounded,
  sleep,
} from './lib/pt-client.ts'

const POLL_INTERVAL_MS = 15_000
const POLL_MAX = 20

interface ArtifactInfo {
  /** ISO timestamp of the last successful build. */
  createdAt?: string
}

/**
 * Some PT projects emit zips whose contents are nested under a single wrapper
 * directory (e.g. `utf8/...`); others emit flat trees. Flatten when we detect
 * exactly one top-level dir so downstream code can assume a stable layout.
 */
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
    console.log('[pull-final] artifact build triggered; polling…')

    let ready = false
    for (let i = 0; i < POLL_MAX; i++) {
      await sleep(POLL_INTERVAL_MS)
      const info = await apiGet<ArtifactInfo>(`/projects/${PT_18818_ID}/artifacts`).catch(() => ({} as ArtifactInfo))
      if (info.createdAt && info.createdAt !== beforeTs) {
        ready = true
        // eslint-disable-next-line no-console
        console.log(`[pull-final] artifact ready after ${(i + 1) * POLL_INTERVAL_MS / 1000}s`)
        break
      }
    }
    if (!ready)
      // eslint-disable-next-line no-console
      console.warn('[pull-final] artifact poll timed out; attempting download anyway')

    const res = await apiGetRaw(`/projects/${PT_18818_ID}/artifacts/download`)
    const buf = Buffer.from(await res.arrayBuffer())
    const zipPath = join(BUILD_DIR, 'artifact.zip')
    await mkdir(dirname(zipPath), { recursive: true })
    await writeFile(zipPath, buf)
    await mkdir(outRoot, { recursive: true })

    const unzip = spawnSync('unzip', ['-o', '-q', zipPath, '-d', outRoot], { stdio: 'inherit' })
    if (unzip.status !== 0)
      throw new Error(`unzip exited ${unzip.status}`)

    await flattenIfSingleDir(outRoot)
    return true
  }
  catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`[pull-final] artifact flow failed, falling back: ${err instanceof Error ? err.message : err}`)
    return false
  }
}

interface PtStringRow {
  key: string
  original: string
  translation: string
  stage: number
  context?: string | null
}

async function fallbackFileByFile(outRoot: string): Promise<void> {
  const fileIds = await readFileIds()
  const entries = Object.entries(fileIds)
  // eslint-disable-next-line no-console
  console.log(`[pull-final] fallback: pulling ${entries.length} files per-file`)

  const tasks = entries.map(([ptPath, fileId]) => async () => {
    const rows = await fetchAllPages<PtStringRow>(page =>
      apiGet(`/projects/${PT_18818_ID}/strings?file=${fileId}&page=${page}&pageSize=1000`),
    )
    const items = rows.map(r => ({
      key: r.key,
      original: r.original,
      translation: r.translation ?? '',
      stage: r.stage ?? 0,
      ...(r.context != null ? { context: r.context } : {}),
    }))
    // Output name matches the artifact-zip layout: `<pt-path>.json`
    // (pt-path is short-form with `.lang`, and we append `.json` to mirror
    // PT's on-disk filename convention).
    const out = join(outRoot, `${ptPath}.json`)
    await mkdir(dirname(out), { recursive: true })
    await writeJson(out, items)
  })
  const { successes, failures, results } = await runBounded(tasks, CONCURRENCY)
  // eslint-disable-next-line no-console
  console.log(`[pull-final] fallback: ${successes} ok / ${failures} failed`)
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

async function main(): Promise<void> {
  assertToken()
  const outRoot = join(BUILD_DIR, 'zh-final')
  await mkdir(outRoot, { recursive: true })
  const ok = await tryArtifactFlow(outRoot)
  if (!ok)
    await fallbackFileByFile(outRoot)
  // eslint-disable-next-line no-console
  console.log(`[pull-final] wrote ${outRoot}`)
}

void main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[pull-final] failed:', err)
  process.exit(1)
})
