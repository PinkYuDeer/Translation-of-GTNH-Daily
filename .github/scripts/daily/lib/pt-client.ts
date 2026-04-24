/**
 * Thin ParaTranz REST client with retry/back-off, plus a few PT-specific
 * helpers (`listProjectFiles`, `listFileStrings`) inspired by the upstream
 * GTNH tooling.
 *
 * Two practical lessons we keep from upstream:
 *   1. fileIds should be recoverable by remote filename when local cache is
 *      cold or partially lost;
 *   2. PT transient failures are not limited to 429 — network hiccups and
 *      5xx responses also deserve automatic retry.
 */

import { API_BASE, PARATRANZ_TOKEN, RATE_LIMIT_RETRY_MS } from './config.ts'

const authHeaders = { Authorization: PARATRANZ_TOKEN }
const jsonHeaders = { ...authHeaders, 'Content-Type': 'application/json' }
const MAX_RATE_LIMIT_RETRIES = 100
const MAX_TRANSIENT_RETRIES = 8
const DEFAULT_STRINGS_PAGE_SIZE = 1000

export interface PtFileSummary {
  id: number
  name: string
  modifiedAt?: string | null
  extra?: Record<string, unknown> | null
}

export interface PtStringRow {
  id: number
  key: string
  original: string
  translation: string
  stage: number
  context?: string | null
}

export interface PtTermRow {
  id?: number
  term: string
  translation: string
  note?: string | null
  pos?: string | null
  variants?: string[] | null
}

export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function parseRetryAfterMs(retryAfter: string | null): number | undefined {
  if (!retryAfter)
    return undefined
  const seconds = Number(retryAfter)
  if (Number.isFinite(seconds))
    return Math.max(0, seconds * 1000)
  const at = Date.parse(retryAfter)
  if (Number.isNaN(at))
    return undefined
  return Math.max(0, at - Date.now())
}

function transientBackoffMs(attempt: number): number {
  return Math.min(60_000, 1000 * 2 ** Math.max(0, attempt - 1))
}

async function readResponseTextSafe(res: Response): Promise<string> {
  try {
    return await res.text()
  }
  catch {
    return ''
  }
}

async function apiRequestRaw(
  method: 'GET' | 'POST' | 'PUT',
  path: string,
  init: { headers: HeadersInit, body?: BodyInit } = { headers: authHeaders },
): Promise<Response> {
  let rateLimitRetries = 0
  let transientRetries = 0

  while (true) {
    let res: Response
    try {
      res = await fetch(`${API_BASE}${path}`, {
        method,
        headers: init.headers,
        ...(init.body != null ? { body: init.body } : {}),
      })
    }
    catch (err) {
      transientRetries++
      if (transientRetries > MAX_TRANSIENT_RETRIES) {
        const message = err instanceof Error ? err.message : String(err)
        throw new Error(`${method} ${path} → network error: ${message}`)
      }
      await sleep(transientBackoffMs(transientRetries))
      continue
    }

    if (res.status === 429) {
      rateLimitRetries++
      if (rateLimitRetries > MAX_RATE_LIMIT_RETRIES) {
        const text = await readResponseTextSafe(res)
        throw new Error(`429 ${method} ${path} exhausted retries${text ? `: ${text}` : ''}`)
      }
      await sleep(parseRetryAfterMs(res.headers.get('Retry-After')) ?? RATE_LIMIT_RETRY_MS)
      continue
    }

    if (res.status >= 500) {
      transientRetries++
      if (transientRetries > MAX_TRANSIENT_RETRIES) {
        const text = await readResponseTextSafe(res)
        throw new Error(`${method} ${path} → ${res.status} ${res.statusText}${text ? `: ${text}` : ''}`)
      }
      await sleep(parseRetryAfterMs(res.headers.get('Retry-After')) ?? transientBackoffMs(transientRetries))
      continue
    }

    if (!res.ok) {
      const text = await readResponseTextSafe(res)
      throw new Error(`${method} ${path} → ${res.status} ${res.statusText}${text ? `: ${text}` : ''}`)
    }

    return res
  }
}

export async function apiGet<T = unknown>(path: string): Promise<T> {
  const res = await apiRequestRaw('GET', path, { headers: jsonHeaders })
  return res.json() as Promise<T>
}

export async function apiGetRaw(path: string): Promise<Response> {
  return apiRequestRaw('GET', path, { headers: authHeaders })
}

export async function apiPostJson<T = unknown>(path: string, body: unknown): Promise<T> {
  return apiSendJson('POST', path, body)
}

export async function apiPutJson<T = unknown>(path: string, body: unknown): Promise<T> {
  return apiSendJson('PUT', path, body)
}

export async function apiPutJsonRaw(path: string, body: unknown): Promise<Response> {
  return apiSendJsonRaw('PUT', path, body)
}

async function apiSendJson<T = unknown>(method: 'POST' | 'PUT', path: string, body: unknown): Promise<T> {
  const res = await apiSendJsonRaw(method, path, body)
  return res.json() as Promise<T>
}

async function apiSendJsonRaw(method: 'POST' | 'PUT', path: string, body: unknown): Promise<Response> {
  return apiRequestRaw(method, path, {
    headers: jsonHeaders,
    body: JSON.stringify(body),
  })
}

/**
 * Upload a multipart form with a file blob. Used for both POST /files
 * (create) and POST /files/{id} (replace).
 *
 * PT decides the parser from the blob's filename extension, so callers must
 * pass a meaningful `.json` / `.lang` name even though it never appears as a
 * real file on disk.
 */
export async function apiPostMultipart<T = unknown>(
  path: string,
  fields: Record<string, string>,
  fileField: { name: string, filename: string, content: string, type?: string },
): Promise<T> {
  return apiMultipart('POST', path, fields, fileField)
}

export async function apiPutMultipart<T = unknown>(
  path: string,
  fields: Record<string, string>,
  fileField: { name: string, filename: string, content: string, type?: string },
): Promise<T> {
  return apiMultipart('PUT', path, fields, fileField)
}

async function apiMultipart<T = unknown>(
  method: 'POST' | 'PUT',
  path: string,
  fields: Record<string, string>,
  fileField: { name: string, filename: string, content: string, type?: string },
): Promise<T> {
  const fd = new FormData()
  for (const [k, v] of Object.entries(fields))
    fd.append(k, v)
  fd.append(
    fileField.name,
    new Blob([fileField.content], { type: fileField.type ?? 'application/json' }),
    fileField.filename,
  )
  const res = await apiRequestRaw(method, path, {
    headers: authHeaders,
    body: fd,
  })
  return res.json() as Promise<T>
}

/**
 * Bounded-concurrency runner. Fires `limit` workers that each pull from a
 * shared index, so a slow task never blocks a fast one. Returns per-task
 * results in submission order.
 */
export async function runBounded<T>(
  tasks: (() => Promise<T>)[],
  limit: number,
  options?: {
    onSettled?: (info: {
      index: number
      completed: number
      total: number
      successes: number
      failures: number
      result: T | Error
    }) => void
  },
): Promise<{ results: (T | Error)[], successes: number, failures: number }> {
  const results: (T | Error)[] = new Array(tasks.length)
  let idx = 0
  let successes = 0
  let failures = 0
  let completed = 0
  const workers = Array.from({ length: Math.min(limit, tasks.length) }, async () => {
    while (idx < tasks.length) {
      const i = idx++
      try {
        results[i] = await tasks[i]()
        successes++
        completed++
        options?.onSettled?.({
          index: i,
          completed,
          total: tasks.length,
          successes,
          failures,
          result: results[i],
        })
      }
      catch (err) {
        results[i] = err as Error
        failures++
        completed++
        options?.onSettled?.({
          index: i,
          completed,
          total: tasks.length,
          successes,
          failures,
          result: results[i],
        })
      }
    }
  })
  await Promise.all(workers)
  return { results, successes, failures }
}

/**
 * Walk PT's paginated `results` / `pageCount` shape. Callers supply a
 * `fetchPage(page)` that returns one page; we concatenate up to `pageCount`.
 */
export async function fetchAllPages<T>(
  fetchPage: (page: number) => Promise<{ pageCount: number, results: T[] }>,
): Promise<T[]> {
  let page = 1
  const all: T[] = []
  while (true) {
    const data = await fetchPage(page)
    all.push(...(data.results ?? []))
    if (page >= data.pageCount)
      break
    page++
  }
  return all
}

/**
 * PT's `/files` endpoint returns a bare array on current deployments, but some
 * generated clients also model it as `{results}`. Accept both to keep callers
 * simple and robust.
 */
export async function listProjectFiles(projectId: string): Promise<PtFileSummary[]> {
  const data = await apiGet<unknown>(`/projects/${projectId}/files`)
  if (Array.isArray(data))
    return data as PtFileSummary[]
  return (((data as { results?: PtFileSummary[] }).results) ?? [])
}

export function indexFilesByLowerName<T extends { name: string }>(files: readonly T[]): Map<string, T> {
  const out = new Map<string, T>()
  for (const file of files)
    out.set(file.name.toLowerCase(), file)
  return out
}

export async function listFileStrings(
  projectId: string,
  fileId: number,
  pageSize = DEFAULT_STRINGS_PAGE_SIZE,
): Promise<PtStringRow[]> {
  return fetchAllPages<PtStringRow>(page =>
    apiGet(`/projects/${projectId}/strings?file=${fileId}&page=${page}&pageSize=${pageSize}`),
  )
}

export async function listProjectTerms(projectId: string, pageSize = DEFAULT_STRINGS_PAGE_SIZE): Promise<PtTermRow[]> {
  const first = await apiGet<unknown>(`/projects/${projectId}/terms`)
  if (Array.isArray(first))
    return first as PtTermRow[]

  const pageLike = first as { pageCount?: number, results?: PtTermRow[] }
  if (!Array.isArray(pageLike.results))
    return []
  if ((pageLike.pageCount ?? 1) <= 1)
    return pageLike.results

  return fetchAllPages<PtTermRow>(page =>
    apiGet(`/projects/${projectId}/terms?page=${page}&pageSize=${pageSize}`),
  )
}
