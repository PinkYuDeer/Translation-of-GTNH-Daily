/**
 * Step 7.5 + 8 — restore-and-pack.
 *
 * Two concerns combined into one script (they share the "layout the final
 * tree" step):
 *
 * 1. Rebuild real .lang files from `.build/zh-final/<pt-path>.lang.json`:
 *      - restore each entry's newline placeholder from `newlines.json`
 *      - preserve English key order (`.build/en/<pt-path>.en.json`)
 *      - empty translations → write `key=` (no English fallback; Minecraft
 *        reads en_US.lang for missing keys automatically)
 *    Tips are reversed back into `zh_CN.txt` since Minecraft's Better
 *    Loading Screen doesn't read .lang for tips.
 *
 * 2. Assemble the pack tree (matches C:\…\2.8.4 reference):
 *
 *      archive/
 *        GregTech_en_US.lang
 *        GregTech_zh_CN.lang
 *        config/
 *          InGameInfoXML/InGameInfo_zh_CN.xml        (Kiwi233 direct)
 *          Betterloadingscreen/tips/zh_CN.txt        (tips .lang → .txt)
 *          amazingtrophies/lang/zh_CN.lang
 *          txloader/
 *            forceload/<Display>[<modid>]/lang/zh_CN.lang
 *            forceload/____gtnhoverridenames_zhcn/lang/zh_CN.lang  (Kiwi233 direct)
 *            load/<modid>/lang/zh_CN.lang
 *
 *    amazingtrophies intentionally ships at *both* paths (root `/config/` and
 *    under `txloader/load/`); contents differ per upstream and the translation
 *    team confirmed both are needed.
 *
 * 3. 7z the staged tree with `-mx=9`. Output path is `$ASSETS_PATH/$ARCHIVE_NAME`.
 *
 * Env vars (read on invocation):
 *   ARCHIVE_NAME  (e.g. `daily-2026-04-24.7z`) — required for packing
 *   ASSETS_PATH                                   — required for packing
 *   PACK_ONLY=1                                   — skip rebuild, pack only
 *                                                  (for manual re-pack runs)
 */

import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { copyFile, cp, mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve, sep } from 'node:path'

import { BUILD_DIR, REPO_CACHE_DIR } from './lib/config.ts'
import { readNewlines } from './lib/cache.ts'
import { entriesToTips } from './lib/tips-parser.ts'
import {
  type LangEntry,
  type PtStringItem,
  serializeLang,
} from './lib/lang-parser.ts'
import { restoreNewlines } from './lib/newlines.ts'

const TIPS_PT_PATH = 'config/Betterloadingscreen/tips/zh_CN.lang'

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

/**
 * Load a PT-shaped JSON file. Tolerant of both array and `{results: []}`
 * wrappers so we don't depend on which endpoint produced it.
 */
async function loadPtItems(abs: string): Promise<PtStringItem[]> {
  const data: unknown = JSON.parse(await readFile(abs, 'utf8'))
  if (Array.isArray(data)) return data as PtStringItem[]
  const r = (data as { results?: PtStringItem[] }).results
  return Array.isArray(r) ? r : []
}

/**
 * Build a .lang-shaped LangEntry[] from zh-final items, re-applying newlines
 * and preserving English key order. Missing keys in the final (possible if
 * PT dropped one somehow) are emitted with empty value so the file round-
 * trips with the same keyspace as the English source.
 */
function reassemble(
  ptPath: string,
  finalItems: PtStringItem[],
  enItems: PtStringItem[] | undefined,
  newlinesForFile: Record<string, string> | undefined,
): LangEntry[] {
  const finalByKey = new Map(finalItems.map(i => [i.key, i]))
  const enByKey = new Map((enItems ?? []).map(i => [i.key, i]))
  const orderKeys = enItems?.map(i => i.key) ?? [...finalByKey.keys()]
  // Tips aren't a real .lang file at runtime — Better Loading Screen reads the
  // rebuilt zh_CN.txt directly, which means there's no en_US.lang fallback.
  // For untranslated tip keys we emit the English original so the loading
  // screen still shows something instead of a blank line.
  const isTips = ptPath === TIPS_PT_PATH
  const out: LangEntry[] = []
  for (const key of orderKeys) {
    const item = finalByKey.get(key)
    // Empty/undefined translation → write `key=` so Minecraft falls back to
    // en_US.lang at runtime (per translation team decision). Tips are the
    // exception noted above.
    const translation = item?.translation && item.translation.length > 0
      ? item.translation
      : isTips
        ? enByKey.get(key)?.original ?? ''
        : ''
    const form = newlinesForFile?.[key] as '<BR>' | '<br>' | '\\n' | undefined
    const value = restoreNewlines(translation, form)
    out.push({ key, value })
  }
  return out
}

async function rebuildLangTree(): Promise<string> {
  const finalRoot = join(BUILD_DIR, 'zh-final')
  const enRoot = join(BUILD_DIR, 'en')
  const outRoot = join(BUILD_DIR, 'zh-lang')
  const newlines = await readNewlines()

  let count = 0
  for await (const abs of walkJson(finalRoot)) {
    // filename shape: `<pt-path>.lang.json` or `GregTech.lang.json`, etc.
    const rel = toPosix(relative(finalRoot, abs))
    // Strip only the trailing `.json` → pt-path (keeps the `.lang` suffix).
    const ptPath = rel.endsWith('.json') ? rel.slice(0, -'.json'.length) : rel

    const finalItems = await loadPtItems(abs)
    const enAbs = join(enRoot, `${ptPath}.en.json`)
    const enItems = existsSync(enAbs)
      ? (JSON.parse(await readFile(enAbs, 'utf8')) as PtStringItem[])
      : undefined

    const entries = reassemble(ptPath, finalItems, enItems, newlines[ptPath])
    const outAbs = join(outRoot, ptPath)
    await mkdir(dirname(outAbs), { recursive: true })
    await writeFile(outAbs, serializeLang(entries), 'utf8')
    count++
  }
  // eslint-disable-next-line no-console
  console.log(`[restore] rebuilt ${count} lang file(s) under ${outRoot}`)
  return outRoot
}

/**
 * Tips get converted back to the `.txt` layout Minecraft expects; the
 * positional `tip.NNNN` keys are sorted and the values concatenated.
 *
 * The first 8 lines of Kiwi233's zh_CN.txt (7 comment lines + the PT feedback
 * notice) are preserved verbatim as the preamble, so upstream edits to either
 * flow through without touching this code.
 */
async function rebuildTipsTxt(zhLangRoot: string): Promise<string | undefined> {
  const tipsLangPath = join(zhLangRoot, TIPS_PT_PATH)
  if (!existsSync(tipsLangPath))
    return undefined
  const text = await readFile(tipsLangPath, 'utf8')
  // Parse our own emitted .lang by splitting on first `=` per line.
  const entries: LangEntry[] = []
  for (const line of text.split('\n')) {
    const idx = line.indexOf('=')
    if (idx < 0) continue
    entries.push({ key: line.slice(0, idx).trim(), value: line.slice(idx + 1) })
  }
  const body = entriesToTips(entries)

  let preamble = ''
  const kiwiTips = join(REPO_CACHE_DIR, 'kiwi/config/Betterloadingscreen/tips/zh_CN.txt')
  if (existsSync(kiwiTips)) {
    const kiwiText = (await readFile(kiwiTips, 'utf8')).replace(/\r\n/g, '\n')
    const lines = kiwiText.split('\n').slice(0, 8)
    preamble = `${lines.join('\n')}\n`
  }

  const outPath = join(BUILD_DIR, 'zh-tips/config/Betterloadingscreen/tips/zh_CN.txt')
  await mkdir(dirname(outPath), { recursive: true })
  await writeFile(outPath, preamble + body, 'utf8')
  return outPath
}

/**
 * Stage the final archive tree into a temp dir, then shell out to `7z`.
 */
async function pack(zhLangRoot: string, tipsTxt: string | undefined): Promise<void> {
  const archiveName = process.env.ARCHIVE_NAME
  const assetsPath = process.env.ASSETS_PATH
  if (!archiveName || !assetsPath) {
    // eslint-disable-next-line no-console
    console.log('[pack] ARCHIVE_NAME/ASSETS_PATH unset; skipping archive step (rebuild-only mode)')
    return
  }

  const absAssets = resolve(assetsPath)
  await mkdir(absAssets, { recursive: true })
  const stage = await mkdtemp(join(tmpdir(), 'gtnh-daily-pack-'))

  // Copy every rebuilt .lang file into the staged tree, preserving pt-path.
  // GregTech.lang is special: it ships at the archive root as `GregTech_zh_CN.lang`
  // (plus `GregTech_en_US.lang` from the English source).
  for await (const abs of walkLang(zhLangRoot)) {
    const rel = toPosix(relative(zhLangRoot, abs))
    if (rel === 'GregTech.lang') {
      await copyFile(abs, join(stage, 'GregTech_zh_CN.lang'))
      continue
    }
    if (rel === TIPS_PT_PATH)
      continue // tips shipped as .txt instead
    const dst = join(stage, rel)
    await mkdir(dirname(dst), { recursive: true })
    await copyFile(abs, dst)
  }

  // English GregTech.lang (unmodified) — copied from the sparse checkout.
  const enGreg = join('.repo.cache/translations/daily-history/GregTech.lang')
  if (existsSync(enGreg))
    await copyFile(enGreg, join(stage, 'GregTech_en_US.lang'))

  // Tips .txt
  if (tipsTxt) {
    const dst = join(stage, 'config/Betterloadingscreen/tips/zh_CN.txt')
    await mkdir(dirname(dst), { recursive: true })
    await copyFile(tipsTxt, dst)
  }

  // Kiwi233 direct extras (InGameInfoXML, overridenames_zhcn).
  const extras = join(BUILD_DIR, 'extra')
  if (existsSync(extras))
    await cp(extras, stage, { recursive: true, force: true })

  // 7z
  const outZip = join(absAssets, archiveName)
  const r = spawnSync('7z', ['a', '-t7z', '-mx=9', outZip, '.'], {
    cwd: stage,
    stdio: 'inherit',
  })
  if (r.status !== 0)
    throw new Error(`7z exited ${r.status}`)

  // eslint-disable-next-line no-console
  console.log(`[pack] wrote ${outZip}`)
}

async function* walkLang(dir: string): AsyncGenerator<string> {
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
      yield* walkLang(p)
    else if (e.isFile() && e.name.endsWith('.lang'))
      yield p
  }
}

async function main(): Promise<void> {
  const packOnly = process.env.PACK_ONLY === '1'
  const zhLangRoot = packOnly ? join(BUILD_DIR, 'zh-lang') : await rebuildLangTree()
  const tipsTxt = await rebuildTipsTxt(zhLangRoot)
  await pack(zhLangRoot, tipsTxt)
}

void main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[restore-and-pack] failed:', err)
  process.exit(1)
})
