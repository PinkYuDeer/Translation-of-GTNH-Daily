/**
 * Minecraft .lang ↔ PT JSON conversions.
 *
 * `.lang` files are `key=value` per line with `#` comments. A value's trailing
 * whitespace is significant (Minecraft renders it), so we keep everything
 * after the first `=` verbatim. Keys are trimmed because Minecraft's own
 * parser does the same.
 */

export interface LangEntry {
  key: string
  value: string
}

export interface PtStringItem {
  id?: number
  key: string
  original: string
  translation: string
  stage: number
  createdAt?: string | null
  updatedAt?: string | null
  uid?: number | null
  context?: string
}

/**
 * Parse a `.lang` string into ordered entries. Preserves input order so
 * downstream writers can output a file whose key order matches the English
 * source (easier diffing).
 */
export function parseLang(content: string): LangEntry[] {
  const entries: LangEntry[] = []
  for (const rawLine of content.split('\n')) {
    const line = rawLine.replace(/\r$/, '')
    const trimmed = line.trimStart()
    if (!trimmed || trimmed.startsWith('#'))
      continue
    const eqIdx = line.indexOf('=')
    if (eqIdx < 0)
      continue
    entries.push({
      key: line.slice(0, eqIdx).trim(),
      value: line.slice(eqIdx + 1),
    })
  }
  return entries
}

/** Serialize entries back to `.lang` text (no comments, key=value per line). */
export function serializeLang(entries: LangEntry[]): string {
  return `${entries.map(e => `${e.key}=${e.value}`).join('\n')}\n`
}

/**
 * GregTech ships as a Forge-style config block rather than a plain `.lang` file:
 *
 *   # Configuration file
 *
 *   languagefile {
 *       key=value
 *   }
 */
export function serializeGregTechLang(entries: LangEntry[]): string {
  const body = entries.map(e => `    ${e.key}=${e.value}`).join('\n')
  return `# Configuration file \n\nlanguagefile {\n${body}\n}\n`
}

/** Convert parsed entries into PT's string-item JSON (untranslated skeleton). */
export function langToPtItems(entries: LangEntry[]): PtStringItem[] {
  return entries.map(e => ({
    key: e.key,
    original: e.value,
    translation: '',
    stage: 0,
  }))
}

/** Reverse: PT string-items → lang entries. Uses `translation` as value. */
export function ptItemsToLang(items: PtStringItem[]): LangEntry[] {
  return items.map(i => ({ key: i.key, value: i.translation }))
}
