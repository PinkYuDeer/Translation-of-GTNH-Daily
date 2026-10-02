import { expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { stripLineBreakContext } from '../lib/newlines.ts'

test('missing reviewed source preserves our translations and handles English drift', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gtnh-merge-without-source-test-'))
  try {
    for (const dir of ['en', 'zh-current', 'zh-4964'])
      await mkdir(join(root, dir))
    const en = [
      { key: 'unchanged', original: 'Same English' },
      { key: 'drift', original: 'New English' },
      { key: 'new', original: 'New untranslated entry' },
    ]
    const current = [
      { key: 'unchanged', original: 'Same English', translation: '自己的校对译文', stage: 5, context: 'Keep this context' },
      { key: 'drift', original: 'Old English', translation: '自己的旧译', stage: 5 },
    ]
    await writeFile(join(root, 'en', 'GregTech.lang.en.json'), JSON.stringify(en))
    await writeFile(join(root, 'zh-current', 'GregTech.lang.json'), JSON.stringify(current))
    const script = fileURLToPath(new URL('../merge-final.ts', import.meta.url))
    const result = spawnSync(process.execPath, [script], {
      env: { ...process.env, BUILD_DIR: root, CACHE_DIR: join(root, 'cache'), PARATRANZ_TOKEN: '' },
      encoding: 'utf8',
      timeout: 30_000,
    })
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0)
    const final = JSON.parse(await readFile(join(root, 'zh-final', 'GregTech.lang.json'), 'utf8'))
    expect({ ...final[0], context: stripLineBreakContext(final[0].context) }).toMatchObject(current[0])
    expect(final[1]).toMatchObject({ key: 'drift', original: 'New English', translation: 'New English\n旧译：\n自己的旧译', stage: 0 })
    expect(final[2]).toMatchObject({ key: 'new', translation: '', stage: 0 })
    const plan = JSON.parse(await readFile(join(root, 'merge-plan.json'), 'utf8'))
    expect(plan.archive).toEqual([])
    expect(plan.archiveStrings).toEqual({})
  }
  finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('malformed current snapshot fails before any push plan can be produced', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gtnh-merge-invalid-snapshot-test-'))
  try {
    for (const dir of ['en', 'zh-current', 'zh-4964'])
      await mkdir(join(root, dir))
    await writeFile(join(root, 'en', 'GregTech.lang.en.json'), JSON.stringify([
      { key: 'existing', original: 'Same English' },
    ]))
    await writeFile(join(root, 'zh-current', 'GregTech.lang.json'), '{}')
    const script = fileURLToPath(new URL('../merge-final.ts', import.meta.url))
    const result = spawnSync(process.execPath, [script], {
      env: { ...process.env, BUILD_DIR: root, CACHE_DIR: join(root, 'cache'), PARATRANZ_TOKEN: '' },
      encoding: 'utf8',
      timeout: 30_000,
    })
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('Invalid translation snapshot')
    expect(existsSync(join(root, 'merge-plan.json'))).toBe(false)
  }
  finally {
    await rm(root, { recursive: true, force: true })
  }
})
