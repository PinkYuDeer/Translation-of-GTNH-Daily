/**
 * Loading-screen `tips/*.txt` ↔ synthetic .lang conversion.
 *
 * The tips file is a list of display lines, one per line. Comments start with
 * `#`, blank lines are ignored. Minecraft's Better Loading Screen mod picks
 * a random non-empty, non-comment line to show while the pack loads.
 *
 * We can't round-trip this as-is through PT — PT stores key/value pairs.
 * So we synthesize a `.lang`-shaped list where each non-empty line gets a
 * positional key like `tip.0001`. The English and Chinese upstream files must
 * have the same number of non-empty non-comment lines, in the same logical
 * order; otherwise we cannot line up translations and the build fails loudly.
 */

import type { LangEntry } from './lang-parser.ts'

/** Strip comments / blank lines; keep original line order. */
export function parseTipsLines(content: string): string[] {
  const out: string[] = []
  for (const rawLine of content.split('\n')) {
    const line = rawLine.replace(/\r$/, '')
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#'))
      continue
    out.push(line)
  }
  return out
}

/** Build synthetic `tip.0001 … tip.NNNN` entries from tip lines. */
export function tipsToEntries(lines: string[]): LangEntry[] {
  const pad = Math.max(4, String(lines.length).length)
  return lines.map((value, i) => ({
    key: `tip.${String(i + 1).padStart(pad, '0')}`,
    value,
  }))
}

/** Reverse: sort by key's numeric suffix and re-emit the plain tips text. */
export function entriesToTips(entries: LangEntry[]): string {
  const withIdx = entries
    .map((e) => {
      const m = e.key.match(/^tip\.(\d+)$/)
      return m ? { idx: Number(m[1]), value: e.value } : null
    })
    .filter((x): x is { idx: number, value: string } => x != null)
    .sort((a, b) => a.idx - b.idx)
  return `${withIdx.map(x => x.value).join('\n')}\n`
}
