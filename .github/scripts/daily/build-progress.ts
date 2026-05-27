/**
 * Build the translation-progress chart shown in the GitHub README.
 *
 * Reads the latest ParaTranz 18818 stats and maintains a rolling 90-day
 * window at `progress/progress.json`. Each day records two snapshots so
 * the tooltip can show both numbers separately:
 *   - updated: stats captured by THIS day's 01:00 CN daily run
 *   - settled: stats captured by the NEXT day's 01:00 CN run (i.e. when
 *              today's translation has been "settled" by tomorrow's snapshot)
 * Each daily run therefore touches exactly three days:
 *   1. drop the day that fell out of the 90-day window
 *   2. write yesterday.settled = today's fresh snapshot
 *   3. write today.updated     = today's fresh snapshot
 *
 * Rendering: bar height linearly maps percent into the [70, 100] visual band
 * (anything below 70% renders as a sliver); color buckets at 100% green /
 * ≥95% yellow / else red; no-data days render full-height gray.
 *
 * Modes:
 *   default    — fetch live PT stats, slide window, render SVG
 *   --backfill — regenerate full window from breakpoints (one-shot seed,
 *                deterministic given fixed seed)
 *   --no-fetch — skip PT API call (re-render only from existing JSON)
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import { API_BASE, PT_18818_ID } from './lib/config.ts'

const WINDOW_DAYS = 90
const PROJECT_ID = 18818
const PROJECT_URL = 'https://paratranz.cn/projects/18818'
const DATA_PATH = 'progress/progress.json'
const SVG_PATH = 'progress/progress.svg'

// Bar-height visual band. Percent values are linearly remapped into
// [HEIGHT_FLOOR_PCT, 100] so the small range we usually live in (85-100%)
// produces visible contrast; anything ≤ HEIGHT_FLOOR_PCT renders as the
// minimum sliver below. The break indicator below the chart hints at this.
const HEIGHT_FLOOR_PCT = 70
const BAR_MIN_PX = 2.5

// User-supplied breakpoints; real history before this point is lost.
// Days between adjacent breakpoints are linearly interpolated;
// after the last breakpoint the percent is held flat.
const BACKFILL_BREAKPOINTS: ReadonlyArray<{ date: string, percent: number }> = [
  { date: '2026-04-20', percent: 88.89 },
  { date: '2026-04-21', percent: 89.41 },
  { date: '2026-05-10', percent: 98.00 },
  { date: '2026-05-23', percent: 100.00 },
]

interface Snapshot {
  translated: number
  total: number
  percent: number
}

interface DayEntry {
  date: string
  /** Snapshot captured by this day's 01:00 CN daily run. */
  updated?: Snapshot
  /** Snapshot captured by the next day's 01:00 CN daily run. */
  settled?: Snapshot
}

interface ProgressData {
  updatedAt: string
  projectId: number
  projectUrl: string
  history: DayEntry[]
}

interface PtProjectInfo {
  id: number
  stats: {
    total: number
    translated: number
    hidden: number
    [k: string]: unknown
  }
}

// ---------------- date helpers ----------------

function todayDateString(): string {
  // Prefer NB_LOCAL_DATE injected by the daily workflow (CN-local date).
  if (process.env.NB_LOCAL_DATE)
    return process.env.NB_LOCAL_DATE
  // Otherwise compute Asia/Shanghai (UTC+8) local date.
  const now = new Date()
  const cn = new Date(now.getTime() + 8 * 3600 * 1000)
  return cn.toISOString().slice(0, 10)
}

function addDays(date: string, delta: number): string {
  const d = new Date(`${date}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + delta)
  return d.toISOString().slice(0, 10)
}

function daysBetween(a: string, b: string): number {
  const aMs = Date.parse(`${a}T00:00:00Z`)
  const bMs = Date.parse(`${b}T00:00:00Z`)
  return Math.round((bMs - aMs) / 86_400_000)
}

function round2(x: number): number {
  return Math.round(x * 100) / 100
}

function makeSnapshot(translated: number, total: number): Snapshot {
  const percent = total > 0 ? round2((translated / total) * 100) : 0
  return { translated, total, percent }
}

// Deterministic PRNG so re-runs of --backfill produce the same demo data.
function mulberry32(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s + 0x6D2B79F5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296
  }
}

function interpolatePercent(
  date: string,
  bps: ReadonlyArray<{ date: string, percent: number }>,
): number | undefined {
  if (date < bps[0].date)
    return undefined
  if (date >= bps[bps.length - 1].date)
    return bps[bps.length - 1].percent
  for (let i = 0; i < bps.length - 1; i++) {
    const a = bps[i]
    const b = bps[i + 1]
    if (date >= a.date && date <= b.date) {
      const span = daysBetween(a.date, b.date)
      if (span === 0)
        return a.percent
      const offset = daysBetween(a.date, date)
      return a.percent + (b.percent - a.percent) * (offset / span)
    }
  }
  return undefined
}

// ---------------- backfill ----------------

function buildBackfillHistory(today: string, todayTotal: number, todayTranslated: number): DayEntry[] {
  const dates: string[] = []
  for (let i = WINDOW_DAYS - 1; i >= 0; i--)
    dates.push(addDays(today, -i))

  const percents = dates.map(d => interpolatePercent(d, BACKFILL_BREAKPOINTS))

  // Walk backward from today, subtracting random 5..25 to invent visible
  // totals. Days outside the breakpoint range stay without a snapshot
  // → render as gray "no data".
  const rng = mulberry32(0xC0FFEE)
  const totals: (number | undefined)[] = new Array(dates.length)
  let runningTotal = todayTotal
  for (let i = dates.length - 1; i >= 0; i--) {
    if (percents[i] === undefined)
      continue
    totals[i] = runningTotal
    runningTotal -= 5 + Math.floor(rng() * 21)
  }

  const history: DayEntry[] = dates.map((date, i) => {
    const pct = percents[i]
    const total = totals[i]
    if (pct === undefined || total === undefined)
      return { date }
    const translated = Math.round((pct / 100) * total)
    const snapshot = makeSnapshot(translated, total)
    // For backfilled days we don't have separate "updated" vs "settled"
    // measurements — synthesize both as the same value so the tooltip
    // structure stays consistent with live entries. Today's `settled` is
    // intentionally left undefined (matches "next day hasn't run yet").
    return { date, updated: snapshot, settled: snapshot }
  })

  // Force today's slot to reflect today's real stats; leave `settled`
  // unset since the next daily run hasn't happened yet.
  const last = history[history.length - 1]
  const liveSnapshot = makeSnapshot(todayTranslated, todayTotal)
  last.updated = liveSnapshot
  last.settled = undefined

  return history
}

// ---------------- live fetch + merge ----------------

async function fetchTodayStats(): Promise<{ translated: number, total: number }> {
  // /projects/{id} is a public endpoint; no PARATRANZ_TOKEN required.
  // Pass the token if available so authenticated readers don't show as
  // anonymous, but don't fail without one.
  const headers: Record<string, string> = { Accept: 'application/json' }
  if (process.env.PARATRANZ_TOKEN)
    headers.Authorization = process.env.PARATRANZ_TOKEN
  const res = await fetch(`${API_BASE}/projects/${PT_18818_ID}`, { headers })
  if (!res.ok)
    throw new Error(`GET /projects/${PT_18818_ID} → ${res.status} ${res.statusText}: ${await res.text().catch(() => '')}`)
  const info = await res.json() as PtProjectInfo
  const visible = info.stats.total - info.stats.hidden
  return { translated: info.stats.translated, total: visible }
}

/**
 * Slide the window so the latest entry is `today`, drop everything older
 * than WINDOW_DAYS, and apply the three-day update:
 *   1. oldest day drops off the left edge
 *   2. yesterday.settled = today's snapshot (today's run "settles" yesterday)
 *   3. today.updated     = today's snapshot
 */
function mergeWindow(
  prev: DayEntry[],
  today: string,
  todayStats: { translated: number, total: number },
): DayEntry[] {
  const byDate = new Map(prev.map(e => [e.date, e]))
  const out: DayEntry[] = []
  for (let i = WINDOW_DAYS - 1; i >= 0; i--) {
    const d = addDays(today, -i)
    out.push(byDate.get(d) ?? { date: d })
  }
  const snapshot = makeSnapshot(todayStats.translated, todayStats.total)

  // Today: refresh the `updated` snapshot. `settled` stays unset (will be
  // populated by tomorrow's run).
  const todayEntry = out[out.length - 1]
  todayEntry.updated = snapshot
  todayEntry.settled = undefined

  // Yesterday: settle it with today's fresh snapshot. If yesterday has no
  // `updated` value (e.g. first run after a gap), seed it too so the bar
  // still renders.
  if (out.length >= 2) {
    const yesterday = out[out.length - 2]
    yesterday.settled = snapshot
    if (!yesterday.updated)
      yesterday.updated = snapshot
  }

  return out
}

// ---------------- SVG renderer ----------------

const COLORS = {
  bg: '#FAF8F2',
  textDark: '#3F454F',
  textMute: '#9098A2',
  divider: '#E5E1D6',
  green: '#5BB855',
  yellow: '#F0B43C',
  red: '#DC4747',
  noData: '#D6D8DD',
} as const

function colorFor(percent: number | undefined): string {
  if (percent === undefined)
    return COLORS.noData
  if (percent >= 100)
    return COLORS.green
  if (percent >= 95)
    return COLORS.yellow
  return COLORS.red
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function fmt(n: number): string {
  return n.toLocaleString('en-US')
}

const FONT_FAMILY = '-apple-system, BlinkMacSystemFont, &quot;Segoe UI&quot;, &quot;PingFang SC&quot;, &quot;Hiragino Sans GB&quot;, &quot;Microsoft YaHei&quot;, &quot;Source Han Sans SC&quot;, sans-serif'

/** Preferred "authoritative" snapshot for height/color: settled > updated. */
function primarySnapshot(entry: DayEntry): Snapshot | undefined {
  return entry.settled ?? entry.updated
}

function barHeight(percent: number | undefined, chartHeight: number): number {
  if (percent === undefined)
    return chartHeight
  const norm = (percent - HEIGHT_FLOOR_PCT) / (100 - HEIGHT_FLOOR_PCT)
  return Math.max(BAR_MIN_PX, Math.min(1, Math.max(0, norm)) * chartHeight)
}

function averagePercent(history: DayEntry[]): number | undefined {
  const vals = history
    .map(e => primarySnapshot(e)?.percent)
    .filter((p): p is number => p !== undefined)
  if (vals.length === 0)
    return undefined
  return vals.reduce((a, b) => a + b, 0) / vals.length
}

function snapshotLine(label: string, time: string, snap: Snapshot | undefined, fallback?: string): string {
  if (!snap)
    return `${label}（${time}）：${fallback ?? '—'}`
  return `${label}（${time}）：${fmt(snap.translated)} / ${fmt(snap.total)} 词条 · ${snap.percent.toFixed(2)}%`
}

function tooltipFor(entry: DayEntry): string {
  const primary = primarySnapshot(entry)
  if (!primary)
    return `${entry.date} · 无数据`
  const updatedAtCn = `${entry.date} 01:00 CN`
  const settledAtCn = `${addDays(entry.date, 1)} 01:00 CN`
  const lines = [
    `${entry.date} · ${primary.percent.toFixed(2)}%`,
    snapshotLine('更新时', updatedAtCn, entry.updated),
    snapshotLine('结算时', settledAtCn, entry.settled, '待结算'),
  ]
  return lines.join('\n')
}

/**
 * Small axis-break indicator placed just below the chart's left edge.
 * Two diagonal "slash" marks across a faint stub communicate that the
 * vertical scale begins at HEIGHT_FLOOR_PCT, not 0%.
 */
function renderAxisBreak(x: number, y: number): string {
  // Stub box ~6×8 with two cream slashes acting as the "break" pattern,
  // followed by a "起点 70%" label.
  const w = 6
  const h = 8
  const slashTopY1 = y + h * 0.35
  const slashTopY2 = y + h * 0.15
  const slashBotY1 = y + h * 0.85
  const slashBotY2 = y + h * 0.65
  return `  <g aria-hidden="true">
    <rect x="${x}" y="${y}" width="${w}" height="${h}" rx="1" fill="${COLORS.noData}"/>
    <line x1="${x - 1}" y1="${slashTopY1.toFixed(2)}" x2="${x + w + 1}" y2="${slashTopY2.toFixed(2)}" stroke="${COLORS.bg}" stroke-width="1.4"/>
    <line x1="${x - 1}" y1="${slashBotY1.toFixed(2)}" x2="${x + w + 1}" y2="${slashBotY2.toFixed(2)}" stroke="${COLORS.bg}" stroke-width="1.4"/>
    <text x="${x + w + 5}" y="${y + h - 1}" font-family="${FONT_FAMILY}" font-size="10" fill="${COLORS.textMute}">起点 ${HEIGHT_FLOOR_PCT}%</text>
  </g>`
}

function renderSvg(data: ProgressData): string {
  const W = 1040
  const H = 128
  const sidePad = 16
  const headerY = 22
  const chartTop = 34
  const chartHeight = 50
  const chartBottom = chartTop + chartHeight
  const axisBreakY = chartBottom + 4
  const dividerY = chartBottom + 18
  const footerY = dividerY + 16

  const chartWidth = W - sidePad * 2
  const numBars = data.history.length
  const gap = 2.5
  const barWidth = (chartWidth - gap * (numBars - 1)) / numBars

  const lastWithData = [...data.history].reverse().find(e => primarySnapshot(e) !== undefined)
  const summaryPct = primarySnapshot(lastWithData ?? { date: '' })?.percent
  const summaryStr = summaryPct === undefined ? '—' : `${summaryPct.toFixed(2)}%`
  const summaryColor = colorFor(summaryPct)

  const avg = averagePercent(data.history)
  const avgStr = avg === undefined ? '—' : `${avg.toFixed(1)}%`

  const bars = data.history.map((entry, i) => {
    const x = sidePad + i * (barWidth + gap)
    const primary = primarySnapshot(entry)
    const h = barHeight(primary?.percent, chartHeight)
    const y = chartBottom - h
    const fill = colorFor(primary?.percent)
    const title = tooltipFor(entry)
    return `    <rect x="${x.toFixed(2)}" y="${y.toFixed(2)}" width="${barWidth.toFixed(2)}" height="${h.toFixed(2)}" rx="1" ry="1" fill="${fill}"><title>${escapeXml(title)}</title></rect>`
  })

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="GTNH Daily 汉化进度">
  <title>GTNH Daily 汉化进度（最近 ${WINDOW_DAYS} 天） — ${summaryStr}</title>
  <rect x="0" y="0" width="${W}" height="${H}" fill="${COLORS.bg}"/>
  <g font-family="${FONT_FAMILY}" font-size="12">
    <text x="${sidePad}" y="${headerY}" fill="${COLORS.textDark}">GTNH Daily 汉化进度</text>
    <text x="${W - sidePad}" y="${headerY}" text-anchor="end" fill="${summaryColor}" font-weight="600">${summaryStr} 已翻译</text>
  </g>
  <g>
${bars.join('\n')}
  </g>
${renderAxisBreak(sidePad, axisBreakY)}
  <line x1="${sidePad}" x2="${W - sidePad}" y1="${dividerY}" y2="${dividerY}" stroke="${COLORS.divider}" stroke-width="1"/>
  <g font-family="${FONT_FAMILY}" font-size="11" fill="${COLORS.textMute}">
    <text x="${sidePad}" y="${footerY}">${WINDOW_DAYS} 天前</text>
    <text x="${W / 2}" y="${footerY}" text-anchor="middle">过去 ${WINDOW_DAYS} 天 · 平均 ${avgStr}</text>
    <text x="${W - sidePad}" y="${footerY}" text-anchor="end">今天</text>
  </g>
</svg>
`
}

// ---------------- main ----------------

async function loadExisting(): Promise<ProgressData | undefined> {
  try {
    const raw = await fs.readFile(DATA_PATH, 'utf-8')
    return JSON.parse(raw) as ProgressData
  }
  catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT')
      return undefined
    throw err
  }
}

async function writeAll(data: ProgressData): Promise<void> {
  await fs.mkdir(path.dirname(DATA_PATH), { recursive: true })
  await fs.writeFile(DATA_PATH, `${JSON.stringify(data, null, 2)}\n`)
  await fs.writeFile(SVG_PATH, renderSvg(data))
}

async function main(): Promise<void> {
  const args = new Set(process.argv.slice(2))
  const isBackfill = args.has('--backfill')
  const noFetch = args.has('--no-fetch')

  const today = todayDateString()
  let data: ProgressData

  if (isBackfill) {
    let todayTotal = 82679
    let todayTranslated = 82679
    if (!noFetch) {
      const stats = await fetchTodayStats()
      todayTotal = stats.total
      todayTranslated = stats.translated
    }
    const history = buildBackfillHistory(today, todayTotal, todayTranslated)
    data = {
      updatedAt: new Date().toISOString(),
      projectId: PROJECT_ID,
      projectUrl: PROJECT_URL,
      history,
    }
    // eslint-disable-next-line no-console
    console.log(`[build-progress] backfilled ${history.length} days through ${today}`)
  }
  else {
    const existing = await loadExisting()
    if (!existing) {
      // eslint-disable-next-line no-console
      console.error(`[build-progress] no existing ${DATA_PATH}; run with --backfill first`)
      process.exit(1)
    }
    if (noFetch) {
      data = existing
      // eslint-disable-next-line no-console
      console.log('[build-progress] --no-fetch: re-rendering SVG only')
    }
    else {
      const stats = await fetchTodayStats()
      const history = mergeWindow(existing.history, today, stats)
      data = { ...existing, updatedAt: new Date().toISOString(), history }
      const last = history[history.length - 1]
      // eslint-disable-next-line no-console
      console.log(`[build-progress] ${today} translated=${last.updated?.translated} total=${last.updated?.total} percent=${last.updated?.percent}`)
    }
  }

  await writeAll(data)
  // eslint-disable-next-line no-console
  console.log(`[build-progress] wrote ${DATA_PATH}, ${SVG_PATH}`)
}

void main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[build-progress] failed:', err)
  process.exit(1)
})
