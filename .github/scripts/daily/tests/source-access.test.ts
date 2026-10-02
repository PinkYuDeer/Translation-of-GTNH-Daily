import { afterEach, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { PtHttpError } from '../lib/pt-client.ts'
import { pullReviewedSource } from '../lib/source-access.ts'

const temporaryRoots: string[] = []
afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function fixture(): Promise<{ root: string, out: string }> {
  const root = await mkdtemp(join(tmpdir(), 'gtnh-source-access-test-'))
  temporaryRoots.push(root)
  const out = join(root, 'zh-4964')
  await mkdir(out)
  await writeFile(join(out, 'previous.json'), 'previous snapshot')
  return { root, out }
}

test('complete source atomically replaces the previous snapshot', async () => {
  const { root, out } = await fixture()
  const available = await pullReviewedSource(out, async stage => {
    await writeFile(join(stage, 'fresh.json'), 'complete snapshot')
    expect(await readFile(join(out, 'previous.json'), 'utf8')).toBe('previous snapshot')
  }, { required: false, onUnavailable: async () => { throw new Error('unexpected degradation') } })
  expect(available).toBe(true)
  expect(await readdir(out)).toEqual(['fresh.json'])
  expect(await readdir(root)).toEqual(['zh-4964'])
})

test('source 403 discards both partial data and the previous snapshot', async () => {
  const { root, out } = await fixture()
  let warnings = 0
  const available = await pullReviewedSource(out, async stage => {
    await writeFile(join(stage, 'partial.json'), 'partial snapshot')
    throw new PtHttpError(403, 'source project denied')
  }, { required: false, onUnavailable: async error => {
    expect(error.status).toBe(403)
    warnings++
  } })
  expect(available).toBe(false)
  expect(warnings).toBe(1)
  expect(await readdir(out)).toEqual([])
  expect(await readdir(root)).toEqual(['zh-4964'])
})

test('strict mode fails on source 403 and never publishes partial data', async () => {
  const { root, out } = await fixture()
  await expect(pullReviewedSource(out, async stage => {
    await writeFile(join(stage, 'partial.json'), 'partial snapshot')
    throw new PtHttpError(403, 'strict source denied')
  }, { required: true, onUnavailable: async () => { throw new Error('must not degrade') } }))
    .rejects.toThrow('strict source denied')
  expect(await readdir(root)).toEqual(['zh-4964'])
  expect(existsSync(join(out, 'partial.json'))).toBe(false)
})

for (const error of [
  new PtHttpError(401, 'invalid token'),
  new PtHttpError(500, 'server outage'),
  new Error('invalid artifact JSON'),
]) {
  test(`${error.message} stays fatal even when source is optional`, async () => {
    const { root, out } = await fixture()
    await expect(pullReviewedSource(out, async () => { throw error }, {
      required: false,
      onUnavailable: async () => { throw new Error('must not degrade') },
    })).rejects.toThrow(error.message)
    expect(await readdir(root)).toEqual(['zh-4964'])
  })
}
