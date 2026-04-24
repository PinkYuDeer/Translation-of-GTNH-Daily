/**
 * Sync reviewed ParaTranz terms from project 4964 into daily project 18818.
 *
 * Official API docs:
 *   - GET /projects/{projectId}/terms
 *   - PUT /projects/{projectId}/terms
 */

import { PT_18818_ID, PT_4964_ID, assertToken } from './lib/config.ts'
import { apiPutMultipart, listProjectTerms, type PtTermRow } from './lib/pt-client.ts'

interface TermsImportResult {
  inserted?: number
  updated?: number
  deleted?: number
}

interface CanonicalTerm {
  term: string
  translation: string
  note?: string
  pos?: string
  variants?: string[]
}

function canonicalizeTerm(row: PtTermRow): CanonicalTerm {
  const variants = [...new Set((row.variants ?? []).map(v => v.trim()).filter(Boolean))].sort()
  return {
    term: row.term.trim(),
    translation: row.translation ?? '',
    ...(row.note != null && row.note !== '' ? { note: row.note } : {}),
    ...(row.pos != null && row.pos !== '' ? { pos: row.pos } : {}),
    ...(variants.length > 0 ? { variants } : {}),
  }
}

function dedupeTerms(rows: PtTermRow[]): CanonicalTerm[] {
  const byTerm = new Map<string, CanonicalTerm>()
  for (const row of rows) {
    if (!row.term?.trim())
      continue
    const item = canonicalizeTerm(row)
    if (!byTerm.has(item.term))
      byTerm.set(item.term, item)
  }
  return [...byTerm.values()].sort((a, b) => a.term.localeCompare(b.term))
}

function stableTermsJson(rows: CanonicalTerm[]): string {
  return `${JSON.stringify(rows, null, 2)}\n`
}

async function main(): Promise<void> {
  assertToken()

  const [sourceRaw, targetRaw] = await Promise.all([
    listProjectTerms(PT_4964_ID),
    listProjectTerms(PT_18818_ID),
  ])
  const source = dedupeTerms(sourceRaw)
  const target = dedupeTerms(targetRaw)

  const sourceJson = stableTermsJson(source)
  const targetJson = stableTermsJson(target)

  // eslint-disable-next-line no-console
  console.log(`[sync-terms] source=${source.length} target=${target.length}`)

  if (sourceJson === targetJson) {
    // eslint-disable-next-line no-console
    console.log('[sync-terms] already up to date')
    return
  }

  const result = await apiPutMultipart<TermsImportResult>(
    `/projects/${PT_18818_ID}/terms`,
    {},
    {
      name: 'file',
      filename: 'terms.json',
      content: sourceJson,
      type: 'application/json',
    },
  )

  // eslint-disable-next-line no-console
  console.log(
    `[sync-terms] synced inserted=${result.inserted ?? 0} updated=${result.updated ?? 0} deleted=${result.deleted ?? 0}`,
  )
}

void main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[sync-terms] failed:', err)
  process.exit(1)
})
