/**
 * Cache I/O for the daily pipeline.
 *
 * Everything lives under `$CACHE_DIR` (default `.cache/`) and is persisted
 * across runs via GitHub Actions' actions/cache. Each cache "kind" below is a
 * single file or a per-pt-path tree of files — see `CACHE_PATHS` in config.ts
 * for the canonical layout.
 *
 * All readers tolerate a missing cache (cold-start case): they return `{}` /
 * an empty Map rather than throwing, so first-run daily builds "just work"
 * without manual seeding.
 */

import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { CACHE_DIR, CACHE_PATHS } from './config.ts'
import type { PtStringItem } from './lang-parser.ts'

export async function readJson<T>(absPath: string): Promise<T | undefined> {
  if (!existsSync(absPath))
    return undefined
  const raw = await readFile(absPath, 'utf8')
  return JSON.parse(raw) as T
}

export async function writeJson(absPath: string, data: unknown): Promise<void> {
  await mkdir(dirname(absPath), { recursive: true })
  await writeFile(absPath, `${JSON.stringify(data, null, 2)}\n`, 'utf8')
}

/** `<cache>/en-lastrun/<ptPath>.en.json` */
function enLastrunFile(ptPath: string): string {
  return join(CACHE_DIR, CACHE_PATHS.enLastrun, `${ptPath}.en.json`)
}

/** `<cache>/zh-lastrun/<ptPath>.zh.json` */
function zhLastrunFile(ptPath: string): string {
  return join(CACHE_DIR, CACHE_PATHS.zhLastrun, `${ptPath}.zh.json`)
}

/** `<cache>/file-ids/<ptPath>.strings.json` */
function stringIdsFile(ptPath: string): string {
  return join(CACHE_DIR, CACHE_PATHS.stringIdsDir, `${ptPath}.strings.json`)
}

export async function readEnLastrun(ptPath: string): Promise<PtStringItem[] | undefined> {
  return readJson<PtStringItem[]>(enLastrunFile(ptPath))
}

export async function writeEnLastrun(ptPath: string, items: PtStringItem[]): Promise<void> {
  await writeJson(enLastrunFile(ptPath), items)
}

export async function deleteEnLastrun(ptPath: string): Promise<void> {
  await rm(enLastrunFile(ptPath), { force: true })
}

export async function readZhLastrun(ptPath: string): Promise<PtStringItem[] | undefined> {
  return readJson<PtStringItem[]>(zhLastrunFile(ptPath))
}

export async function writeZhLastrun(ptPath: string, items: PtStringItem[]): Promise<void> {
  await writeJson(zhLastrunFile(ptPath), items)
}

export async function deleteZhLastrun(ptPath: string): Promise<void> {
  await rm(zhLastrunFile(ptPath), { force: true })
}

/** `{ptPath: fileId}` – maps PT file name to its numeric id on 18818. */
export async function readFileIds(): Promise<Record<string, number>> {
  return (await readJson<Record<string, number>>(join(CACHE_DIR, CACHE_PATHS.fileIds))) ?? {}
}

export async function writeFileIds(map: Record<string, number>): Promise<void> {
  await writeJson(join(CACHE_DIR, CACHE_PATHS.fileIds), map)
}

/** `{key: stringId}` – maps entry key within one file to its PT string id. */
export async function readStringIds(ptPath: string): Promise<Record<string, number>> {
  return (await readJson<Record<string, number>>(stringIdsFile(ptPath))) ?? {}
}

export async function writeStringIds(ptPath: string, map: Record<string, number>): Promise<void> {
  await writeJson(stringIdsFile(ptPath), map)
}

export async function deleteStringIds(ptPath: string): Promise<void> {
  await rm(stringIdsFile(ptPath), { force: true })
}

export type NewlineForm = '<BR>' | '<br>' | '\\n' | '\\\\n' | '%n'

export interface NewlineFileForms {
  /** Most frequent placeholder form in this file, used when a key has no exact entry hit. */
  default?: NewlineForm
  /** Exact per-entry placeholder forms keyed by translation key. */
  entries: Record<string, NewlineForm>
}

export type NewlinesCache = Record<string, NewlineFileForms>

function isNewlineForm(value: unknown): value is NewlineForm {
  return value === '<BR>'
    || value === '<br>'
    || value === '\\n'
    || value === '\\\\n'
    || value === '%n'
}

function mostFrequentNewlineForm(entries: Record<string, NewlineForm>): NewlineForm | undefined {
  let defaultForm: NewlineForm | undefined
  let defaultCount = 0
  const counts = new Map<NewlineForm, number>()
  for (const form of Object.values(entries)) {
    const count = (counts.get(form) ?? 0) + 1
    counts.set(form, count)
    if (count > defaultCount) {
      defaultForm = form
      defaultCount = count
    }
  }
  return defaultForm
}

function normalizeNewlineFileForms(value: unknown): NewlineFileForms {
  if (value && typeof value === 'object' && 'entries' in value) {
    const raw = value as { default?: unknown, entries?: unknown }
    const entries: Record<string, NewlineForm> = {}
    if (raw.entries && typeof raw.entries === 'object') {
      for (const [key, form] of Object.entries(raw.entries)) {
        if (isNewlineForm(form))
          entries[key] = form
      }
    }
    const defaultForm = isNewlineForm(raw.default)
      ? raw.default
      : mostFrequentNewlineForm(entries)
    return {
      ...(defaultForm != null ? { default: defaultForm } : {}),
      entries,
    }
  }

  const entries: Record<string, NewlineForm> = {}
  if (value && typeof value === 'object') {
    for (const [key, form] of Object.entries(value)) {
      if (isNewlineForm(form))
        entries[key] = form
    }
  }
  const defaultForm = mostFrequentNewlineForm(entries)
  return {
    ...(defaultForm != null ? { default: defaultForm } : {}),
    entries,
  }
}

/** `{ptPath: {default?: form, entries: {key: form}}}` – per-file and per-entry newline placeholders. */
export async function readNewlines(): Promise<NewlinesCache> {
  const raw = await readJson<Record<string, unknown>>(join(CACHE_DIR, CACHE_PATHS.newlines))
  if (raw == null)
    return {}

  const out: NewlinesCache = {}
  for (const [ptPath, value] of Object.entries(raw))
    out[ptPath] = normalizeNewlineFileForms(value)
  return out
}

export async function writeNewlines(
  map: NewlinesCache,
): Promise<void> {
  await writeJson(join(CACHE_DIR, CACHE_PATHS.newlines), map)
}

export function resolveNewlineForm(
  forms: NewlineFileForms | undefined,
  key: string,
): NewlineForm | undefined {
  return forms?.entries[key] ?? forms?.default
}

export interface PendingUpdateEntry {
  oldOriginal: string
  newOriginal: string
}

/**
 * `{ptPath: {key: {oldOriginal, newOriginal}}}` – records English keys whose
 * source text changed this run, so push-zh can decide whether to emit a
 * "stale translation" marker.
 */
export async function readPendingUpdate(): Promise<
  Record<string, Record<string, PendingUpdateEntry>>
> {
  return (await readJson<Record<string, Record<string, PendingUpdateEntry>>>(
    join(CACHE_DIR, CACHE_PATHS.pendingUpdate),
  )) ?? {}
}

export async function writePendingUpdate(
  map: Record<string, Record<string, PendingUpdateEntry>>,
): Promise<void> {
  await writeJson(join(CACHE_DIR, CACHE_PATHS.pendingUpdate), map)
}

/** Helper: ensure a directory exists. */
export async function ensureDir(absPath: string): Promise<void> {
  await mkdir(absPath, { recursive: true })
}
