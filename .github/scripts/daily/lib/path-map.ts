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

/** Match PT 18818's forceload path, capturing the modid from the brackets. */
export const TARGET_FORCELOAD_RE = /^config\/txloader\/forceload\/[^/]*\[([^\]]+)\]\/lang\//

/** Match PT 4964's txloader-style path, capturing the bare modid. */
export const SOURCE_TXLOADER_RE = /^config\/txloader\/(?:load|forceload)\/([^/[]+)\/lang\//

/** Apply the resources→forceload rewrite. Non-matching paths pass through. */
export function rewriteTargetRelpath(relpath: string): string {
  const m = relpath.match(RESOURCES_LANG_RE)
  if (!m)
    return relpath
  return `config/txloader/forceload/${m[1]}`
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

/**
 * Find the 18818 file that should receive translations from a given 4964
 * file. Tries an exact name match first, then falls back to matching by the
 * modid captured from the 4964 path against 18818's bracketed segment.
 */
export function resolve4964To18818<T extends { name: string }>(
  source4964Name: string,
  targetByName: Map<string, T>,
  targetByModId: Map<string, T>,
): T | undefined {
  const exact = targetByName.get(source4964Name)
  if (exact != null)
    return exact
  const m = source4964Name.match(SOURCE_TXLOADER_RE)
  if (m)
    return targetByModId.get(m[1])
  return undefined
}

/**
 * Build a modid-keyed view of 18818 files — used by `resolve4964To18818`.
 * Only forceload files with a bracketed segment are indexed here.
 */
export function indexByModId<T extends { name: string }>(files: T[]): Map<string, T> {
  const out = new Map<string, T>()
  for (const f of files) {
    const m = f.name.match(TARGET_FORCELOAD_RE)
    if (m)
      out.set(m[1], f)
  }
  return out
}
