/**
 * Step 4 — pull-zh-4964.
 *
 * Download every file from PT 4964 (the human-reviewed source project) into
 * `.build/zh-4964/` as one JSON per file, keyed on the 4964 path. No 18818
 * fetch happens here — the path map is applied later in diff-zh.
 *
 * In parallel, we stage four Kiwi233-sourced extras that bypass PT entirely:
 *
 *   - InGameInfoXML/InGameInfo_zh_CN.xml           → shipped as-is at pack time
 *   - txloader/forceload/____gtnhoverridenames_zhcn → shipped as-is at pack time
 *   - Betterloadingscreen/tips/zh_CN.txt           → positionally aligned with
 *                                                    `.build/en/.../tips/...`
 *                                                    to synthesise a fake 4964
 *                                                    file that feeds diff-zh
 *   - resources/minecraft/**                       → shipped as-is at
 *                                                    `config/txloader/forceload/minecraft/**`
 *
 * The Kiwi233 checkout is reused from fetch-en's sparse-clone (`.repo.cache/kiwi`).
 */

import { existsSync } from 'node:fs'
import { copyFile, cp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import {
  BUILD_DIR,
  CONCURRENCY,
  PT_4964_ID,
  REPO_CACHE_DIR,
  assertToken,
} from './lib/config.ts'
import { listFileStrings, listProjectFiles, runBounded } from './lib/pt-client.ts'
import { writeJson } from './lib/cache.ts'
import { parseTipsLines, tipsToEntries } from './lib/tips-parser.ts'
import { stripPtJsonSuffix } from './lib/path-map.ts'
import type { PtStringItem } from './lib/lang-parser.ts'

/**
 * TEMPORARY OVERRIDE: Kiwi233 master hasn't merged the latest zh_CN.txt yet,
 * so we fetch the file from MagicYuDeer/patch-1 and stage it over the Kiwi233
 * checkout. Remove this block (and the call in main) once the PR merges back
 * into Kiwi233 master.
 */
const TIPS_ZH_OVERRIDE_URL
  = 'https://raw.githubusercontent.com/MagicYuDeer/Translation-of-GTNH/patch-1/config/Betterloadingscreen/tips/zh_CN.txt'
const TIPS_ZH_PATH_IN_KIWI = 'config/Betterloadingscreen/tips/zh_CN.txt'

/**
 * PT 4964 stores legacy per-file prefixes in `key`, notably `lang|...` and
 * `gt-lang|...`. PT 18818 and our `.build/en` snapshots use raw Minecraft keys,
 * so strip those prefixes at ingest time.
 */
function normalize4964Key(key: string): string {
  return key.replace(/^(?:gt-)?lang\|/, '').trim()
}

async function applyTipsZhOverride(): Promise<void> {
  const dst = join(REPO_CACHE_DIR, 'kiwi', TIPS_ZH_PATH_IN_KIWI)
  const res = await fetch(TIPS_ZH_OVERRIDE_URL)
  if (!res.ok)
    throw new Error(`tips-override fetch failed: ${res.status} ${res.statusText}`)
  const body = await res.text()
  await mkdir(dirname(dst), { recursive: true })
  await writeFile(dst, body, 'utf8')
  // eslint-disable-next-line no-console
  console.log(`[pull-zh-4964] tips override staged (${body.length} bytes) from MagicYuDeer/patch-1`)
}

/**
 * Tips: align Kiwi233's zh_CN.txt with fetch-en's synthetic English keys.
 *
 * Upstream puts different-sized header blocks on each side. English: 7 comment
 * lines (content from line 8). Chinese: 7 comment lines + 1 PT feedback notice
 * on line 8 (content from line 9). We skip the respective headers and align
 * the rest by position.
 *
 * Line counts may legitimately differ — English tips are added in the modpack
 * before Kiwi233 translates them. We warn but do not fail: extra EN tips are
 * emitted with empty translation (stage=0) so diff-zh skips them and they
 * remain untranslated on PT 18818 until someone updates the repo-side zh_CN.txt.
 * Extra ZH lines past the EN count are ignored (upstream removed those tips).
 */
async function buildTipsFrom4964Kiwi(): Promise<PtStringItem[] | undefined> {
  const enFile = join(BUILD_DIR, 'en', 'config/Betterloadingscreen/tips/zh_CN.lang.en.json')
  const zhFile = join(REPO_CACHE_DIR, 'kiwi', 'config/Betterloadingscreen/tips/zh_CN.txt')
  if (!existsSync(enFile) || !existsSync(zhFile))
    return undefined
  const enItems = JSON.parse(await readFile(enFile, 'utf8')) as PtStringItem[]
  const zhLines = parseTipsLines(await readFile(zhFile, 'utf8'), 9)
  if (enItems.length !== zhLines.length) {
    // eslint-disable-next-line no-console
    console.warn(
      `[pull-zh-4964] tips line mismatch (en=${enItems.length} zh=${zhLines.length}); `
      + 'aligning by position, extras stay untranslated',
    )
  }
  const zhEntries = tipsToEntries(zhLines)
  return enItems.map((en, i) => {
    const zh = zhEntries[i]
    return {
      key: en.key,
      original: en.original,
      translation: zh?.value ?? '',
      stage: zh ? 1 : 0, // Kiwi233 rows are reviewed; uncovered rows start at 0
    }
  })
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

  const minecraftSrc = join(kiwiRoot, 'resources/minecraft')
  const minecraftDst = join(extrasRoot, 'config/txloader/forceload/minecraft')
  if (!existsSync(minecraftSrc)) {
    // eslint-disable-next-line no-console
    console.warn(`[pull-zh-4964] extra missing: ${minecraftSrc}`)
    return
  }
  await cp(minecraftSrc, minecraftDst, { recursive: true, force: true })
}

async function main(): Promise<void> {
  assertToken()

  await applyTipsZhOverride()

  const files = await listProjectFiles(PT_4964_ID)
  // eslint-disable-next-line no-console
  console.log(`[pull-zh-4964] ${files.length} files in project ${PT_4964_ID}`)

  const outRoot = join(BUILD_DIR, 'zh-4964')
  const tasks = files.map(f => async () => {
    const rows = await listFileStrings(PT_4964_ID, f.id)
    // Convert rows into the same PtStringItem shape used elsewhere, dropping
    // the server `id` — diff-zh doesn't need it, and keeping it would just
    // balloon the cache.
    const items = rows.map(r => ({
      key: normalize4964Key(r.key),
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

  const { successes, failures, results } = await runBounded(tasks, CONCURRENCY, {
    onSettled: ({ completed, total, failures, result }) => {
      if (completed === 1 || completed === total || completed % 25 === 0 || result instanceof Error)
        // eslint-disable-next-line no-console
        console.log(`[pull-zh-4964] progress ${completed}/${total} files (fail=${failures})`)
    },
  })
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
