/**
 * Step 4 — pull-zh-4964.
 *
 * Download every file from PT 4964 (the human-reviewed source project) into
 * `.build/zh-4964/` as one JSON per file, keyed on the 4964 path. No 18818
 * fetch happens here — the path map is applied later in diff-zh.
 *
 * In parallel, we stage three Kiwi233-sourced extras that bypass PT entirely:
 *
 *   - InGameInfoXML/InGameInfo_zh_CN.xml           → shipped as-is at pack time
 *   - txloader/forceload/____gtnhoverridenames_zhcn → shipped as-is at pack time
 *   - Betterloadingscreen/tips/zh_CN.txt           → positionally aligned with
 *                                                    `.build/en/.../tips/...`
 *                                                    to synthesise a fake 4964
 *                                                    file that feeds diff-zh
 *
 * The Kiwi233 checkout is reused from fetch-en's sparse-clone (`.repo.cache/kiwi`).
 */

import { existsSync } from 'node:fs'
import { copyFile, mkdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import {
  BUILD_DIR,
  CONCURRENCY,
  PT_4964_ID,
  REPO_CACHE_DIR,
  assertToken,
} from './lib/config.ts'
import { apiGet, fetchAllPages, runBounded } from './lib/pt-client.ts'
import { writeJson } from './lib/cache.ts'
import { parseTipsLines, tipsToEntries } from './lib/tips-parser.ts'
import { stripPtJsonSuffix } from './lib/path-map.ts'
import type { PtStringItem } from './lib/lang-parser.ts'

interface PtFileSummary { id: number, name: string }

interface PtStringRow {
  id: number
  key: string
  original: string
  translation: string
  stage: number
  context?: string | null
}

const PAGE_SIZE = 1000

async function listFiles(projectId: string): Promise<PtFileSummary[]> {
  // GET /files returns an array directly on PT; tolerate the `{results}` shape
  // just in case the server version differs.
  const data = await apiGet<unknown>(`/projects/${projectId}/files`)
  if (Array.isArray(data))
    return data as PtFileSummary[]
  return (((data as { results?: PtFileSummary[] }).results) ?? [])
}

async function getAllStrings(projectId: string, fileId: number): Promise<PtStringRow[]> {
  return fetchAllPages<PtStringRow>(page =>
    apiGet(`/projects/${projectId}/strings?file=${fileId}&page=${page}&pageSize=${PAGE_SIZE}`),
  )
}

/**
 * Tips: align Kiwi233's zh_CN.txt with fetch-en's synthetic English keys.
 *
 * Upstream puts different-sized header blocks on each side. English: 7 comment
 * lines (content from line 8). Chinese: 7 comment lines + 1 PT feedback notice
 * on line 8 (content from line 9). We skip the respective headers and expect
 * the remaining tip counts to match; if they don't, we fail loudly (upstream
 * tips drift).
 */
async function buildTipsFrom4964Kiwi(): Promise<PtStringItem[] | undefined> {
  const enFile = join(BUILD_DIR, 'en', 'config/Betterloadingscreen/tips/zh_CN.lang.en.json')
  const zhFile = join(REPO_CACHE_DIR, 'kiwi', 'config/Betterloadingscreen/tips/zh_CN.txt')
  if (!existsSync(enFile) || !existsSync(zhFile))
    return undefined
  const enItems = JSON.parse(await readFile(enFile, 'utf8')) as PtStringItem[]
  const zhLines = parseTipsLines(await readFile(zhFile, 'utf8'), 9)
  if (enItems.length !== zhLines.length) {
    throw new Error(`tips line count mismatch: en=${enItems.length} zh=${zhLines.length}`)
  }
  const zhEntries = tipsToEntries(zhLines)
  // Produce a "4964-like" string-item list: translation filled from Kiwi233.
  return enItems.map((en, i) => ({
    key: en.key,
    original: en.original,
    translation: zhEntries[i].value,
    stage: 1, // treat Kiwi233 lines as already-reviewed
  }))
}

async function copyExtras(): Promise<void> {
  const kiwiRoot = join(REPO_CACHE_DIR, 'kiwi')
  const extrasRoot = join(BUILD_DIR, 'extra')
  const pairs: Array<[string, string]> = [
    [
      join(kiwiRoot, 'config/InGameInfoXML/InGameInfo_zh_CN.xml'),
      join(extrasRoot, 'config/InGameInfoXML/InGameInfo_zh_CN.xml'),
    ],
    [
      join(kiwiRoot, 'config/txloader/forceload/____gtnhoverridenames_zhcn/lang/zh_CN.lang'),
      join(extrasRoot, 'config/txloader/forceload/____gtnhoverridenames_zhcn/lang/zh_CN.lang'),
    ],
  ]
  for (const [src, dst] of pairs) {
    if (!existsSync(src)) {
      // eslint-disable-next-line no-console
      console.warn(`[pull-zh-4964] extra missing: ${src}`)
      continue
    }
    await mkdir(dirname(dst), { recursive: true })
    await copyFile(src, dst)
  }
}

async function main(): Promise<void> {
  assertToken()

  const files = await listFiles(PT_4964_ID)
  // eslint-disable-next-line no-console
  console.log(`[pull-zh-4964] ${files.length} files in project ${PT_4964_ID}`)

  const outRoot = join(BUILD_DIR, 'zh-4964')
  const tasks = files.map(f => async () => {
    const rows = await getAllStrings(PT_4964_ID, f.id)
    // Convert rows into the same PtStringItem shape used elsewhere, dropping
    // the server `id` — diff-zh doesn't need it, and keeping it would just
    // balloon the cache.
    const items = rows.map(r => ({
      key: r.key,
      original: r.original,
      translation: r.translation ?? '',
      stage: r.stage ?? 0,
      ...(r.context != null ? { context: r.context } : {}),
    }))
    const relPath = stripPtJsonSuffix(f.name)
    const outPath = join(outRoot, `${relPath}.json`)
    await mkdir(dirname(outPath), { recursive: true })
    await writeJson(outPath, items)
    return { name: f.name, rows: items.length }
  })

  const { successes, failures, results } = await runBounded(tasks, CONCURRENCY)
  // eslint-disable-next-line no-console
  console.log(`[pull-zh-4964] files: ${successes} ok / ${failures} failed`)
  if (failures > 0) {
    for (let i = 0; i < results.length; i++) {
      const r = results[i]
      if (r instanceof Error)
        // eslint-disable-next-line no-console
        console.error(`  fail ${files[i].name}: ${r.message}`)
    }
    process.exit(1)
  }

  // Synthetic tips file — lives under zh-4964 so diff-zh finds it via the
  // same path-map logic. Slot: 4964-style `config/Betterloadingscreen/tips/zh_CN.lang.json`
  // stripped to short form.
  const tipsItems = await buildTipsFrom4964Kiwi()
  if (tipsItems) {
    const out = join(outRoot, 'config/Betterloadingscreen/tips/zh_CN.lang.json')
    await mkdir(dirname(out), { recursive: true })
    await writeJson(out, tipsItems)
    // eslint-disable-next-line no-console
    console.log(`[pull-zh-4964] synthesised tips from Kiwi233 (${tipsItems.length} lines)`)
  }

  await copyExtras()
  // eslint-disable-next-line no-console
  console.log(`[pull-zh-4964] extras staged under ${join(BUILD_DIR, 'extra')}`)
}

void main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[pull-zh-4964] failed:', err)
  process.exit(1)
})
