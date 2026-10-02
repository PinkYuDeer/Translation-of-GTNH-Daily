import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import {
  apiGet,
  fetchAllPages,
  listFileTranslations,
  listProjectFiles,
  listProjectTerms,
  PtHttpError,
} from '../lib/pt-client.ts'
import { syncTerms } from '../sync-terms.ts'

interface RecordedRequest {
  method: string
  path: string
}

const originalFetch = globalThis.fetch
const savedEnv = {
  required: process.env.PT_4964_REQUIRED,
  summary: process.env.GITHUB_STEP_SUMMARY,
}
let requests: RecordedRequest[] = []

beforeEach(() => {
  requests = []
  delete process.env.PT_4964_REQUIRED
  delete process.env.GITHUB_STEP_SUMMARY
})

afterEach(() => {
  globalThis.fetch = originalFetch
  for (const [name, value] of [
    ['PT_4964_REQUIRED', savedEnv.required],
    ['GITHUB_STEP_SUMMARY', savedEnv.summary],
  ] as const) {
    if (value === undefined)
      delete process.env[name]
    else
      process.env[name] = value
  }
})

function mockFetch(reply: (request: RecordedRequest) => Response): void {
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    const request = {
      method: init?.method ?? (input instanceof Request ? input.method : 'GET'),
      path: url.pathname.replace(/^\/api/, '') + url.search,
    }
    requests.push(request)
    return reply(request)
  }) as typeof fetch
}

function denied(): Response {
  return new Response('Access denied', { status: 403, statusText: 'Forbidden' })
}

function mutationRequests(): RecordedRequest[] {
  return requests.filter(request => request.method !== 'GET')
}

const targetTerms = [{ id: 42, term: 'Retained term', translation: '保留术语' }]

function mockTerms(options: { source?: unknown, sourceDenied?: boolean, targetDenied?: boolean }): void {
  mockFetch((request) => {
    if (request.method !== 'GET')
      return Response.json({})
    if (request.path === '/projects/20315/terms')
      return options.targetDenied ? denied() : Response.json(targetTerms)
    if (request.path === '/projects/4964/terms')
      return options.sourceDenied ? denied() : Response.json(options.source ?? [])
    return new Response('Unexpected mocked request', { status: 404 })
  })
}

describe.serial('ParaTranz response validation', () => {
  test('HTTP failures retain their status without retrying denied access', async () => {
    mockFetch(() => denied())
    const error = await apiGet('/projects/4964/terms').catch(error => error)
    expect(error).toBeInstanceOf(PtHttpError)
    if (!(error instanceof PtHttpError))
      throw new Error('Expected a PtHttpError from denied access')
    expect(error.status).toBe(403)
    expect(error.message).toContain('/projects/4964/terms')
    expect(requests).toHaveLength(1)
  })

  const invalidLists = [{}, null, { results: null }, { results: {} }]

  test.each(invalidLists)('file lists reject malformed responses: %j', async (data) => {
    mockFetch(() => Response.json(data))
    await expect(listProjectFiles('20315')).rejects.toThrow('Invalid file list')
  })

  test.each(invalidLists)('translation exports reject malformed responses: %j', async (data) => {
    mockFetch(() => Response.json(data))
    await expect(listFileTranslations('20315', 42)).rejects.toThrow('Invalid translations')
  })

  test.each(invalidLists)('term lists reject malformed responses: %j', async (data) => {
    mockFetch(() => Response.json(data))
    await expect(listProjectTerms('4964')).rejects.toThrow('Invalid term list')
  })

  test.each(invalidLists)('pagination rejects malformed first pages: %j', async (data) => {
    await expect(fetchAllPages(async () => data as { results?: unknown[] }))
      .rejects.toThrow('Invalid ParaTranz paginated response on page 1')
  })

  test('pagination rejects a malformed later page instead of returning a partial list', async () => {
    const pages: number[] = []
    await expect(fetchAllPages(async (page) => {
      pages.push(page)
      return page === 1 ? { results: [{ id: 42 }], pageCount: 2 } : {}
    })).rejects.toThrow('Invalid ParaTranz paginated response on page 2')
    expect(pages).toEqual([1, 2])
  })

  test('valid empty responses are distinct from malformed responses', async () => {
    mockFetch(() => Response.json([]))
    expect(await listProjectFiles('20315')).toEqual([])
    expect(await listFileTranslations('20315', 42)).toEqual([])
    expect(await listProjectTerms('4964')).toEqual([])
    expect(await fetchAllPages(async () => ({ results: [], pageCount: 1 }))).toEqual([])
  })

  test('valid wrapper responses and complete pagination still work', async () => {
    const files = [{ id: 42, name: 'GregTech.lang.json' }]
    mockFetch(request => Response.json({
      results: request.path.endsWith('/files') ? files : targetTerms,
      pageCount: 1,
    }))
    expect(await listProjectFiles('20315')).toEqual(files)
    expect(await listProjectTerms('4964')).toEqual(targetTerms)
    expect(await fetchAllPages(async page => ({ results: [page], pageCount: 2 })))
      .toEqual([1, 2])
  })
})

describe.serial('term synchronization access boundaries', () => {
  test('denied optional source access preserves existing target terms with zero CRUD', async () => {
    mockTerms({ sourceDenied: true })
    await syncTerms()
    expect(requests).toEqual([
      { method: 'GET', path: '/projects/20315/terms' },
      { method: 'GET', path: '/projects/4964/terms' },
    ])
    expect(mutationRequests()).toEqual([])
  })

  test('denied target access fails without requesting source terms or applying CRUD', async () => {
    mockTerms({ targetDenied: true })
    await expect(syncTerms()).rejects.toBeInstanceOf(PtHttpError)
    expect(requests).toEqual([{ method: 'GET', path: '/projects/20315/terms' }])
    expect(mutationRequests()).toEqual([])
  })

  test('malformed source terms fail before deletion or other CRUD', async () => {
    mockTerms({ source: {} })
    await expect(syncTerms()).rejects.toThrow('Invalid term list for project 4964')
    expect(mutationRequests()).toEqual([])
  })

  test('strict source mode treats source 403 as fatal with zero CRUD', async () => {
    process.env.PT_4964_REQUIRED = '1'
    mockTerms({ sourceDenied: true })
    await expect(syncTerms()).rejects.toBeInstanceOf(PtHttpError)
    expect(mutationRequests()).toEqual([])
  })
})
