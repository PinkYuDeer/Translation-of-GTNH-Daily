/**
 * Build a browser-importable PT language package from our ParaTranz project.
 *
 * Output layout under $PT_LANG_PACKAGE_DIR:
 * - GregTech_US.lang
 * - GregTech_zh_CN.lang
 * - resources/<mod>/lang/en_US.lang
 * - resources/<mod>/lang/zh_CN.lang
 * - config/txloader/<load|forceload>/<mod>/lang/en_US.lang
 * - config/txloader/<load|forceload>/<mod>/lang/zh_CN.lang
 *
 * There is intentionally no pt-lang-package.json manifest and no top-level
 * files/ directory. The userscript importer should parse .lang file pairs
 * directly by path and key.
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
  entries: PackageEntry[]
}

const OUT_DIR = process.env.PT_LANG_PACKAGE_DIR ?? join(BUILD_DIR, 'pt-lang-package')

function normalizePath(path: string): string {
  return path.replaceAll('\\', '/').replace(/^\/+/, '')
}

function packZhPath(ptPath: string): string {
  if (ptPath === 'GregTech.lang') return 'GregTech_zh_CN.lang'
  return ptPath
}

function packEnPath(ptPath: string): string {
  if (ptPath === 'GregTech.lang') return 'GregTech_US.lang'
  if (ptPath.endsWith('zh_CN.lang')) return ptPath.replace(/zh_CN\.lang$/, 'en_US.lang')
  return `${ptPath}.en_US.lang`
}

function langLineValue(value: string): string {
  return value.replace(/\r\n?/g, '\n').replace(/\n/g, '\\n')
}

function serializeLang(entries: PackageEntry[], side: 'en' | 'zh'): string {
  const lines: string[] = []

  for (const entry of entries) {
    const value = side === 'en' ? entry.original : entry.translation
    if (value.length === 0) continue
    lines.push(`${entry.key}=${langLineValue(value)}`)
  }

  return `${lines.join('\n')}\n`
}

async function writePackageFile(file: PackageFile): Promise<void> {
  const zhOut = join(OUT_DIR, file.packZhPath)
  const enOut = join(OUT_DIR, file.packEnPath)

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
      entries,
    }
  })

  const { results, failures } = await runBounded(tasks, 5, {
    onSettled: ({ completed, total, failures, result }) => {
      if (completed === 1 || completed === total || completed % 25 === 0 || result instanceof Error) {
        // eslint-disable-next-line no-console
        console.log(`[pt-lang-package] progress ${completed}/${total} files (fail=${failures})`)
      }
    },
  })

  if (failures > 0) {
    const first = results.find(result => result instanceof Error)
    throw first instanceof Error ? first : new Error('failed to export PT language package')
  }

  const files = (results as PackageFile[]).sort((a, b) => a.ptPath.localeCompare(b.ptPath))
  for (const file of files) await writePackageFile(file)

  const rowCount = files.reduce((sum, file) => sum + file.entries.length, 0)
  const langFileCount = files.length * 2

  // eslint-disable-next-line no-console
  console.log(`[pt-lang-package] wrote pure lang package ${OUT_DIR}: ${files.length} PT files / ${langFileCount} lang files / ${rowCount} rows`)
}

void main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[pt-lang-package] failed:', err)
  process.exit(1)
})
