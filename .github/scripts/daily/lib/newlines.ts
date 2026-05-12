/**
 * Newline-placeholder sniffing, normalization, and restoration.
 *
 * Different .lang files across the pack use different newline conventions:
 *   - `<BR>`     — quest-book style, common in betterquesting
 *   - `<br>`     — some mod lang files
 *   - `[br]`     — bracket-style newline marker used by a few entries
 *   - `%n`       — Java/formatter-style newline marker for quest text keys
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
 * which was which without the sniff cache. `%n` is only parsed for quest text
 * keys, so formatter variables such as `%name` survive.
 * Backslash and percent runs use parity checks, allowing arbitrary `\\...n`
 * and `%%...n` sequences without hard-coding every width.
 */

export const NEWLINE_FORMS = ['<BR>', '<br>', '[br]', '\\n', '\\\\n', '%n'] as const
export type NewlineForm = typeof NEWLINE_FORMS[number]

export const LINE_BREAK_CONTEXT_PREFIX = '@LineBreak='

const BACKSLASH_NEWLINE_RE = /\\+n/g
const PERCENT_NEWLINE_RE = /%+n/g

export function isPercentNewlineKey(key: string | undefined): boolean {
  const normalized = (key ?? '').toLowerCase()
  return normalized.includes('questing.quest')
    || normalized.includes('betterquesting')
}

function findBackslashNewlineForm(value: string): NewlineForm | undefined {
  let odd = false
  for (const match of value.matchAll(BACKSLASH_NEWLINE_RE)) {
    const slashCount = match[0].length - 1
    if (slashCount % 2 === 0)
      return '\\\\n'
    odd = true
  }
  return odd ? '\\n' : undefined
}

function hasOddPercentNewline(value: string): boolean {
  for (const match of value.matchAll(PERCENT_NEWLINE_RE)) {
    const percentCount = match[0].length - 1
    if (percentCount % 2 === 1)
      return true
  }
  return false
}

function normalizePercentNewlines(value: string): string {
  return value.replace(PERCENT_NEWLINE_RE, (match) => {
    const percentCount = match.length - 1
    if (percentCount % 2 === 0)
      return match
    return `${'%'.repeat(percentCount - 1)}\n`
  })
}

/**
 * Detect which placeholder the value uses. Preference order is `<BR>` >
 * `<br>` > `[br]` > even-count backslash `\\n` > odd-count backslash `\n` >
 * odd-count `%n` on quest text keys. Returns undefined if the value
 * contains no newline placeholder at all.
 */
export function sniffNewline(value: string, key?: string): NewlineForm | undefined {
  if (value.includes('<BR>'))
    return '<BR>'
  if (value.includes('<br>'))
    return '<br>'
  if (value.includes('[br]'))
    return '[br]'
  const backslashForm = findBackslashNewlineForm(value)
  if (backslashForm)
    return backslashForm
  if (isPercentNewlineKey(key) && hasOddPercentNewline(value))
    return '%n'
  return undefined
}

export function hasNewlinePlaceholder(value: string, key?: string): boolean {
  return value.includes('<BR>')
    || value.includes('<br>')
    || value.includes('[br]')
    || findBackslashNewlineForm(value) != null
    || (isPercentNewlineKey(key) && hasOddPercentNewline(value))
}

/**
 * Collapse all placeholder forms to a real newline so downstream diffs don't
 * fire on format-only changes (translator edited `<br>` → `<BR>` etc).
 */
export function normalizeNewlines(value: string, key?: string): string {
  const normalized = value
    .replaceAll('<BR>', '\n')
    .replaceAll('<br>', '\n')
    .replaceAll('[br]', '\n')
    .replace(BACKSLASH_NEWLINE_RE, '\n')
  return isPercentNewlineKey(key) ? normalizePercentNewlines(normalized) : normalized
}

/**
 * PT exports / UI sometimes surface stored line breaks as `%n`; raw upstream
 * files can also contain it. Keep this helper for call sites that conceptually
 * read PT values, even though normalizeNewlines already covers every form.
 */
export function normalizePtNewlines(value: string, key?: string): string {
  return normalizeNewlines(value, key)
}

/**
 * Canonicalize values for upload to PT. PT normalizes all newline markers to a
 * real LF on ingest, so we send real LF too — this keeps `<BR>`, `<br>`,
 * `[br]`, literal `\n`, literal `\\n`, and `%n` all collapsed to the same LF
 * form regardless of what shape the value arrived in.
 */
export function toPtNewlines(value: string, key?: string): string {
  return normalizePtNewlines(value, key)
}

/** Expand a real newline back to the given placeholder form. */
export function restoreNewlines(value: string, form: NewlineForm | undefined): string {
  if (form === '\\\\n')
    return value.replaceAll('\n', '\\\\n')
  if (!form || form === '\\n')
    return value.replaceAll('\n', '\\n')
  return value.replaceAll('\n', form)
}

export function lineBreakContextValue(form: NewlineForm): string {
  return form === '<BR>' ? '<BR>-up' : form
}

export function withLineBreakContext(context: string | undefined, form: NewlineForm | undefined): string | undefined {
  const lines = context && context.length > 0
    ? context.split(/\r?\n/).filter(line => !line.startsWith(LINE_BREAK_CONTEXT_PREFIX))
    : []
  if (form)
    lines.push(`${LINE_BREAK_CONTEXT_PREFIX}${lineBreakContextValue(form)}`)
  return lines.length > 0 ? lines.join('\n') : undefined
}
