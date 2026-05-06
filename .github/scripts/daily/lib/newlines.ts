/**
 * Newline-placeholder sniffing, normalization, and restoration.
 *
 * Different .lang files across the pack use different newline conventions:
 *   - `<BR>`     — quest-book style, common in betterquesting
 *   - `<br>`     — some mod lang files
 *   - `[br]`     — bracket-style newline marker used by a few entries
 *   - `%n`       — Java/formatter-style newline marker used by a few entries
 *   - literal `\n`  (two chars: one backslash + n)
 *   - literal `\\n` (three chars: two backslashes + n)
 *
 * PT normalizes everything to a real newline (`\n`) on upload, and translators
 * enter real newlines when they press Enter. If we naively wrote those real
 * newlines straight into a .lang file, Minecraft would read the backslash
 * sequence wrong for quest books and the text would render without a line
 * break. So: we sniff the *original* form used by each key in the English
 * upstream, carry that form around in `newlines.json`, and restore it after
 * downloading translations.
 *
 * Normalization is lossy — once `<BR>` / `<br>` / `[br]` / `%n` / literal
 * `\n` / literal `\\n` are all collapsed to a real newline, we can't tell
 * which was which without the sniff cache. That's fine because the sniff runs
 * every build from the up-to-date English source.
 */

import type { NewlineForm } from './cache.ts'

/**
 * Detect which placeholder the value uses. Preference order is `<BR>` >
 * `<br>` > `[br]` > literal `\\n` > literal `\n` > `%n`. The escaped form
 * must be checked before the single-backslash form because `\\n` contains
 * `\n` as a suffix. Returns undefined if the value contains no newline
 * placeholder at all.
 */
export function sniffNewline(value: string): NewlineForm | undefined {
  if (value.includes('<BR>'))
    return '<BR>'
  if (value.includes('<br>'))
    return '<br>'
  if (value.includes('[br]'))
    return '[br]'
  if (value.includes('\\\\n'))
    return '\\\\n'
  if (value.includes('\\n'))
    return '\\n'
  if (value.includes('%n'))
    return '%n'
  return undefined
}

/**
 * Collapse all placeholder forms to a real newline so downstream diffs don't
 * fire on format-only changes (translator edited `<br>` → `<BR>` etc).
 */
export function normalizeNewlines(value: string): string {
  return value
    .replaceAll('<BR>', '\n')
    .replaceAll('<br>', '\n')
    .replaceAll('[br]', '\n')
    .replaceAll('\\\\n', '\n')
    .replaceAll('\\n', '\n')
    .replaceAll('%n', '\n')
}

/**
 * PT exports / UI sometimes surface stored line breaks as `%n`; raw upstream
 * files can also contain it. Keep this helper for call sites that conceptually
 * read PT values, even though normalizeNewlines already covers every form.
 */
export function normalizePtNewlines(value: string): string {
  return normalizeNewlines(value)
}

/**
 * Canonicalize values for upload to PT. PT normalizes all newline markers to a
 * real LF on ingest, so we send real LF too — this keeps `<BR>`, `<br>`,
 * `[br]`, literal `\n`, literal `\\n`, and `%n` all collapsed to the same LF
 * form regardless of what shape the value arrived in.
 */
export function toPtNewlines(value: string): string {
  return normalizePtNewlines(value)
}

/** Expand a real newline back to the given placeholder form. */
export function restoreNewlines(value: string, form: NewlineForm | undefined): string {
  if (form === '\\\\n')
    return value.replaceAll('\n', '\\\\n')
  if (!form || form === '\\n')
    return value.replaceAll('\n', '\\n')
  return value.replaceAll('\n', form)
}
