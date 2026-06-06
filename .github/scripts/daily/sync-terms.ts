/**
 * Mirror reviewed ParaTranz terms from project 4964 into daily project 18818.
 *
 * 18818 is downstream of 4964, so its term list should be an exact copy. The
 * bulk import endpoint (`PUT /projects/{id}/terms`, multipart) only ever inserts
 * new rows — it neither updates changed terms nor removes ones that were deleted
 * upstream — so the two projects drift apart over time. Instead we diff the two
 * term sets keyed by source text and apply the delta with the per-term CRUD
 * endpoints, so add / update / delete all propagate (and a no-op run touches
 * nothing):
 *   - POST   /projects/{projectId}/terms            (createTerm) — in 4964, not 18818
 *   - PUT    /projects/{projectId}/terms/{termId}   (saveTerm)   — content differs
 *   - DELETE /projects/{projectId}/terms/{termId}   (deleteTerm) — in 18818, not 4964
 */

import { CONCURRENCY, PT_18818_ID, PT_4964_ID, assertToken } from './lib/config.ts'
import {
  apiDeleteJson,
  apiPostJson,
  apiPutJson,
  listProjectTerms,
  type PtTermRow,
  runBounded,
} from './lib/pt-client.ts'

/** Fields we mirror; `term` is the match key, the rest is the comparable payload. */
interface CanonicalTerm {
  term: string
  translation: string
  note?: string
  pos?: string
  variants?: string[]
}

/** ParaTranz constrains `pos` to this enum; any other value (including the empty
 *  string) is rejected by create/update, so we only ever send one of these. */
const VALID_POS = new Set(['noun', 'verb', 'adj', 'adv'])

function canonicalizeTerm(row: PtTermRow): CanonicalTerm {
  const variants = [...new Set((row.variants ?? []).map(v => v.trim()).filter(Boolean))].sort()
  return {
    term: row.term.trim(),
    translation: row.translation ?? '',
    ...(row.note != null && row.note !== '' ? { note: row.note } : {}),
    ...(row.pos && VALID_POS.has(row.pos) ? { pos: row.pos } : {}),
    ...(variants.length > 0 ? { variants } : {}),
  }
}

function variantsKey(t: CanonicalTerm): string {
  return JSON.stringify(t.variants ?? [])
}

/**
 * Does the target term need updating to match the source?
 *
 * translation/note/variants are always synced (empty values clear cleanly), so
 * any difference triggers an update. `pos` is enum-only and can't be cleared via
 * an empty string, so we only act when the source defines a valid `pos` and
 * never fight to remove a stale one — otherwise a source term without `pos`
 * would re-update every run.
 */
function needsUpdate(existing: CanonicalTerm, next: CanonicalTerm): boolean {
  return existing.translation !== next.translation
    || (existing.note ?? '') !== (next.note ?? '')
    || variantsKey(existing) !== variantsKey(next)
    || (next.pos != null && existing.pos !== next.pos)
}

/**
 * Request body for createTerm/saveTerm. note/variants are sent even when empty
 * so an update clears values removed upstream; `pos` is sent only when it's a
 * valid enum value (PT rejects an empty `pos`).
 */
function termPayload(t: CanonicalTerm): Record<string, unknown> {
  return {
    term: t.term,
    translation: t.translation,
    note: t.note ?? '',
    variants: t.variants ?? [],
    ...(t.pos != null ? { pos: t.pos } : {}),
  }
}

async function main(): Promise<void> {
  assertToken()

  const [sourceRaw, targetRaw] = await Promise.all([
    listProjectTerms(PT_4964_ID),
    listProjectTerms(PT_18818_ID),
  ])

  // Source keyed by term text (first occurrence wins, mirroring old dedupe).
  const source = new Map<string, CanonicalTerm>()
  for (const row of sourceRaw) {
    const term = row.term?.trim()
    if (!term)
      continue
    if (!source.has(term))
      source.set(term, canonicalizeTerm(row))
  }

  // Target keyed by term text, retaining the PT id for update/delete. Any
  // duplicate term rows on 18818 are scheduled for deletion to converge to one.
  const target = new Map<string, { id: number, canonical: CanonicalTerm }>()
  const toDelete: number[] = []
  for (const row of targetRaw) {
    const term = row.term?.trim()
    if (!term || row.id == null)
      continue
    if (!target.has(term))
      target.set(term, { id: row.id, canonical: canonicalizeTerm(row) })
    else
      toDelete.push(row.id)
  }

  const toCreate: CanonicalTerm[] = []
  const toUpdate: { id: number, term: CanonicalTerm }[] = []
  for (const [term, canonical] of source) {
    const existing = target.get(term)
    if (!existing)
      toCreate.push(canonical)
    else if (needsUpdate(existing.canonical, canonical))
      toUpdate.push({ id: existing.id, term: canonical })
  }
  for (const [term, { id }] of target) {
    if (!source.has(term))
      toDelete.push(id)
  }

  // eslint-disable-next-line no-console
  console.log(
    `[sync-terms] source=${source.size} target=${target.size} `
    + `create=${toCreate.length} update=${toUpdate.length} delete=${toDelete.length}`,
  )

  if (toCreate.length === 0 && toUpdate.length === 0 && toDelete.length === 0) {
    // eslint-disable-next-line no-console
    console.log('[sync-terms] already up to date')
    return
  }

  // Disjoint by term text/id, so order doesn't matter; run them all bounded.
  const tasks: (() => Promise<unknown>)[] = [
    ...toDelete.map(id => () => apiDeleteJson(`/projects/${PT_18818_ID}/terms/${id}`)),
    ...toUpdate.map(({ id, term }) => () => apiPutJson(`/projects/${PT_18818_ID}/terms/${id}`, termPayload(term))),
    ...toCreate.map(term => () => apiPostJson(`/projects/${PT_18818_ID}/terms`, termPayload(term))),
  ]

  const { results, successes, failures } = await runBounded(tasks, CONCURRENCY)
  // eslint-disable-next-line no-console
  console.log(`[sync-terms] applied successes=${successes} failures=${failures}`)
  if (failures > 0) {
    const firstErr = results.find((r): r is Error => r instanceof Error)
    // eslint-disable-next-line no-console
    console.error(`[sync-terms] ${failures} operation(s) failed; first: ${firstErr?.message ?? firstErr}`)
    process.exit(1)
  }
}

void main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[sync-terms] failed:', err)
  process.exit(1)
})
