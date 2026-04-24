/**
 * Path rewriting between the three namespaces we deal with:
 *
 *   1. Filesystem  relpath: e.g. `resources/Applied Energistics 2[appliedenergistics2]/lang/en_US.lang`
 *   2. PT 18818    path:    e.g. `config/txloader/forceload/Applied Energistics 2[appliedenergistics2]/lang/zh_CN.lang.json`
 *   3. PT 4964     path:    e.g. `config/txloader/load/appliedenergistics2/lang/zh_CN.lang.json`
 *
 * Filesystem → PT 18818 preserves the full `<Display>[<modid>]` segment so
 * different resource packs sharing a modid (BiblioCraft family, Thaumcraft
 * addons) don't collide. PT 4964 on the other hand uses the txloader
 * convention of a bare modid, so cross-project matching has to pull the
 * modid out of 4964 paths and look it up against the bracketed segment in
 * 18818's file list.
 */

/** `resources/<seg>/lang/<file>` → `config/txloader/forceload/<seg>/lang/<file>`. */
const RESOURCES_LANG_RE = /^resources\/(.+\/lang\/.+)$/
const ARCHIVE_SUFFIX_RE = /\.achive(?:\.\d+)?$/

/** Match PT 18818's forceload path, capturing the modid from the brackets. */
export const TARGET_FORCELOAD_RE = /^config\/txloader\/forceload\/[^/]*\[([^\]]+)\]\/lang\//

/** Match PT 4964's txloader-style path, capturing the bare modid. */
export const SOURCE_TXLOADER_RE = /^config\/txloader\/(?:load|forceload)\/([^/[]+)\/lang\//
const SOURCE_BRACKET_MODID_RE = /\[([^\]]+)\]\/lang\//

/** Apply the resources→forceload rewrite. Non-matching paths pass through. */
export function rewriteTargetRelpath(relpath: string): string {
  const m = relpath.match(RESOURCES_LANG_RE)
  if (!m)
    return relpath
  return `config/txloader/forceload/${m[1]}`
}

/**
 * Strip upstream `(+N)` version markers that occasionally appear in the display
 * segment — e.g. `GregTech(+16)[bartworks]` → `GregTech[bartworks]`. The marker
 * immediately precedes `[` so we only match that position to avoid mangling
 * stray parens in other identifiers.
 */
export function stripVersionSuffix(path: string): string {
  return path.replace(/\(\+\d+\)(?=\[[^\]]+\])/g, '')
}

/** PT 4964 occasionally stores URL-escaped display segments. Decode when safe. */
function decodePathLossy(path: string): string {
  try {
    return decodeURIComponent(path)
  }
  catch {
    return path
  }
}

function extractSourceModId(sourceName: string): string | undefined {
  const tx = sourceName.match(SOURCE_TXLOADER_RE)
  if (tx)
    return tx[1]
  const bracket = sourceName.match(SOURCE_BRACKET_MODID_RE)
  return bracket?.[1]
}

/** Convert a `.lang` / `.txt` source path to PT's `.json` upload path. */
export function toPtJsonPath(relpath: string): string {
  if (relpath.endsWith('.json'))
    return relpath
  return `${relpath}.json`
}

/** Strip the `.json` suffix PT stamps on lang files. */
export function stripPtJsonSuffix(ptPath: string): string {
  return ptPath.endsWith('.json') ? ptPath.slice(0, -'.json'.length) : ptPath
}

/** Append the requested archive suffix used for files retired from the active daily set. */
export function toArchivePtPath(ptPath: string): string {
  const short = stripPtJsonSuffix(ptPath)
  return isArchivedPtPath(short) ? short : `${short}.achive`
}

/** Whether a PT path (short or `.json` form) is an archived file. */
export function isArchivedPtPath(ptPath: string): boolean {
  return ARCHIVE_SUFFIX_RE.test(stripPtJsonSuffix(ptPath))
}

/**
 * Find the 18818 file that should receive translations from a given 4964
 * file. Resolution order:
 *
 *   1. Exact name match (canonical form — `(+N)` stripped from both sides).
 *   2. 4964's mod-extracted lang lives at `resources/<Display>[<modid>]/...`
 *      while 18818 uploads the same content under `config/txloader/forceload/`.
 *      Rewrite `resources/` → `config/txloader/forceload/` and retry exact.
 *   3. Fallback: match by modid against 18818's bracketed segment.
 *      This also covers renamed `resources/<Display>[<modid>]` entries and
 *      URL-escaped display names such as `Witchery%2B%2B%5Bwitcheryextras%5D`.
 *      Ambiguous modids are intentionally omitted from the modid index so we
 *      don't silently route one 4964 file into the wrong 18818 target.
 */
export function resolve4964To18818<T extends { name: string }>(
  source4964Name: string,
  targetByName: Map<string, T>,
  targetByModId: Map<string, T>,
): T | undefined {
  const canonical = stripVersionSuffix(decodePathLossy(source4964Name))

  const exact = targetByName.get(canonical)
  if (exact != null)
    return exact

  if (canonical.startsWith('resources/')) {
    const rewritten = `config/txloader/forceload/${canonical.slice('resources/'.length)}`
    const hit = targetByName.get(rewritten)
    if (hit != null)
      return hit
  }

  // `config/txloader/load/...` and root files must match by exact name. Falling
  // back to the forceload modid index would silently route retired load files
  // (for example old betterquesting lang packs) into unrelated active targets.
  if (!canonical.startsWith('resources/') && !canonical.startsWith('config/txloader/forceload/'))
    return undefined

  const modId = extractSourceModId(canonical)
  if (modId)
    return targetByModId.get(modId)

  return undefined
}

/**
 * Build a modid-keyed view of 18818 files — used by `resolve4964To18818`.
 * Only unambiguous forceload files with a bracketed segment are indexed here.
 */
export function indexByModId<T extends { name: string }>(files: T[]): Map<string, T> {
  const unique = new Map<string, T>()
  const ambiguous = new Set<string>()
  for (const f of files) {
    const m = f.name.match(TARGET_FORCELOAD_RE)
    if (!m)
      continue
    const modId = m[1]
    if (ambiguous.has(modId))
      continue
    if (unique.has(modId)) {
      unique.delete(modId)
      ambiguous.add(modId)
      continue
    }
    unique.set(modId, f)
  }
  return unique
}
