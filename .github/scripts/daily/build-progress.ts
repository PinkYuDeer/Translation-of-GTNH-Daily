/**
 * Build the translation-progress chart shown in the GitHub README.
 *
 * Reads the latest Daily ParaTranz project stats and maintains a rolling 90-day
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
const PROJECT_ID = Number(PT_18818_ID)
const PROJECT_URL = `https://paratranz.cn/projects/${PT_18818_ID}`
const DATA_PATH = 'progress/progress.json'
// Two pre-rendered variants: GitHub renders README SVGs as an isolated <img>,
// so an in-SVG prefers-color-scheme media query can't read the page theme.
// Instead each file bakes one palette via inline attributes and the README
// picks between them with a <picture> element (GitHub's supported approach).
const SVG_LIGHT_PATH = 'progress/progress.svg'
const SVG_DARK_PATH = 'progress/progress-dark.svg'

// The chart image line in the README is regenerated each run so its hover
// tooltip (the only tooltip GitHub keeps — it renders the SVG as a static
// <img>) carries a fresh last-3-days summary. Everything between these two
// markers is replaced wholesale.
const README_PATH = 'README.md'
const README_CHART_START = '<!-- progress-chart:start -->'
const README_CHART_END = '<!-- progress-chart:end -->'
const SUMMARY_DAYS = 3

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

/** Slide the rolling window so the latest entry is `today`, dropping anything
 *  older than WINDOW_DAYS. Preserves existing entries by date. */
function slideWindow(prev: DayEntry[], today: string): DayEntry[] {
  const byDate = new Map(prev.map(e => [e.date, e]))
  const out: DayEntry[] = []
  for (let i = WINDOW_DAYS - 1; i >= 0; i--) {
    const d = addDays(today, -i)
    out.push(byDate.get(d) ?? { date: d })
  }
  return out
}

/**
 * Settle phase — runs BEFORE today's push to the Daily PT project. At this point PT still
 * reflects yesterday's pushed state (push-final is what changes PT, and it
 * hasn't run yet), so this snapshot is yesterday's *settled* value: how
 * yesterday's translation stands a day later. Writing it pre-push is what keeps
 * a finished 100% day green even though today's push will add fresh untranslated
 * English and drop today's own percent.
 */
function applySettle(
  prev: DayEntry[],
  today: string,
  stats: { translated: number, total: number },
): DayEntry[] {
  const out = slideWindow(prev, today)
  const snapshot = makeSnapshot(stats.translated, stats.total)
  if (out.length >= 2) {
    const yesterday = out[out.length - 2]
    yesterday.settled = snapshot
    // First run after a gap: seed `updated` too so the bar still renders.
    if (!yesterday.updated)
      yesterday.updated = snapshot
  }
  return out
}

/**
 * Update phase — runs AFTER today's push to the Daily PT project. PT now reflects today's
 * merged + pushed content, so this snapshot is today's *updated* value.
 * `settled` is left unset; tomorrow's settle phase fills it.
 */
function applyUpdate(
  prev: DayEntry[],
  today: string,
  stats: { translated: number, total: number },
): DayEntry[] {
  const out = slideWindow(prev, today)
  const todayEntry = out[out.length - 1]
  todayEntry.updated = makeSnapshot(stats.translated, stats.total)
  return out
}

// ---------------- SVG renderer ----------------

// Bar colors are theme-independent (vivid on both backgrounds). The rest of the
// palette is baked per-theme into a dedicated SVG file via inline attributes.
const BAR = {
  green: '#5BB855',
  yellow: '#F0B43C',
  red: '#DC4747',
} as const

interface Palette {
  /** Page background this variant is drawn for; the axis-break slashes use it
   *  to "cut" the stub, and it must match GitHub's canvas in that theme. */
  pageBg: string
  text: string
  textMute: string
  divider: string
  noData: string
}

// Colors mirror GitHub's own light/dark canvas + text tokens so the chart
// blends in. Background stays transparent (no bg rect); pageBg is only used for
// the axis-break slashes.
const LIGHT: Palette = {
  pageBg: '#ffffff',
  text: '#1f2328',
  textMute: '#59636e',
  divider: '#d1d9e0',
  noData: '#d1d9e0',
}
const DARK: Palette = {
  pageBg: '#0d1117',
  text: '#f0f6fc',
  textMute: '#9198a1',
  divider: '#3d444d',
  noData: '#3d444d',
}

function colorFor(percent: number): string {
  if (percent >= 100)
    return BAR.green
  if (percent >= 95)
    return BAR.yellow
  return BAR.red
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

// HTML-entity quotes: this string goes into a font-family SVG attribute.
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
function renderAxisBreak(x: number, y: number, p: Palette): string {
  // Stub box ~6×8 with two page-background-colored slashes acting as the
  // "break" pattern, followed by a "起点 70%" label. The slash stroke matches
  // this theme's page background so the stub appears cut.
  const w = 6
  const h = 8
  const slashTopY1 = y + h * 0.35
  const slashTopY2 = y + h * 0.15
  const slashBotY1 = y + h * 0.85
  const slashBotY2 = y + h * 0.65
  return `  <g aria-hidden="true">
    <rect x="${x}" y="${y}" width="${w}" height="${h}" rx="1" fill="${p.noData}"/>
    <line x1="${x - 1}" y1="${slashTopY1.toFixed(2)}" x2="${x + w + 1}" y2="${slashTopY2.toFixed(2)}" stroke="${p.pageBg}" stroke-width="1.4"/>
    <line x1="${x - 1}" y1="${slashBotY1.toFixed(2)}" x2="${x + w + 1}" y2="${slashBotY2.toFixed(2)}" stroke="${p.pageBg}" stroke-width="1.4"/>
    <text x="${x + w + 5}" y="${y + h - 1}" font-family="${FONT_FAMILY}" font-size="10" fill="${p.textMute}">起点 ${HEIGHT_FLOOR_PCT}%</text>
  </g>`
}

function renderSvg(data: ProgressData, p: Palette): string {
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
  // Colored summary when there's data; muted otherwise so "—" stays legible.
  const summaryColor = summaryPct === undefined ? p.textMute : colorFor(summaryPct)

  const avg = averagePercent(data.history)
  const avgStr = avg === undefined ? '—' : `${avg.toFixed(1)}%`

  const bars = data.history.map((entry, i) => {
    const x = sidePad + i * (barWidth + gap)
    const primary = primarySnapshot(entry)
    const h = barHeight(primary?.percent, chartHeight)
    const y = chartBottom - h
    const title = tooltipFor(entry)
    const fill = primary === undefined ? p.noData : colorFor(primary.percent)
    return `    <rect x="${x.toFixed(2)}" y="${y.toFixed(2)}" width="${barWidth.toFixed(2)}" height="${h.toFixed(2)}" rx="1" ry="1" fill="${fill}"><title>${escapeXml(title)}</title></rect>`
  })

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="GTNH Daily 汉化进度">
  <title>GTNH Daily 汉化进度（最近 ${WINDOW_DAYS} 天） — ${summaryStr}</title>
  <g font-family="${FONT_FAMILY}" font-size="12">
    <text x="${sidePad}" y="${headerY}" fill="${p.text}">GTNH Daily 汉化进度</text>
    <text x="${W - sidePad}" y="${headerY}" text-anchor="end" fill="${summaryColor}" font-weight="600">${summaryStr} 已翻译</text>
  </g>
  <g>
${bars.join('\n')}
  </g>
${renderAxisBreak(sidePad, axisBreakY, p)}
  <line x1="${sidePad}" x2="${W - sidePad}" y1="${dividerY}" y2="${dividerY}" stroke="${p.divider}" stroke-width="1"/>
  <g font-family="${FONT_FAMILY}" font-size="11" fill="${p.textMute}">
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

/**
 * One-line summary of the most recent SUMMARY_DAYS days that have data, used as
 * the README image's hover tooltip (escaped into the <img title> attribute).
 */
function lastDaysSummary(history: DayEntry[], n: number): string {
  const recent = history.filter(e => primarySnapshot(e) !== undefined).slice(-n)
  if (recent.length === 0)
    return 'GTNH Daily 汉化进度 · 暂无数据'
  const parts = recent.map((e) => {
    const snap = primarySnapshot(e)!
    return `${e.date.slice(5)} ${snap.percent.toFixed(2)}%`
  })
  const latest = primarySnapshot(recent[recent.length - 1])!
  return `GTNH Daily 汉化进度 · 近${recent.length}天 ${parts.join(' → ')} · 最新 ${fmt(latest.translated)}/${fmt(latest.total)} 词条`
}

// <picture> lets GitHub pick the dark variant via prefers-color-scheme in the
// README's own (theme-aware) context — unlike an in-SVG media query, which an
// <img>-rendered SVG can't evaluate against the page theme.
function readmeChartBlock(data: ProgressData): string {
  const tooltip = escapeXml(lastDaysSummary(data.history, SUMMARY_DAYS))
  const alt = `GTNH Daily 汉化进度（最近 ${WINDOW_DAYS} 天）`
  return [
    README_CHART_START,
    '<picture>',
    `  <source media="(prefers-color-scheme: dark)" srcset="${SVG_DARK_PATH}">`,
    `  <img alt="${alt}" src="${SVG_LIGHT_PATH}" title="${tooltip}">`,
    '</picture>',
    README_CHART_END,
  ].join('\n')
}

async function updateReadme(data: ProgressData): Promise<void> {
  let readme: string
  try {
    readme = await fs.readFile(README_PATH, 'utf-8')
  }
  catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
      console.warn(`[build-progress] ${README_PATH} not found; skipping README update`)
      return
    }
    throw err
  }
  const start = readme.indexOf(README_CHART_START)
  const end = readme.indexOf(README_CHART_END)
  if (start === -1 || end === -1 || end < start) {
    console.warn(`[build-progress] chart markers not found in ${README_PATH}; skipping README update`)
    return
  }
  const next = readme.slice(0, start) + readmeChartBlock(data) + readme.slice(end + README_CHART_END.length)
  if (next !== readme) {
    await fs.writeFile(README_PATH, next)
    console.log(`[build-progress] refreshed chart tooltip in ${README_PATH}`)
  }
}

async function writeJson(data: ProgressData): Promise<void> {
  await fs.mkdir(path.dirname(DATA_PATH), { recursive: true })
  await fs.writeFile(DATA_PATH, `${JSON.stringify(data, null, 2)}\n`)
}

async function writeAll(data: ProgressData): Promise<void> {
  await writeJson(data)
  await fs.writeFile(SVG_LIGHT_PATH, renderSvg(data, LIGHT))
  await fs.writeFile(SVG_DARK_PATH, renderSvg(data, DARK))
  await updateReadme(data)
}

async function main(): Promise<void> {
  const args = new Set(process.argv.slice(2))
  const isBackfill = args.has('--backfill')
  const noFetch = args.has('--no-fetch')
  // Pre-push phase: fetch PT's pre-push stats and record them as YESTERDAY's
  // settled value, then write JSON only (the post-push run renders SVG/README).
  const isSettle = args.has('--settle')

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
    const currentProject = existing.projectId === PROJECT_ID
      ? { ...existing, projectUrl: PROJECT_URL }
      : {
          updatedAt: new Date().toISOString(),
          projectId: PROJECT_ID,
          projectUrl: PROJECT_URL,
          history: slideWindow([], today),
        }
    if (existing.projectId !== PROJECT_ID)
      console.log(`[build-progress] project changed ${existing.projectId} -> ${PROJECT_ID}; reset historical chart data`)
    if (noFetch) {
      data = currentProject
      // eslint-disable-next-line no-console
      console.log('[build-progress] --no-fetch: re-rendering SVG only')
    }
    else if (isSettle) {
      const stats = await fetchTodayStats()
      const history = applySettle(currentProject.history, today, stats)
      data = { ...currentProject, updatedAt: new Date().toISOString(), history }
      const yesterday = history[history.length - 2]
      // eslint-disable-next-line no-console
      console.log(`[build-progress] settle ${yesterday?.date} translated=${yesterday?.settled?.translated} total=${yesterday?.settled?.total} percent=${yesterday?.settled?.percent}`)
    }
    else {
      const stats = await fetchTodayStats()
      const history = applyUpdate(currentProject.history, today, stats)
      data = { ...currentProject, updatedAt: new Date().toISOString(), history }
      const last = history[history.length - 1]
      // eslint-disable-next-line no-console
      console.log(`[build-progress] update ${today} translated=${last.updated?.translated} total=${last.updated?.total} percent=${last.updated?.percent}`)
    }
  }

  // The settle phase only mutates JSON; the post-push run owns the rendered
  // artifacts so SVG/README always reflect today's final (post-push) numbers.
  if (isSettle) {
    await writeJson(data)
    // eslint-disable-next-line no-console
    console.log(`[build-progress] wrote ${DATA_PATH} (settle)`)
  }
  else {
    await writeAll(data)
    // eslint-disable-next-line no-console
    console.log(`[build-progress] wrote ${DATA_PATH}, ${SVG_LIGHT_PATH}, ${SVG_DARK_PATH}, ${README_PATH}`)
  }
}

void main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[build-progress] failed:', err)
  process.exit(1)
})
