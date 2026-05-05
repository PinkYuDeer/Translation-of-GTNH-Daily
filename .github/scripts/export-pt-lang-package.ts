/**
 * Build a browser-importable PT language package from our ParaTranz project.
 *
 * Output layout under $PT_LANG_PACKAGE_DIR:
 *   - pt-lang-package.json
 *   - files/<pack path>/en_US.lang
 *   - files/<pack path>/zh_CN.lang
 *
 * The manifest is the authoritative source for the userscript importer. The
 * .lang files are included so the package can still be inspected manually.
 */

import { mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { BUILD_DIR, PT_18818_ID, assertToken } from './daily/lib/config.ts'
import { listFileStrings, listProjectFiles, runBounded } from './daily/lib/pt-client.ts'
import { stripPtJsonSuffix } from './daily/lib/path-map.ts'

interface PackageEntry {
  key: string
  original: string
  translation: string
  stage: number
}

interface PackageFile {
  ptPath: string
  packZhPath: string
  packEnPath: string
  aliases: string[]
  entries: PackageEntry[]
}

interface PackageManifest {
  version: 1
  createdAt: string
  projectId: string
  files: PackageFile[]
}

const OUT_DIR = process.env.PT_LANG_PACKAGE_DIR ?? join(BUILD_DIR, 'pt-lang-package')

function normalizePath(path: string): string {
  return path.replaceAll('\\', '/').replace(/^\/+/, '')
}

function packZhPath(ptPath: string): string {
  if (ptPath === 'GregTech.lang')
    return 'GregTech_zh_CN.lang'
  return ptPath
}

function packEnPath(ptPath: string): string {
  if (ptPath === 'GregTech.lang')
    return 'GregTech_US.lang'
  if (ptPath.endsWith('zh_CN.lang'))
    return ptPath.replace(/zh_CN\.lang$/, 'en_US.lang')
  return `${ptPath}.en_US.lang`
}

function displayAndModIdFromPath(path: string): Array<string | undefined> {
  const seg = path.match(/(?:resources|config\/txloader\/(?:load|forceload))\/([^/]+)\/lang\//)?.[1]
  if (!seg)
    return []
  const bracket = seg.match(/^(.*?)\[([^\]]+)\]$/)
  if (!bracket)
    return [seg]
  return [bracket[1], bracket[2]]
}

function isGregTechFamily(path: string): boolean {
  if (path === 'GregTech.lang')
    return true
  const seg = path.match(/(?:resources|config\/txloader\/(?:load|forceload))\/([^/]+)\/lang\//)?.[1] ?? ''
  return /^(?:GregTech|GTNH|GT_)/i.test(seg)
}

function aliasesFor(ptPath: string): string[] {
  const aliases = new Set<string>()
  const normalized = normalizePath(stripPtJsonSuffix(ptPath))
  aliases.add(normalized.toLowerCase())
  aliases.add(packZhPath(normalized).toLowerCase())
  aliases.add(packEnPath(normalized).toLowerCase())
  for (const part of displayAndModIdFromPath(normalized)) {
    if (part && part.trim())
      aliases.add(`module:${part.trim().toLowerCase()}`)
  }
  if (isGregTechFamily(normalized))
    aliases.add('gregtech:shared')
  return [...aliases]
}

function langLineValue(value: string): string {
  return value.replace(/\r\n?/g, '\n').replace(/\n/g, '\\n')
}

function serializeLang(entries: PackageEntry[], side: 'en' | 'zh'): string {
  const lines: string[] = []
  for (const entry of entries) {
    const value = side === 'en' ? entry.original : entry.translation
    if (value.length === 0)
      continue
    lines.push(`${entry.key}=${langLineValue(value)}`)
  }
  return `${lines.join('\n')}\n`
}

async function writePackageFile(file: PackageFile): Promise<void> {
  const zhOut = join(OUT_DIR, 'files', file.packZhPath)
  const enOut = join(OUT_DIR, 'files', file.packEnPath)
  await mkdir(dirname(zhOut), { recursive: true })
  await mkdir(dirname(enOut), { recursive: true })
  await writeFile(zhOut, serializeLang(file.entries, 'zh'), 'utf8')
  await writeFile(enOut, serializeLang(file.entries, 'en'), 'utf8')
}

async function main(): Promise<void> {
  assertToken()
  await rm(OUT_DIR, { recursive: true, force: true })
  await mkdir(OUT_DIR, { recursive: true })

  const remoteFiles = await listProjectFiles(PT_18818_ID)
  const tasks = remoteFiles.map(file => async (): Promise<PackageFile> => {
    const ptPath = normalizePath(stripPtJsonSuffix(file.name))
    const rows = await listFileStrings(PT_18818_ID, file.id)
    const entries = rows.map(row => ({
      key: row.key,
      original: row.original ?? '',
      translation: row.translation ?? '',
      stage: row.stage ?? 0,
    }))
    return {
      ptPath,
      packZhPath: packZhPath(ptPath),
      packEnPath: packEnPath(ptPath),
      aliases: aliasesFor(ptPath),
      entries,
    }
  })

  const { results, failures } = await runBounded(tasks, 5, {
    onSettled: ({ completed, total, failures, result }) => {
      if (completed === 1 || completed === total || completed % 25 === 0 || result instanceof Error)
        // eslint-disable-next-line no-console
        console.log(`[pt-lang-package] progress ${completed}/${total} files (fail=${failures})`)
    },
  })
  if (failures > 0) {
    const first = results.find(result => result instanceof Error)
    throw first instanceof Error ? first : new Error('failed to export PT language package')
  }

  const files = (results as PackageFile[]).sort((a, b) => a.ptPath.localeCompare(b.ptPath))
  for (const file of files)
    await writePackageFile(file)

  const manifest: PackageManifest = {
    version: 1,
    createdAt: new Date().toISOString(),
    projectId: PT_18818_ID,
    files,
  }
  await writeFile(join(OUT_DIR, 'pt-lang-package.json'), `${JSON.stringify(manifest)}\n`, 'utf8')

  const entryCount = files.reduce((sum, file) => sum + file.entries.length, 0)
  // eslint-disable-next-line no-console
  console.log(`[pt-lang-package] wrote ${OUT_DIR}: ${files.length} files / ${entryCount} rows`)
}

void main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[pt-lang-package] failed:', err)
  process.exit(1)
})
