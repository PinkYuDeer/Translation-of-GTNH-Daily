/**
 * Experimental source step for GregTech.lang.
 *
 * GT5-Unofficial writes GregTech.lang at runtime through Forge's Configuration
 * API. The checked-in copy in GTNH-Translations is manually uploaded, so the
 * freshest upstream is produced by starting a minimal GT5U dev client under a
 * virtual X display, waiting until the client logs show a complete load, then
 * closing the Minecraft window normally so Forge/GT flushes the full language
 * file. GregTech.lang is often empty until that clean close happens.
 *
 * Output:
 *   .build/generated-gregtech/GregTech.lang
 *   .build/generated-gregtech/metadata.json
 */

import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, statSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import { BUILD_DIR, REPO_CACHE_DIR } from './lib/config.ts'
import { parseLang } from './lib/lang-parser.ts'

const GT5U_REPO = process.env.GT5U_REPO ?? 'https://github.com/GTNewHorizons/GT5-Unofficial.git'
const GT5U_REF = process.env.GT5U_REF ?? 'master'
const TIMEOUT_MS = Number(process.env.GT5U_LANG_TIMEOUT_MS ?? 30 * 60 * 1000)
const CLOSE_DELAY_MS = Number(process.env.GT5U_CLIENT_CLOSE_DELAY_MS ?? 10_000)
const SHUTDOWN_TIMEOUT_MS = Number(process.env.GT5U_CLIENT_SHUTDOWN_TIMEOUT_MS ?? 120_000)
const CLOSE_AFTER_POSTLOAD_MS = Number(process.env.GT5U_CLOSE_AFTER_POSTLOAD_MS ?? 180_000)
const MIN_ENTRIES = Number(process.env.GT5U_LANG_MIN_ENTRIES ?? 2_000)
const READY_MARKERS = (process.env.GT5U_CLIENT_READY_MARKERS ?? 'Forge Mod Loader has successfully loaded')
  .split('|')
  .map(s => s.trim())
  .filter(Boolean)
const XVFB_SCREEN = process.env.GT5U_XVFB_SCREEN ?? '1024x768x24'

const OUT_ROOT = join(BUILD_DIR, 'generated-gregtech')
const OUT_LANG = join(OUT_ROOT, 'GregTech.lang')
const OUT_META = join(OUT_ROOT, 'metadata.json')

const POSTLOAD_MARKER = 'GTMod: PostLoad-Phase finished!'

interface DisplaySession {
  env: NodeJS.ProcessEnv
  stop(): void
}

async function sleep(ms: number): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms))
}

function run(cmd: string, args: string[], cwd?: string): void {
  const r = spawnSync(cmd, args, { cwd, stdio: 'inherit', shell: false })
  if (r.status !== 0)
    throw new Error(`${cmd} ${args.join(' ')} failed (exit ${r.status})`)
}

function runCapture(cmd: string, args: string[], cwd?: string): string {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', shell: false })
  if (r.status !== 0)
    throw new Error(`${cmd} ${args.join(' ')} failed (exit ${r.status})`)
  return r.stdout.trim()
}

function runOptional(cmd: string, args: string[], env?: NodeJS.ProcessEnv): void {
  const r = spawnSync(cmd, args, { env, stdio: 'inherit', shell: false })
  if (r.status !== 0) {
    // eslint-disable-next-line no-console
    console.warn(`[gregtech-lang] optional command failed: ${cmd} ${args.join(' ')} (exit ${r.status})`)
  }
}

function ensureGt5uCheckout(): string {
  const root = join(REPO_CACHE_DIR, 'gt5u')
  if (!existsSync(join(root, '.git')))
    run('git', ['clone', '--depth=3', GT5U_REPO, root])
  else
    run('git', ['remote', 'set-url', 'origin', GT5U_REPO], root)

  run('git', ['fetch', '--depth=3', 'origin', GT5U_REF], root)
  run('git', ['checkout', '--detach', 'FETCH_HEAD'], root)
  run('git', ['reset', '--hard', 'FETCH_HEAD'], root)

  if (process.platform !== 'win32')
    run('chmod', ['+x', 'gradlew'], root)

  return root
}

async function readIfExists(path: string): Promise<string> {
  try {
    return await readFile(path, 'utf8')
  }
  catch {
    return ''
  }
}

async function rmIfExists(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true })
}

function findGeneratedLang(serverDir: string): string | undefined {
  const candidates = [
    join(serverDir, 'GregTech.lang'),
    join(serverDir, 'config', 'GregTech.lang'),
  ]
  return candidates.find(p => existsSync(p) && statSync(p).isFile() && statSync(p).size > 0)
}

function commandExists(cmd: string): boolean {
  const r = process.platform === 'win32'
    ? spawnSync('where', [cmd], { stdio: 'ignore', shell: false })
    : spawnSync('sh', ['-lc', 'command -v "$1" >/dev/null 2>&1', 'command-exists', cmd], { stdio: 'ignore' })
  return r.status === 0
}

async function startDisplay(): Promise<DisplaySession> {
  if (process.platform !== 'linux' || process.env.DISPLAY) {
    return {
      env: { ...process.env },
      stop() {},
    }
  }

  // eslint-disable-next-line no-console
  console.log('[gregtech-lang] checking Xvfb availability')
  if (!commandExists('Xvfb'))
    throw new Error('Xvfb is required for GT5U runClient on headless Linux')

  const display = `:${1000 + (process.pid % 1000)}`
  // eslint-disable-next-line no-console
  console.log(`[gregtech-lang] starting Xvfb on DISPLAY=${display}, screen=${XVFB_SCREEN}`)
  const child = spawn('Xvfb', [
    display,
    '-screen',
    '0',
    XVFB_SCREEN,
    '-ac',
    '+extension',
    'RANDR',
    '+extension',
    'GLX',
    '+render',
    '-noreset',
  ], {
    detached: true,
    stdio: 'ignore',
  })
  child.unref()

  // Give Xvfb a moment to bind the display before Java/LWJGL starts.
  await sleep(2_000)
  const env = {
    ...process.env,
    DISPLAY: display,
    LIBGL_ALWAYS_SOFTWARE: process.env.LIBGL_ALWAYS_SOFTWARE ?? '1',
    MESA_LOADER_DRIVER_OVERRIDE: process.env.MESA_LOADER_DRIVER_OVERRIDE ?? 'llvmpipe',
    ALSOFT_DRIVERS: process.env.ALSOFT_DRIVERS ?? 'null',
  }
  if (commandExists('xrandr')) {
    // eslint-disable-next-line no-console
    console.log('[gregtech-lang] xrandr display modes:')
    runOptional('xrandr', ['--display', display, '--query'], env)
  }
  else {
    // eslint-disable-next-line no-console
    console.warn('[gregtech-lang] xrandr is unavailable; LWJGL2 may crash while detecting display modes')
  }
  if (commandExists('glxinfo')) {
    // eslint-disable-next-line no-console
    console.log('[gregtech-lang] glxinfo summary:')
    runOptional('glxinfo', ['-display', display, '-B'], env)
  }

  return {
    env,
    stop() {
      terminateTree(child)
    },
  }
}

function terminateTree(child: ChildProcess): void {
  if (child.pid == null)
    return

  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore' })
    return
  }

  try {
    process.kill(-child.pid, 'SIGTERM')
  }
  catch {
    try {
      child.kill('SIGTERM')
    }
    catch {}
  }

  setTimeout(() => {
    if (child.killed)
      return
    try {
      process.kill(-child.pid!, 'SIGKILL')
    }
    catch {
      try {
        child.kill('SIGKILL')
      }
      catch {}
    }
  }, 5000).unref()
}

function requestClientClose(env: NodeJS.ProcessEnv): boolean {
  if (process.platform !== 'linux')
    return false
  if (!commandExists('xdotool')) {
    // eslint-disable-next-line no-console
    console.warn('[gregtech-lang] xdotool is unavailable; cannot close client window cleanly')
    return false
  }

  const attempts: string[][] = [
    ['search', '--name', 'Minecraft', 'windowclose'],
    ['search', '--class', 'Minecraft', 'windowclose'],
    ['search', '--class', 'LWJGL', 'windowclose'],
    ['key', '--clearmodifiers', 'Alt+F4'],
  ]
  for (const args of attempts) {
    const r = spawnSync('xdotool', args, { env, stdio: 'inherit', shell: false })
    if (r.status === 0)
      return true
  }
  return false
}

async function readClientLogs(clientDir: string): Promise<string> {
  const logs = await Promise.all([
    readIfExists(join(clientDir, 'logs', 'GregTech.log')),
    readIfExists(join(clientDir, 'logs', 'latest.log')),
    readIfExists(join(clientDir, 'logs', 'fml-client-latest.log')),
  ])
  return logs.join('\n')
}

async function prepareClientDir(clientDir: string): Promise<void> {
  // Do not remove the whole run/client directory: it can contain restored
  // Minecraft/Gradle assets and deleting it can be a long silent operation in
  // Actions. Remove only the stale language files and logs that affect this run.
  // eslint-disable-next-line no-console
  console.log(`[gregtech-lang] preparing client dir ${clientDir}`)
  await mkdir(clientDir, { recursive: true })
  await Promise.all([
    rmIfExists(join(clientDir, 'GregTech.lang')),
    rmIfExists(join(clientDir, 'config', 'GregTech.lang')),
    rmIfExists(join(clientDir, 'logs', 'GregTech.log')),
    rmIfExists(join(clientDir, 'logs', 'latest.log')),
    rmIfExists(join(clientDir, 'logs', 'fml-client-latest.log')),
  ])
  // eslint-disable-next-line no-console
  console.log('[gregtech-lang] client dir prepared')
}

function lastInterestingLine(text: string): string {
  const lines = text
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
  return lines.at(-1) ?? ''
}

async function waitForCompleteClientLang(gt5uRoot: string): Promise<string> {
  const clientDir = join(gt5uRoot, 'run', 'client')
  await prepareClientDir(clientDir)

  const gradlew = process.platform === 'win32' ? 'gradlew.bat' : './gradlew'
  const display = await startDisplay()
  // eslint-disable-next-line no-console
  console.log(`[gregtech-lang] starting ${gradlew} --no-daemon --stacktrace runClient`)
  const child = spawn(gradlew, ['--no-daemon', '--stacktrace', 'runClient'], {
    cwd: gt5uRoot,
    detached: process.platform !== 'win32',
    env: {
      ...display.env,
      GRADLE_OPTS: process.env.GRADLE_OPTS ?? '-Dorg.gradle.daemon=false -Xmx3g',
    },
    shell: false,
    // Keep Gradle/Minecraft stdout and stderr attached to the Actions log.
    // Marker detection reads the files under run/client/logs, so we do not
    // need to pipe and replay stdout here.
    stdio: ['ignore', 'inherit', 'inherit'],
  })

  let settled = false
  let checking = false
  let closeRequested = false
  let postloadSince: number | undefined
  let lastProgressLogAt = 0
  // eslint-disable-next-line no-console
  console.log(`[gregtech-lang] runClient pid=${child.pid ?? 'unknown'}`)

  return await new Promise<string>((resolvePromise, rejectPromise) => {
    let poll: NodeJS.Timeout | undefined
    let timeout: NodeJS.Timeout | undefined

    const finish = (err: Error | undefined, langPath?: string): void => {
      if (settled)
        return
      settled = true
      if (poll)
        clearInterval(poll)
      if (timeout)
        clearTimeout(timeout)
      if (err)
        terminateTree(child)
      display.stop()
      if (err)
        rejectPromise(err)
      else if (langPath)
        resolvePromise(langPath)
      else
        rejectPromise(new Error('internal error: missing generated lang path'))
    }

    const check = async (): Promise<void> => {
      if (checking || settled)
        return
      checking = true
      try {
        const logs = await readClientLogs(clientDir)
        const sawPostload = logs.includes(POSTLOAD_MARKER)
        const sawReady = READY_MARKERS.some(marker => logs.includes(marker))
        const now = Date.now()
        if (sawPostload && postloadSince == null)
          postloadSince = now

        if (now - lastProgressLogAt > 30_000) {
          lastProgressLogAt = now
          const langPath = findGeneratedLang(clientDir)
          const langBytes = langPath ? statSync(langPath).size : 0
          // eslint-disable-next-line no-console
          console.log(
            `[gregtech-lang] progress postload=${sawPostload} ready=${sawReady} `
            + `langBytes=${langBytes} last="${lastInterestingLine(logs).slice(0, 240)}"`,
          )
        }

        const postloadWaitMs = postloadSince == null ? 0 : now - postloadSince
        const shouldClose = sawPostload && (sawReady || postloadWaitMs >= CLOSE_AFTER_POSTLOAD_MS)
        if (!shouldClose || closeRequested)
          return

        closeRequested = true
        // eslint-disable-next-line no-console
        console.log(
          `[gregtech-lang] client load accepted (ready=${sawReady}, postloadWait=${postloadWaitMs}ms); `
          + `closing window after ${CLOSE_DELAY_MS}ms`,
        )
        setTimeout(() => {
          if (settled)
            return
          const ok = requestClientClose(display.env)
          if (!ok)
            finish(new Error('failed to close Minecraft client window; install xdotool or provide a DISPLAY'))

          setTimeout(() => {
            if (settled)
              return
            finish(new Error(`client did not exit within ${SHUTDOWN_TIMEOUT_MS}ms after close request`))
          }, SHUTDOWN_TIMEOUT_MS).unref()
        }, CLOSE_DELAY_MS).unref()
      }
      catch (err) {
        finish(err instanceof Error ? err : new Error(String(err)))
      }
      finally {
        checking = false
      }
    }

    poll = setInterval(() => void check(), 1000)
    timeout = setTimeout(() => {
      const langPath = findGeneratedLang(clientDir)
      const suffix = langPath ? `; partial file exists at ${langPath}` : ''
      finish(new Error(`timed out waiting for GT5U client readiness after ${TIMEOUT_MS}ms${suffix}`))
    }, TIMEOUT_MS)

    child.on('error', err => finish(err))
    child.on('exit', (code, signal) => {
      if (settled)
        return
      const langPath = findGeneratedLang(clientDir)
      if (closeRequested && langPath) {
        finish(undefined, langPath)
        return
      }
      const hint = langPath
        ? `; generated file exists but readiness markers were incomplete`
        : ''
      finish(new Error(`GT5U runClient exited before GregTech.lang was complete (code=${code}, signal=${signal})${hint}`))
    })
  })
}

async function main(): Promise<void> {
  await mkdir(REPO_CACHE_DIR, { recursive: true })
  await rm(OUT_ROOT, { recursive: true, force: true })
  await mkdir(OUT_ROOT, { recursive: true })

  const gt5uRoot = ensureGt5uCheckout()
  const commit = runCapture('git', ['rev-parse', 'HEAD'], gt5uRoot)
  // eslint-disable-next-line no-console
  console.log(`[gregtech-lang] generating from ${GT5U_REPO}@${commit}`)

  const generated = await waitForCompleteClientLang(gt5uRoot)
  const content = await readFile(generated, 'utf8')
  const entries = parseLang(content)
  if (entries.length < MIN_ENTRIES)
    throw new Error(`generated GregTech.lang has only ${entries.length} entries (min ${MIN_ENTRIES})`)

  await writeFile(OUT_LANG, content, 'utf8')
  const sha256 = createHash('sha256').update(content).digest('hex')
  await writeFile(
    OUT_META,
    `${JSON.stringify({
      repo: GT5U_REPO,
      ref: GT5U_REF,
      commit,
      mode: 'runClient',
      readyMarkers: READY_MARKERS,
      sourcePath: resolve(generated),
      outputPath: resolve(OUT_LANG),
      entries: entries.length,
      sha256,
      generatedAt: new Date().toISOString(),
    }, null, 2)}\n`,
    'utf8',
  )

  // eslint-disable-next-line no-console
  console.log(`[gregtech-lang] wrote ${OUT_LANG} (${entries.length} entries, sha256=${sha256})`)
}

void main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[gregtech-lang] failed:', err)
  process.exit(1)
})
