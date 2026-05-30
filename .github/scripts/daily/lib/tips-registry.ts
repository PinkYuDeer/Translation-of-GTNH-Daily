/**
 * Stable key registry for the loading-screen tips file.
 *
 * Tips used to be keyed positionally (`tip.0001 …`), so inserting or deleting a
 * single English line shifted every later key onto different content — PT then
 * saw the whole tail as "original changed" and lost the per-line history.
 *
 * This registry instead assigns each distinct tip a stable id on first sight
 * and never renumbers or reuses it. Every run we diff the current English tip
 * list against the registry (LCS) and:
 *
 *   - unchanged line      → keep its id/key (history intact)
 *   - inserted line       → revive a retired id with identical text, else mint
 *                           a fresh id (appended at the end of the id space)
 *   - deleted line        → retire the id (kept for history / future revival)
 *   - reworded in place    → keep the id, update its English text; PT sees the
 *                           same key with a changed original, so merge-final's
 *                           stale-marker machinery preserves the old translation
 *
 * Two orderings fall out of this and are intentionally decoupled:
 *   - PT upload order  = id ascending (append-only; existing rows never move)
 *   - pack / .txt order = the current English file order (`order[]`)
 */

export interface TipsRegistryEntry {
  /** Monotonic, assigned once, never reused. */
  id: number
  /** PT key derived from the id, e.g. `tip.0007`. */
  key: string
  /** Canonical English text this id currently represents. */
  en: string
  status: 'active' | 'retired'
  firstSeen: string
  lastSeen?: string
  retiredAt?: string
}

export interface TipsRegistry {
  version: number
  nextId: number
  entries: TipsRegistryEntry[]
  /**
   * Persisted hint: active keys in the most recent English file order. Written
   * by fetch-en, consumed by pull-zh-4964 (Kiwi line alignment) and
   * restore-and-pack (.txt assembly). `alignTips` recomputes it and ignores any
   * incoming value.
   */
  order?: string[]
}

export interface TipsChange {
  kind: 'add' | 'retire' | 'reword' | 'revive'
  key: string
  en?: string
  oldEn?: string
}

export interface TipsAlignResult {
  /** Entries to push to PT, sorted by id ascending (stable append order). */
  ptEntries: { key: string, original: string }[]
  /** Active keys in the current English file order (for packing the .txt). */
  order: string[]
  registry: TipsRegistry
  changes: TipsChange[]
  /** True when the registry was empty before this run (initial migration). */
  bootstrap: boolean
}

/** Reword pairing threshold; >= keeps the id (history), < is a clean add/del. */
const REWORD_SIMILARITY = 0.5

export const TIPS_REGISTRY_VERSION = 1

export function emptyRegistry(): TipsRegistry {
  return { version: TIPS_REGISTRY_VERSION, nextId: 1, entries: [] }
}

export function keyForId(id: number): string {
  return `tip.${String(id).padStart(4, '0')}`
}

function levenshtein(a: string, b: string): number {
  const n = a.length
  const m = b.length
  if (n === 0)
    return m
  if (m === 0)
    return n
  let prev = Array.from({ length: m + 1 }, (_, j) => j)
  let curr = new Array<number>(m + 1).fill(0)
  for (let i = 1; i <= n; i++) {
    curr[0] = i
    for (let j = 1; j <= m; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost)
    }
    [prev, curr] = [curr, prev]
  }
  return prev[m]
}

function similarity(a: string, b: string): number {
  const maxLen = Math.max(a.length, b.length)
  if (maxLen === 0)
    return 1
  return 1 - levenshtein(a, b) / maxLen
}

type DiffOp =
  | { t: 'match', o: number, n: number }
  | { t: 'del', o: number }
  | { t: 'ins', n: number }

/** Classic LCS backtrack producing match/del/ins ops in sequence order. */
function diffOps(oldArr: string[], newArr: string[]): DiffOp[] {
  const n = oldArr.length
  const m = newArr.length
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = oldArr[i] === newArr[j]
        ? dp[i + 1][j + 1] + 1
        : Math.max(dp[i + 1][j], dp[i][j + 1])
    }
  }
  const ops: DiffOp[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (oldArr[i] === newArr[j]) {
      ops.push({ t: 'match', o: i, n: j })
      i++
      j++
    }
    else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push({ t: 'del', o: i })
      i++
    }
    else {
      ops.push({ t: 'ins', n: j })
      j++
    }
  }
  while (i < n)
    ops.push({ t: 'del', o: i++ })
  while (j < m)
    ops.push({ t: 'ins', n: j++ })
  return ops
}

/**
 * Align the current English tip lines against the registry. Returns the updated
 * registry plus everything downstream needs. Pure except for the cloned
 * registry it returns (the input is not mutated).
 */
export function alignTips(
  enLines: string[],
  input: TipsRegistry | undefined,
  today: string,
): TipsAlignResult {
  const bootstrap = input == null || input.entries.length === 0
  const registry: TipsRegistry = input
    ? { version: input.version, nextId: input.nextId, entries: input.entries.map(e => ({ ...e })) }
    : emptyRegistry()

  const byKey = new Map(registry.entries.map(e => [e.key, e]))
  // LCS needs the previous *English file* order, not the registry array order
  // (new ids are appended to the array, so the two diverge after any insert).
  // `input.order` records last run's English order; fall back to array order.
  const active = input?.order
    ? input.order
      .map(k => byKey.get(k))
      .filter((e): e is TipsRegistryEntry => e != null && e.status === 'active')
    : registry.entries.filter(e => e.status === 'active')
  const oldEn = active.map(e => e.en)
  const ops = diffOps(oldEn, enLines)

  const changes: TipsChange[] = []
  // newIdx → key, so we can build the English-order list afterwards.
  const keyForNew = new Array<string>(enLines.length)

  function allocate(en: string): TipsRegistryEntry {
    // Re-adding a previously retired line recovers its id (and PT history).
    const revived = registry.entries.find(e => e.status === 'retired' && e.en === en)
    if (revived) {
      revived.status = 'active'
      revived.lastSeen = today
      delete revived.retiredAt
      if (!bootstrap)
        changes.push({ kind: 'revive', key: revived.key, en })
      return revived
    }
    const id = registry.nextId++
    const entry: TipsRegistryEntry = {
      id,
      key: keyForId(id),
      en,
      status: 'active',
      firstSeen: today,
      lastSeen: today,
    }
    registry.entries.push(entry)
    byKey.set(entry.key, entry)
    if (!bootstrap)
      changes.push({ kind: 'add', key: entry.key, en })
    return entry
  }

  // Walk ops, buffering each maximal non-match run as a "replace block" so we
  // can pair deletions with insertions (reword detection) by position.
  let pos = 0
  while (pos < ops.length) {
    const op = ops[pos]
    if (op.t === 'match') {
      const entry = active[op.o]
      entry.lastSeen = today
      keyForNew[op.n] = entry.key
      pos++
      continue
    }
    const dels: number[] = []
    const ins: number[] = []
    while (pos < ops.length && ops[pos].t !== 'match') {
      const b = ops[pos]
      if (b.t === 'del')
        dels.push(b.o)
      else if (b.t === 'ins')
        ins.push(b.n)
      pos++
    }
    const paired = Math.min(dels.length, ins.length)
    for (let k = 0; k < paired; k++) {
      const entry = active[dels[k]]
      const newLine = enLines[ins[k]]
      if (similarity(entry.en, newLine) >= REWORD_SIMILARITY) {
        const oldText = entry.en
        entry.en = newLine
        entry.lastSeen = today
        keyForNew[ins[k]] = entry.key
        changes.push({ kind: 'reword', key: entry.key, en: newLine, oldEn: oldText })
      }
      else {
        // Too different to be the same tip: clean break.
        retire(entry)
        keyForNew[ins[k]] = allocate(newLine).key
      }
    }
    for (let k = paired; k < dels.length; k++)
      retire(active[dels[k]])
    for (let k = paired; k < ins.length; k++)
      keyForNew[ins[k]] = allocate(enLines[ins[k]]).key
  }

  function retire(entry: TipsRegistryEntry): void {
    entry.status = 'retired'
    entry.retiredAt = today
    delete entry.lastSeen
    if (!bootstrap)
      changes.push({ kind: 'retire', key: entry.key, oldEn: entry.en })
  }

  const order = enLines.map((_, n) => keyForNew[n]).filter(Boolean)
  const ptEntries = registry.entries
    .filter(e => e.status === 'active')
    .sort((a, b) => a.id - b.id)
    .map(e => ({ key: e.key, original: e.en }))

  return { ptEntries, order, registry, changes, bootstrap }
}

/** Render a dated changelog section, newest content first; '' when no changes. */
export function renderChangelogSection(today: string, changes: TipsChange[]): string {
  if (changes.length === 0)
    return ''
  const label: Record<TipsChange['kind'], string> = {
    add: '＋ 新增',
    retire: '－ 退役',
    reword: '～ 改写',
    revive: '↺ 复活',
  }
  const lines = changes.map((c) => {
    if (c.kind === 'reword')
      return `- ${label[c.kind]} ${c.key}: ${JSON.stringify(c.oldEn)} → ${JSON.stringify(c.en)}`
    if (c.kind === 'retire')
      return `- ${label[c.kind]} ${c.key}: ${JSON.stringify(c.oldEn)}`
    return `- ${label[c.kind]} ${c.key}: ${JSON.stringify(c.en)}`
  })
  return `## ${today}\n${lines.join('\n')}\n\n`
}
