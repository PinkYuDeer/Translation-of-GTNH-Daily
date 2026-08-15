/**
 * Shared configuration and environment bindings for the daily pipeline.
 *
 * All scripts under `.github/scripts/daily/` read their settings from this
 * module so we have one source of truth for PT project IDs, cache / build
 * directory layout, concurrency limits and retry timing.
 */

export const API_BASE = 'https://paratranz.cn/api'

// process.env is an alias of Bun.env under Bun; prefer it so the code also
// typechecks and runs cleanly under plain Node without bun-types in scope.
export const PT_4964_ID: string = process.env.PT_4964_ID ?? '4964'
export const PT_18818_ID: string = process.env.PT_18818_ID
  ?? process.env.PARATRANZ_DAILY_PROJECT_ID
  ?? '20315'

export const PARATRANZ_TOKEN: string = process.env.PARATRANZ_TOKEN ?? ''

export const CACHE_DIR: string = process.env.CACHE_DIR ?? '.cache'
export const BUILD_DIR: string = process.env.BUILD_DIR ?? '.build'
export const REPO_CACHE_DIR: string = process.env.REPO_CACHE_DIR ?? '.build/repo-cache'

/** Git-tracked archive dir (retired strings, tips key registry + changelog). */
export const REPO_ARCHIVE_DIR: string = process.env.REPO_ARCHIVE_DIR ?? 'archive'

/** Loading-screen tips paths. */
export const TIPS_PT_PATH = 'config/Betterloadingscreen/tips/zh_CN.lang'
/** Relative path of the finished tips file in the packaged Minecraft tree. */
export const TIPS_OUTPUT_REL = 'config/Betterloadingscreen/tips/zh_CN.txt'
/** Stable key registry, relative to REPO_ARCHIVE_DIR. */
export const TIPS_KEYMAP_FILE = 'tips/keymap.json'
/** Human-readable add/retire/reword/revive log, relative to REPO_ARCHIVE_DIR. */
export const TIPS_CHANGELOG_FILE = 'tips/changelog.md'
/**
 * Last-seen Kiwi233 zh line per tip key (`{key: line}`), relative to
 * REPO_ARCHIVE_DIR. Acts as the "is upstream's line new or stale?" baseline:
 * Kiwi233's tips file has no timestamps, so a changed line vs this snapshot is a
 * genuine upstream update we should take, while an unchanged line that differs
 * from our PT translation means ours is the ahead one and Kiwi's is stale.
 */
export const TIPS_KIWI_SEEN_FILE = 'tips/kiwi-seen.json'

export const CONCURRENCY = 5
export const RATE_LIMIT_RETRY_MS = 60_000

/** Upstream repos we sparse-clone during fetch-en. */
export const UPSTREAM = {
  translations: {
    repo: 'GTNewHorizons/GTNH-Translations',
    ref: 'master',
    sparse: ['daily-history'],
  },
  modpack: {
    repo: 'GTNewHorizons/GT-New-Horizons-Modpack',
    ref: 'master',
    sparse: ['config'],
  },
  kiwi: {
    repo: 'Kiwi233/Translation-of-GTNH',
    ref: 'master',
    sparse: [
      'config/InGameInfoXML',
      'config/Betterloadingscreen',
      'config/txloader/forceload/____gtnhoverridenames_zhcn',
      'resources/minecraft',
    ],
  },
} as const

/** Cache-file paths relative to CACHE_DIR. */
export const CACHE_PATHS = {
  enLastrun: 'en-lastrun',
  zhLastrun: 'zh-lastrun',
  fileIds: 'file-ids/files.json',
  stringIdsDir: 'file-ids',
  newlines: 'newlines.json',
  pendingUpdate: 'pending-update.json',
  staleIds: 'stale-ids.json',
  changedEn: 'changed-en.json',
  pushQueue: 'push-queue.json',
  filesToRefresh: 'files-to-refresh-ids.json',
} as const

export function assertToken(): void {
  if (!PARATRANZ_TOKEN) {
    // eslint-disable-next-line no-console
    console.error('PARATRANZ_TOKEN is not set')
    process.exit(1)
  }
}
