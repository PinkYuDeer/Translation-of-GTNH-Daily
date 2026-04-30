/**
 * Step 1 — fetch-en.
 *
 * Pull English sources from three upstreams, dedupe into a single tree keyed
 * by PT 18818 path, sniff newline placeholders (saved to cache for later
 * restoration), normalize values to real `\n`, and write each file as a PT-
 * shaped JSON skeleton into `.build/en/`.
 *
 * Required pre-source:
 *   - .build/generated-gregtech/GregTech.lang (generated from latest GT5U)
 *
 * Upstreams (all sparse-cloned to `.repo.cache/<name>`):
 *   - GTNewHorizons/GTNH-Translations@master  (daily-history)
 *   - GTNewHorizons/GT-New-Horizons-Modpack@master  (config)
 *   - Kiwi233/Translation-of-GTNH@master  (tips + direct-pack extras cache)
 *
 * Source coverage — see PLAN.md §3.1 for the authoritative table. Each case
 * below is commented with its source letter.
 *
 * Dedup rule: generated GT5U GregTech.lang wins for GregTech.lang. Otherwise,
 * if the same PT-18818 path is produced by both daily-history and Modpack,
 * daily-history wins. F (amazingtrophies /config/ copy) and G (tips) never
 * collide with anything else.
 */

import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readFile, readdir, rm } from 'node:fs/promises'
import { dirname, join, relative, sep } from 'node:path'

import { BUILD_DIR, REPO_CACHE_DIR, UPSTREAM } from './lib/config.ts'
import { writeJson, readNewlines, writeNewlines, type NewlineForm } from './lib/cache.ts'
import { parseLang, langToPtItems, type PtStringItem } from './lib/lang-parser.ts'
import { parseTipsLines, tipsToEntries } from './lib/tips-parser.ts'
import { normalizeNewlines, sniffNewline } from './lib/newlines.ts'
import { rewriteTargetRelpath, stripVersionSuffix } from './lib/path-map.ts'

const GENERATED_GREGTECH_LANG = join(BUILD_DIR, 'generated-gregtech', 'GregTech.lang')

interface FetchedFile {
  /** PT-18818 path (keys into .build/en, cache, everything downstream). */
  ptPath: string
  /** Source letter (A–G) for diagnostics. */
  source: string
  entries: PtStringItem[]
}

/** Run a shell command, throw on non-zero. */
function run(cmd: string, args: string[], cwd?: string): void {
  const r = spawnSync(cmd, args, { cwd, stdio: 'inherit', shell: false })
  if (r.status !== 0)
    throw new Error(`${cmd} ${args.join(' ')} failed (exit ${r.status})`)
}

/**
 * Sparse-clone a GitHub repo to `.repo.cache/<slug>`. Idempotent: if the
 * directory already exists we just `git fetch` + reset, which keeps CI cache
 * restores cheap.
 */
function sparseClone(slug: string, spec: { repo: string, ref: string, sparse: readonly string[] }): string {
  const dest = join(REPO_CACHE_DIR, slug)
  const url = `https://github.com/${spec.repo}.git`
  if (!existsSync(join(dest, '.git'))) {
    run('git', ['clone', '--filter=blob:none', '--no-checkout', '--depth=1', '--branch', spec.ref, url, dest])
    run('git', ['sparse-checkout', 'init', '--cone'], dest)
    run('git', ['sparse-checkout', 'set', ...spec.sparse], dest)
    run('git', ['checkout', spec.ref], dest)
  }
  else {
    run('git', ['fetch', '--depth=1', 'origin', spec.ref], dest)
    run('git', ['sparse-checkout', 'set', ...spec.sparse], dest)
    run('git', ['reset', '--hard', `origin/${spec.ref}`], dest)
  }
  return dest
}

/** Walk a directory recursively, yielding absolute file paths. */
async function* walk(dir: string): AsyncGenerator<string> {
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
      yield* walk(p)
    else if (e.isFile())
      yield p
  }
}

/** Normalize every path to forward-slashes so PT-path comparisons are stable on Windows. */
function toPosix(p: string): string {
  return p.split(sep).join('/')
}

/** Translate a daily-history relpath into its PT-18818 path. */
function dailyHistoryToPtPath(rel: string): string | undefined {
  // A: GregTech.lang at the root of daily-history
  if (rel === 'GregTech.lang')
    return 'GregTech.lang'
  // B: resources/<Display>[<id>]/lang/en_US.lang → forceload
  if (rel.startsWith('resources/'))
    return rewriteTargetRelpath(rel).replace(/en_US\.lang$/, 'zh_CN.lang')
  // C: config/txloader/load/<id>/lang/en_US.lang → zh_CN.lang
  if (rel.startsWith('config/txloader/load/'))
    return rel.replace(/en_US\.lang$/, 'zh_CN.lang')
  return undefined
}

/** Translate a Modpack-config relpath into its PT-18818 path. */
function modpackToPtPath(rel: string): string | undefined {
  // D: config/txloader/forceload/**/en_US.lang
  if (rel.startsWith('config/txloader/forceload/') && rel.endsWith('/en_US.lang'))
    return rel.replace(/en_US\.lang$/, 'zh_CN.lang')
  // E: config/txloader/load/**/en_US.lang
  if (rel.startsWith('config/txloader/load/') && rel.endsWith('/en_US.lang'))
    return rel.replace(/en_US\.lang$/, 'zh_CN.lang')
  // F: config/amazingtrophies/lang/en_US.lang (root copy, NOT the load/ one)
  if (rel === 'config/amazingtrophies/lang/en_US.lang')
    return 'config/amazingtrophies/lang/zh_CN.lang'
  return undefined
}

/**
 * Per-file processing: parse the `.lang` text, sniff per-entry newline form,
 * normalize values to real `\n`. Returns the PT-skeleton items plus the sniffed
 * newline map; the caller decides which pt-path key they bind to (so we can
 * canonicalize paths before recording).
 */
function processLangFile(
  content: string,
): { items: PtStringItem[], perFile: Record<string, NewlineForm> } {
  const entries = parseLang(content)
  const items: PtStringItem[] = []
  const perFile: Record<string, NewlineForm> = {}
  for (const e of entries) {
    if (e.key.length === 0)
      continue
    const normalized = normalizeNewlines(e.value)
    if (normalized.trim().length === 0)
      continue
    const form = sniffNewline(e.value)
    if (form)
      perFile[e.key] = form
    items.push({
      key: e.key,
      original: normalized,
      translation: '',
      stage: 0,
    })
  }
  return { items, perFile }
}

/**
 * Tips get a synthetic `tip.0001 …` key layout. Newline sniffing does not
 * apply — each tip line is a standalone value.
 */
function processTipsFile(content: string): PtStringItem[] {
  // en_US.txt's first 7 lines are the upstream comment block; content starts
  // at line 8. Chinese shifts this by 1 (line 8 is the PT feedback notice);
  // see pull-zh-4964's buildTipsFrom4964Kiwi for the zh side.
  const lines = parseTipsLines(content, 8)
  const entries = tipsToEntries(lines)
  return langToPtItems(entries)
}

/**
 * Merge a new set of entries into an already-collected file. Entries are deduped
 * by key (first-wins); newline forms are likewise merged first-wins. Used when
 * two upstream paths canonicalize to the same pt-path (e.g. `(+16)` variants).
 */
function mergeInto(
  existing: FetchedFile,
  newItems: PtStringItem[],
  newlinesMap: Record<string, Record<string, NewlineForm>>,
  perFileIncoming: Record<string, NewlineForm> | undefined,
): void {
  const byKey = new Map(existing.entries.map(e => [e.key, e]))
  for (const item of newItems) {
    if (!byKey.has(item.key))
      byKey.set(item.key, item)
  }
  existing.entries = [...byKey.values()]
  if (perFileIncoming) {
    const merged = { ...perFileIncoming, ...(newlinesMap[existing.ptPath] ?? {}) }
    newlinesMap[existing.ptPath] = merged
  }
}

async function main(): Promise<void> {
  await mkdir(REPO_CACHE_DIR, { recursive: true })
  const translationsRoot = sparseClone('translations', UPSTREAM.translations)
  const modpackRoot = sparseClone('modpack', UPSTREAM.modpack)
  sparseClone('kiwi', UPSTREAM.kiwi) // used by pull-zh-4964, but clone here so CI caches it once

  const collected = new Map<string, FetchedFile>()
  const newlinesMap: Record<string, Record<string, NewlineForm>> = {}

  // -------- A0: runtime-generated GT5U GregTech.lang. This is required:
  // daily-history/GregTech.lang is a manually uploaded snapshot and can be far
  // larger than the optimized runtime language file.
  if (!existsSync(GENERATED_GREGTECH_LANG))
    throw new Error(`missing generated GregTech.lang at ${GENERATED_GREGTECH_LANG}`)

  const generatedGregTech = await readFile(GENERATED_GREGTECH_LANG, 'utf8')
  const generatedGregTechProcessed = processLangFile(generatedGregTech)
  collected.set('GregTech.lang', {
    ptPath: 'GregTech.lang',
    source: 'A0',
    entries: generatedGregTechProcessed.items,
  })
  if (Object.keys(generatedGregTechProcessed.perFile).length > 0)
    newlinesMap['GregTech.lang'] = generatedGregTechProcessed.perFile
  // eslint-disable-next-line no-console
  console.log(`[fetch-en] using generated GT5U GregTech.lang (${generatedGregTechProcessed.items.length} entries)`)

  // -------- daily-history (sources A–C) --------
  const dailyRoot = join(translationsRoot, 'daily-history')
  for await (const abs of walk(dailyRoot)) {
    const rel = toPosix(relative(dailyRoot, abs))
    // We only ingest en_US.lang. GregTech.lang is generated from GT5U above;
    // never fall back to the manually uploaded daily-history copy.
    if (rel !== 'GregTech.lang' && !rel.endsWith('/en_US.lang'))
      continue
    if (rel === 'GregTech.lang')
      continue
    const raw = dailyHistoryToPtPath(rel)
    if (!raw)
      continue
    // Strip `(+N)` version markers so e.g. `GregTech(+16)[bartworks]` collapses
    // into `GregTech[bartworks]`. If two variants canonicalize to the same
    // path, their entries are merged (first-wins on key conflicts).
    const ptPath = stripVersionSuffix(raw)
    const content = await readFile(abs, 'utf8')
    const { items, perFile } = processLangFile(content)
    const source = rel === 'GregTech.lang' ? 'A' : rel.startsWith('resources/') ? 'B' : 'C'
    const existing = collected.get(ptPath)
    if (existing) {
      mergeInto(existing, items, newlinesMap, perFile)
    }
    else {
      collected.set(ptPath, { ptPath, source, entries: items })
      if (Object.keys(perFile).length > 0)
        newlinesMap[ptPath] = perFile
    }
  }

  // -------- Modpack (sources D–F), deduped against daily-history --------
  const modpackConfig = join(modpackRoot, 'config')
  for await (const abs of walk(modpackConfig)) {
    const rel = toPosix(`config/${relative(modpackConfig, abs)}`)
    if (!rel.endsWith('.lang'))
      continue
    const raw = modpackToPtPath(rel)
    if (!raw)
      continue
    const ptPath = stripVersionSuffix(raw)
    if (collected.has(ptPath))
      continue // daily-history wins
    const content = await readFile(abs, 'utf8')
    const { items, perFile } = processLangFile(content)
    const source = rel.startsWith('config/txloader/forceload/')
      ? 'D'
      : rel === 'config/amazingtrophies/lang/en_US.lang'
        ? 'F'
        : 'E'
    collected.set(ptPath, { ptPath, source, entries: items })
    if (Object.keys(perFile).length > 0)
      newlinesMap[ptPath] = perFile
  }

  // -------- G: tips synthesised as a PT file --------
  const tipsFile = join(modpackRoot, 'config/Betterloadingscreen/tips/en_US.txt')
  if (existsSync(tipsFile)) {
    const ptPath = 'config/Betterloadingscreen/tips/zh_CN.lang'
    const items = processTipsFile(await readFile(tipsFile, 'utf8'))
    collected.set(ptPath, { ptPath, source: 'G', entries: items })
  }

  // -------- Write .build/en --------
  const outRoot = join(BUILD_DIR, 'en')
  await rm(outRoot, { recursive: true, force: true })
  for (const f of collected.values()) {
    const outPath = join(outRoot, `${f.ptPath}.en.json`)
    await mkdir(dirname(outPath), { recursive: true })
    await writeJson(outPath, f.entries)
  }

  // -------- Newlines cache (merge into the existing map, don't drop earlier keys) --------
  const existing = await readNewlines()
  for (const [ptPath, perFile] of Object.entries(newlinesMap))
    existing[ptPath] = perFile
  await writeNewlines(existing)

  // eslint-disable-next-line no-console
  console.log(`[fetch-en] ${collected.size} files → ${outRoot}`)
  const bySrc = new Map<string, number>()
  for (const f of collected.values()) bySrc.set(f.source, (bySrc.get(f.source) ?? 0) + 1)
  // eslint-disable-next-line no-console
  console.log(`[fetch-en] per-source: ${[...bySrc.entries()].map(([k, v]) => `${k}=${v}`).join(' ')}`)
}

void main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[fetch-en] failed:', err)
  process.exit(1)
})
