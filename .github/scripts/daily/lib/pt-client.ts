/**
 * Thin ParaTranz REST client with 429 back-off and a bounded-concurrency
 * runner. All daily-pipeline scripts share this client so rate-limit handling
 * and error semantics stay consistent.
 *
 * The server responds 429 when a client burns its per-IP quota; the only safe
 * recovery is to sleep 60s and retry the same request. Other non-2xx
 * responses are thrown as errors so callers can decide file-vs-fatal.
 */

import { API_BASE, PARATRANZ_TOKEN, RATE_LIMIT_RETRY_MS } from './config.ts'

const authHeaders = { Authorization: PARATRANZ_TOKEN }
const jsonHeaders = { ...authHeaders, 'Content-Type': 'application/json' }

export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

export async function apiGet<T = unknown>(path: string): Promise<T> {
  while (true) {
    const res = await fetch(`${API_BASE}${path}`, { headers: jsonHeaders })
    if (res.status === 429) {
      await sleep(RATE_LIMIT_RETRY_MS)
      continue
    }
    if (!res.ok)
      throw new Error(`GET ${path} → ${res.status} ${res.statusText}`)
    return res.json() as Promise<T>
  }
}

export async function apiGetRaw(path: string): Promise<Response> {
  while (true) {
    const res = await fetch(`${API_BASE}${path}`, { headers: authHeaders })
    if (res.status === 429) {
      await sleep(RATE_LIMIT_RETRY_MS)
      continue
    }
    if (!res.ok)
      throw new Error(`GET ${path} → ${res.status} ${res.statusText}`)
    return res
  }
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
  while (true) {
    const res = await fetch(`${API_BASE}${path}`, {
      method,
      headers: jsonHeaders,
      body: JSON.stringify(body),
    })
    if (res.status === 429) {
      await sleep(RATE_LIMIT_RETRY_MS)
      continue
    }
    if (!res.ok) {
      const text = await res.text()
      throw new Error(`${method} ${path} → ${res.status} ${res.statusText}: ${text}`)
    }
    return res
  }
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
  while (true) {
    const fd = new FormData()
    for (const [k, v] of Object.entries(fields))
      fd.append(k, v)
    fd.append(
      fileField.name,
      new Blob([fileField.content], { type: fileField.type ?? 'application/json' }),
      fileField.filename,
    )
    const res = await fetch(`${API_BASE}${path}`, {
      method: 'POST',
      headers: authHeaders,
      body: fd,
    })
    if (res.status === 429) {
      await sleep(RATE_LIMIT_RETRY_MS)
      continue
    }
    if (!res.ok) {
      const text = await res.text()
      throw new Error(`POST ${path} → ${res.status} ${res.statusText}: ${text}`)
    }
    return res.json() as Promise<T>
  }
}

/**
 * Bounded-concurrency runner. Fires `limit` workers that each pull from a
 * shared index, so a slow task never blocks a fast one. Returns per-task
 * results in submission order.
 */
export async function runBounded<T>(
  tasks: (() => Promise<T>)[],
  limit: number,
): Promise<{ results: (T | Error)[], successes: number, failures: number }> {
  const results: (T | Error)[] = new Array(tasks.length)
  let idx = 0
  let successes = 0
  let failures = 0
  const workers = Array.from({ length: Math.min(limit, tasks.length) }, async () => {
    while (idx < tasks.length) {
      const i = idx++
      try {
        results[i] = await tasks[i]()
        successes++
      }
      catch (err) {
        results[i] = err as Error
        failures++
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
