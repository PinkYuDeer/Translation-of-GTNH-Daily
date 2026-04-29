/**
 * Experimental source step for GregTech.lang.
 *
 * GT5-Unofficial writes GregTech.lang at runtime through Forge's Configuration
 * API. The checked-in copy in GTNH-Translations is manually uploaded, so the
 * freshest upstream is produced by starting a minimal GT5U dev server and
 * waiting until GT's postload phase saves the language file.
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
const MIN_ENTRIES = Number(process.env.GT5U_LANG_MIN_ENTRIES ?? 1000)

const OUT_ROOT = join(BUILD_DIR, 'generated-gregtech')
const OUT_LANG = join(OUT_ROOT, 'GregTech.lang')
const OUT_META = join(OUT_ROOT, 'metadata.json')

const POSTLOAD_MARKER = 'GTMod: PostLoad-Phase finished!'

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

function findGeneratedLang(serverDir: string): string | undefined {
  const candidates = [
    join(serverDir, 'GregTech.lang'),
    join(serverDir, 'config', 'GregTech.lang'),
  ]
  return candidates.find(p => existsSync(p) && statSync(p).isFile() && statSync(p).size > 0)
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

async function waitForPostloadLang(gt5uRoot: string): Promise<string> {
  const serverDir = join(gt5uRoot, 'run', 'server')
  await rm(serverDir, { recursive: true, force: true })
  await mkdir(serverDir, { recursive: true })
  await writeFile(join(serverDir, 'eula.txt'), 'eula=true\n', 'utf8')

  const gradlew = process.platform === 'win32' ? 'gradlew.bat' : './gradlew'
  const child = spawn(gradlew, ['--no-daemon', '--stacktrace', 'runServer'], {
    cwd: gt5uRoot,
    detached: process.platform !== 'win32',
    env: {
      ...process.env,
      GRADLE_OPTS: process.env.GRADLE_OPTS ?? '-Dorg.gradle.daemon=false -Xmx3g',
    },
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  let settled = false
  let checking = false
  let bufferedOutput = ''
  const logPath = join(serverDir, 'logs', 'GregTech.log')

  function appendOutput(chunk: Buffer): void {
    const text = chunk.toString()
    process.stdout.write(text)
    bufferedOutput = (bufferedOutput + text).slice(-50_000)
  }

  child.stdout.on('data', appendOutput)
  child.stderr.on('data', appendOutput)

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
      terminateTree(child)
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
        const gtLog = await readIfExists(logPath)
        const sawPostload = bufferedOutput.includes(POSTLOAD_MARKER) || gtLog.includes(POSTLOAD_MARKER)
        if (!sawPostload)
          return
        const langPath = findGeneratedLang(serverDir)
        if (!langPath)
          return
        finish(undefined, langPath)
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
      const langPath = findGeneratedLang(serverDir)
      const suffix = langPath ? `; partial file exists at ${langPath}` : ''
      finish(new Error(`timed out waiting for GT5U postload after ${TIMEOUT_MS}ms${suffix}`))
    }, TIMEOUT_MS)

    child.on('error', err => finish(err))
    child.on('exit', (code, signal) => {
      if (settled)
        return
      const langPath = findGeneratedLang(serverDir)
      const hint = langPath ? `; generated file exists but ${POSTLOAD_MARKER} was not observed` : ''
      finish(new Error(`GT5U runServer exited before GregTech.lang was complete (code=${code}, signal=${signal})${hint}`))
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

  const generated = await waitForPostloadLang(gt5uRoot)
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
