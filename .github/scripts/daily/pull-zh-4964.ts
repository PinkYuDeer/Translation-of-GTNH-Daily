/**
 * Step 3 — pull-zh-4964.
 *
 * Download PT 4964 (the human-reviewed source project) through the artifact
 * endpoint into `.build/zh-4964/` as one JSON per file, keyed on the 4964 path.
 * No 18818 fetch happens here — the path map is applied later in diff-zh.
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
 * The Kiwi233 checkout is reused from fetch-en's sparse-clone
 * (`$REPO_CACHE_DIR/kiwi`).
 */

import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { copyFile, cp, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import {
  BUILD_DIR,
  CONCURRENCY,
  PT_4964_ID,
  REPO_CACHE_DIR,
  assertToken,
} from './lib/config.ts'
import {
  apiGet,
  apiGetRaw,
  apiPostJson,
  listFileTranslations,
  listProjectFiles,
  runBounded,
  sleep,
} from './lib/pt-client.ts'
import { readJson, writeJson } from './lib/cache.ts'
import { parseTipsLines } from './lib/tips-parser.ts'
import { REPO_ARCHIVE_DIR, TIPS_KEYMAP_FILE, TIPS_KIWI_SEEN_FILE } from './lib/config.ts'
import type { TipsRegistry } from './lib/tips-registry.ts'
import { stripPtJsonSuffix } from './lib/path-map.ts'
import type { PtStringItem } from './lib/lang-parser.ts'

const POLL_INTERVAL_MS = 15_000
const POLL_MAX = 20

interface ArtifactInfo {
  createdAt?: string
}

/**
 * PT 4964 stores legacy per-file prefixes in `key`, notably `lang|...` and
 * `gt-lang|...`. PT 18818 and our `.build/en` snapshots use raw Minecraft keys,
 * so strip those prefixes at ingest time.
 */
function normalize4964Key(key: string): string {
  return key.replace(/^(?:gt-)?lang\|/, '').trim()
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

function loadItemsFromJson(data: unknown): PtStringItem[] {
  if (Array.isArray(data))
    return data as PtStringItem[]
  const results = (data as { results?: PtStringItem[] }).results
  return Array.isArray(results) ? results : []
}

function normalize4964Items(items: PtStringItem[]): PtStringItem[] {
  return items.map(item => ({
    ...(item.id != null ? { id: item.id } : {}),
    key: normalize4964Key(item.key),
    original: item.original ?? '',
    translation: item.translation ?? '',
    stage: item.stage ?? 0,
    ...(item.createdAt != null ? { createdAt: item.createdAt } : {}),
    ...(item.updatedAt != null ? { updatedAt: item.updatedAt } : {}),
    ...(item.uid != null ? { uid: item.uid } : {}),
    ...(item.context != null ? { context: item.context } : {}),
  }))
}

async function normalizeArtifactFiles(outRoot: string): Promise<{ files: number, rows: number }> {
  let files = 0
  let rows = 0
  for await (const abs of walkJson(outRoot)) {
    const items = normalize4964Items(loadItemsFromJson(JSON.parse(await readFile(abs, 'utf8'))))
    await writeJson(abs, items)
    files++
    rows += items.length
  }
  return { files, rows }
}

async function tryArtifactFlow(outRoot: string): Promise<boolean> {
  try {
    const before = await apiGet<ArtifactInfo>(`/projects/${PT_4964_ID}/artifacts`).catch(() => ({} as ArtifactInfo))
    const beforeTs = before.createdAt ?? ''
    await apiPostJson(`/projects/${PT_4964_ID}/artifacts`, {})
    // eslint-disable-next-line no-console
    console.log('[pull-zh-4964] artifact build triggered; polling...')

    let ready = false
    for (let i = 0; i < POLL_MAX; i++) {
      await sleep(POLL_INTERVAL_MS)
      const info = await apiGet<ArtifactInfo>(`/projects/${PT_4964_ID}/artifacts`).catch(() => ({} as ArtifactInfo))
      if (info.createdAt && info.createdAt !== beforeTs) {
        ready = true
        // eslint-disable-next-line no-console
        console.log(`[pull-zh-4964] artifact ready after ${(i + 1) * POLL_INTERVAL_MS / 1000}s`)
        break
      }
    }
    if (!ready)
      // eslint-disable-next-line no-console
      console.warn('[pull-zh-4964] artifact poll timed out; attempting download anyway')

    const res = await apiGetRaw(`/projects/${PT_4964_ID}/artifacts/download`)
    const buf = Buffer.from(await res.arrayBuffer())
    const zipPath = join(BUILD_DIR, 'source-4964.zip')
    await mkdir(dirname(zipPath), { recursive: true })
    await writeFile(zipPath, buf)
    await rm(outRoot, { recursive: true, force: true })
    await mkdir(outRoot, { recursive: true })

    const unzip = spawnSync('unzip', ['-o', '-q', zipPath, '-d', outRoot], { stdio: 'inherit' })
    if (unzip.status !== 0)
      throw new Error(`unzip exited ${unzip.status}`)

    await flattenIfSingleDir(outRoot)
    const stats = await normalizeArtifactFiles(outRoot)
    if (stats.files === 0)
      throw new Error('artifact contained no JSON files')
    // eslint-disable-next-line no-console
    console.log(`[pull-zh-4964] artifact: ${stats.files} files / ${stats.rows} rows normalized`)
    return true
  }
  catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`[pull-zh-4964] artifact flow failed, falling back: ${err instanceof Error ? err.message : err}`)
    return false
  }
}

/**
 * Tips: align Kiwi233's zh_CN.txt with the stable tip keys.
 *
 * Upstream puts different-sized header blocks on each side. English: 7 comment
 * lines (content from line 8). Chinese: 7 comment lines + 1 PT feedback notice
 * on line 8 (content from line 9). We skip the respective headers; the i-th
 * Kiwi content line lines up with the i-th English tip in file order, which is
 * `registry.order[i]` (the English file order persisted by fetch-en — note the
 * `.en.json` is now id-ordered, so we must use `order`, not its array index).
 *
 * Line counts may legitimately differ — English tips are added in the modpack
 * before Kiwi233 translates them. We warn but do not fail: uncovered EN tips
 * are emitted with empty translation (stage=0) so diff-zh skips them and they
 * remain untranslated on PT 18818. Extra ZH lines past the EN count are ignored.
 *
 * Ownership + freshness: Kiwi233's zh_CN.txt has no per-line originals or
 * timestamps, so to tell a genuine upstream update from a stale line we keep a
 * snapshot of the last Kiwi233 line we saw per key (`archive/tips/kiwi-seen.json`)
 * and decide per key:
 *   - 18818 has no translation → Kiwi233 fills the gap.
 *   - 18818 == Kiwi233 → no conflict.
 *   - 18818 != Kiwi233 and Kiwi233's line *changed* vs the snapshot → a real
 *     upstream update; take it (override ours — new translations are still wanted).
 *   - 18818 != Kiwi233 and Kiwi233's line is *unchanged* → ours is ahead; keep it.
 * On first run (no snapshot) every conflict keeps ours, so we never clobber an
 * ahead translation before a baseline exists.
 */
async function buildTipsFrom4964Kiwi(): Promise<PtStringItem[] | undefined> {
  const enFile = join(BUILD_DIR, 'en', 'config/Betterloadingscreen/tips/zh_CN.lang.en.json')
  const zhFile = join(REPO_CACHE_DIR, 'kiwi', 'config/Betterloadingscreen/tips/zh_CN.txt')
  if (!existsSync(enFile) || !existsSync(zhFile))
    return undefined
  const enItems = JSON.parse(await readFile(enFile, 'utf8')) as PtStringItem[]
  const origByKey = new Map(enItems.map(item => [item.key, item.original]))
  const registry = await readJson<TipsRegistry>(join(REPO_ARCHIVE_DIR, TIPS_KEYMAP_FILE))
  // Fall back to id order (== file order on a bootstrap run) if order is absent.
  const order = registry?.order ?? enItems.map(item => item.key)
  const zhLines = parseTipsLines(await readFile(zhFile, 'utf8'), 9)
  if (order.length !== zhLines.length) {
    // eslint-disable-next-line no-console
    console.warn(
      `[pull-zh-4964] tips line mismatch (en=${order.length} zh=${zhLines.length}); `
      + 'aligning by position, extras stay untranslated',
    )
  }

  // Current PT 18818 translation per key (what we'd be overriding).
  const currentByKey = new Map<string, string>()
  const currentTips = join(BUILD_DIR, 'zh-current', 'config/Betterloadingscreen/tips/zh_CN.lang.json')
  if (existsSync(currentTips)) {
    const rows = JSON.parse(await readFile(currentTips, 'utf8')) as PtStringItem[]
    for (const row of rows)
      currentByKey.set(row.key, row.translation ?? '')
  }

  // Baseline: the Kiwi233 line we saw last sync, per key.
  const seenPath = join(REPO_ARCHIVE_DIR, TIPS_KIWI_SEEN_FILE)
  const kiwiSeen = (await readJson<Record<string, string>>(seenPath)) ?? {}
  const nextSeen: Record<string, string> = {}

  let filled = 0
  let tookUpstream = 0
  let keptDaily = 0
  const items = order.map((key, i) => {
    const kiwiNow = zhLines[i]
    const ours = currentByKey.get(key) ?? ''
    let translation = ''
    if (kiwiNow != null) {
      nextSeen[key] = kiwiNow // record current Kiwi line as next run's baseline
      if (ours.trim().length === 0) {
        translation = kiwiNow // gap fill
        filled++
      }
      else if (ours !== kiwiNow) {
        // Take Kiwi only if its line actually changed since we last saw it
        // (a genuine upstream update); otherwise it's stale and we keep ours.
        if (kiwiSeen[key] !== undefined && kiwiNow !== kiwiSeen[key]) {
          translation = kiwiNow
          tookUpstream++
        }
        else {
          keptDaily++
        }
      }
    }
    return {
      key,
      original: origByKey.get(key) ?? '',
      translation, // empty here = "keep 18818's translation" (merge skips empty source)
      stage: translation.length > 0 ? 1 : 0, // Kiwi233 rows are reviewed
    }
  })
  await writeJson(seenPath, nextSeen)
  if (filled || tookUpstream || keptDaily)
    // eslint-disable-next-line no-console
    console.log(`[pull-zh-4964] tips: filled=${filled} took-upstream-update=${tookUpstream} kept-daily=${keptDaily}`)
  return items
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

async function fallbackFileByFile(outRoot: string): Promise<void> {
  const files = await listProjectFiles(PT_4964_ID)
  // eslint-disable-next-line no-console
  console.log(`[pull-zh-4964] fallback: pulling ${files.length} files in project ${PT_4964_ID}`)
  await rm(outRoot, { recursive: true, force: true })
  const tasks = files.map(f => async () => {
    const rows = await listFileTranslations(PT_4964_ID, f.id)
    // Convert rows into the same PtStringItem shape used elsewhere, dropping
    // only unrelated server fields; `id` / timestamps are useful for manual
    // conflict investigation when the artifact path does not expose them.
    const items = rows.map(r => ({
      id: r.id,
      key: normalize4964Key(r.key),
      original: r.original,
      translation: r.translation ?? '',
      stage: r.stage ?? 0,
      ...(r.createdAt != null ? { createdAt: r.createdAt } : {}),
      ...(r.updatedAt != null ? { updatedAt: r.updatedAt } : {}),
      ...(r.uid != null ? { uid: r.uid } : {}),
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
  console.log(`[pull-zh-4964] fallback: ${successes} ok / ${failures} failed`)
  if (failures > 0) {
    for (let i = 0; i < results.length; i++) {
      const r = results[i]
      if (r instanceof Error)
        // eslint-disable-next-line no-console
        console.error(`  fail ${files[i].name}: ${r.message}`)
    }
    process.exit(1)
  }
}

async function main(): Promise<void> {
  assertToken()

  const outRoot = join(BUILD_DIR, 'zh-4964')
  const ok = await tryArtifactFlow(outRoot)
  if (!ok)
    await fallbackFileByFile(outRoot)

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
