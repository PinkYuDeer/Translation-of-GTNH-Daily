/**
 * Experimental source step for GregTech.lang.
 *
 * GT5-Unofficial writes GregTech.lang at runtime through Forge's Configuration
 * API. The checked-in copy in GTNH-Translations is manually uploaded, so the
 * freshest upstream is produced by starting a minimal GT5U dev client under a
 * virtual X display, injecting a temporary client probe mod that enters a
 * singleplayer world, then shuts down the client normally so Forge/GT flushes
 * the full language file. GregTech.lang can miss late world-load entries until
 * that point has been reached and shut down.
 *
 * Output:
 *   .build/generated-gregtech/GregTech.lang
 *   .build/generated-gregtech/metadata.json
 *
 * Cache:
 *   .cache/generated-gregtech/GregTech.lang
 *   .cache/generated-gregtech/metadata.json
 */

import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, statSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

import { BUILD_DIR, CACHE_DIR, REPO_CACHE_DIR } from './lib/config.ts'
import { parseLang } from './lib/lang-parser.ts'

const GT5U_REPO = process.env.GT5U_REPO ?? 'https://github.com/GTNewHorizons/GT5-Unofficial.git'
const GT5U_REF = process.env.GT5U_REF ?? 'master'
const RUN_CLIENT_TASK = process.env.GT5U_RUN_CLIENT_TASK ?? 'runClient25'
const GRADLE_RUN_ARGS = ['--no-daemon', '--no-configuration-cache', '--stacktrace', RUN_CLIENT_TASK]
const TIMEOUT_MS = Number(process.env.GT5U_LANG_TIMEOUT_MS ?? 30 * 60 * 1000)
const CLOSE_AFTER_POSTLOAD_MS = Number(process.env.GT5U_CLOSE_AFTER_POSTLOAD_MS ?? 180_000)
const WORLD_SETTLE_MS = Number(process.env.GT5U_WORLD_SETTLE_MS ?? 0)
const WORLD_NAME = process.env.GT5U_WORLD_NAME ?? 'GTNHLangProbe'
const MIN_ENTRIES = Number(process.env.GT5U_LANG_MIN_ENTRIES ?? 2_000)
const USE_CACHE_ONLY = envFlag(process.env.GT5U_LANG_USE_CACHE_ONLY)
const USE_EXISTING_DISPLAY = envFlag(process.env.GT5U_USE_EXISTING_DISPLAY)
const READY_MARKERS = (process.env.GT5U_CLIENT_READY_MARKERS ?? 'Forge Mod Loader has successfully loaded')
  .split('|')
  .map(s => s.trim())
  .filter(Boolean)
const WORLD_START_MARKERS = (process.env.GT5U_WORLD_START_MARKERS ?? 'Starting integrated minecraft server|Preparing start region for level 0')
  .split('|')
  .map(s => s.trim())
  .filter(Boolean)
const WORLD_READY_MARKERS = (process.env.GT5U_WORLD_READY_MARKERS ?? 'Done (|logged in with entity id|Changing view distance to')
  .split('|')
  .map(s => s.trim())
  .filter(Boolean)
const XVFB_SCREEN = process.env.GT5U_XVFB_SCREEN ?? '1024x768x24'

const OUT_ROOT = join(BUILD_DIR, 'generated-gregtech')
const OUT_LANG = join(OUT_ROOT, 'GregTech.lang')
const OUT_META = join(OUT_ROOT, 'metadata.json')
const CACHE_ROOT = join(CACHE_DIR, 'generated-gregtech')
const CACHE_LANG = join(CACHE_ROOT, 'GregTech.lang')
const CACHE_META = join(CACHE_ROOT, 'metadata.json')
const MCP_CONF_DIR = process.env.GT5U_MCP_CONF_DIR
  ?? join(
    process.env.GRADLE_USER_HOME ?? join(homedir(), '.gradle'),
    'caches',
    'minecraft',
    'net',
    'minecraftforge',
    'forge',
    '1.7.10-10.13.4.1614-1.7.10',
    'unpacked',
    'conf',
  )
const LANG_RUNTIME_BLOCK_START = '    // GTNH Daily lang generation optional runtime dependencies start'
const LANG_RUNTIME_BLOCK_END = '    // GTNH Daily lang generation optional runtime dependencies end'
const LANG_RUNTIME_DEPENDENCIES = [
  {
    name: 'com.github.GTNewHorizons:bdlib:1.11.0-GTNH:dev',
    declaration: 'runtimeOnlyNonPublishable("com.github.GTNewHorizons:bdlib:1.11.0-GTNH:dev") { transitive = false }',
  },
  {
    name: 'com.github.GTNewHorizons:ForestryMC:4.11.15:dev',
    declaration: 'runtimeOnlyNonPublishable("com.github.GTNewHorizons:ForestryMC:4.11.15:dev") { transitive = false }',
  },
  {
    name: 'com.github.GTNewHorizons:gendustry:1.9.9-GTNH:dev',
    declaration: 'runtimeOnlyNonPublishable("com.github.GTNewHorizons:gendustry:1.9.9-GTNH:dev") { transitive = false }',
  },
  {
    name: 'com.github.GTNewHorizons:MatterManipulator:0.1.31-GTNH:dev',
    declaration: 'runtimeOnlyNonPublishable("com.github.GTNewHorizons:MatterManipulator:0.1.31-GTNH:dev") { transitive = false }',
  },
  {
    name: 'com.cubefury.vendingmachine:VendingMachine:0.4.65:dev',
    declaration: 'runtimeOnlyNonPublishable("com.cubefury.vendingmachine:VendingMachine:0.4.65:dev") { transitive = false }',
  },
] as const
const LANG_FLUID_STUBS = ['endergoo'] as const

const POSTLOAD_MARKER = 'GTMod: PostLoad-Phase finished!'
const PROBE_WORLD_READY_MARKER = '[GTNHLangProbe] world ready'
const PROBE_SHUTDOWN_MARKER = '[GTNHLangProbe] requesting Minecraft shutdown'
const LANG_PROBE_SOURCE_PATH = join('src', 'main', 'java', 'gtnh', 'langprobe', 'GTNHLangProbe.java')

interface DisplaySession {
  env: NodeJS.ProcessEnv
  stop(): void
}

function envFlag(value: string | undefined): boolean {
  return /^(?:1|true|yes|on)$/i.test((value ?? '').trim())
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

function indentGradleDeclaration(declaration: string): string {
  return declaration
    .split('\n')
    .map(line => line.length > 0 ? `    ${line}` : line)
    .join('\n')
}

interface GradleDependencyDeclaration {
  declaration: string
  identity: string
  name: string
}

function dependencyIdentity(declaration: string): string {
  return declaration.match(/["']([^"']+)["']/)?.[1] ?? declaration.replace(/\s+/g, ' ').trim()
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function hasRuntimeDependency(content: string, identity: string): boolean {
  const escapedIdentity = escapeRegExp(identity)
  return new RegExp(`^\\s*(?:runtimeOnlyNonPublishable|devOnlyNonPublishable|runtimeOnly)\\b.*["']${escapedIdentity}["']`, 'm')
    .test(content)
}

async function enableLangRuntimeIntegrations(gt5uRoot: string): Promise<string[]> {
  const dependencyPath = join(gt5uRoot, 'dependencies.gradle')
  const content = await readFile(dependencyPath, 'utf8')
  let next = content
  const additions: GradleDependencyDeclaration[] = LANG_RUNTIME_DEPENDENCIES
    .map(dependency => ({ ...dependency, identity: dependencyIdentity(dependency.declaration) }))
    .filter(dependency => !hasRuntimeDependency(next, dependency.identity))
  if (additions.length > 0) {
    const block = [
      LANG_RUNTIME_BLOCK_START,
      ...additions.map(dependency => indentGradleDeclaration(dependency.declaration)),
      LANG_RUNTIME_BLOCK_END,
      '',
    ].join('\n')
    const dependenciesStart = /^dependencies\s*\{\s*$/m
    if (!dependenciesStart.test(next))
      throw new Error(`could not find dependencies block in ${dependencyPath}`)
    next = next.replace(dependenciesStart, match => `${match}\n${block}`)
    await writeFile(dependencyPath, next, 'utf8')
  }

  // eslint-disable-next-line no-console
  console.log(`[gregtech-lang] enabled ${additions.length} GT5U focused runtime dependencies for lang generation`)
  return additions.map(dependency => dependency.name)
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

function validateLangContent(content: string, label: string): { entries: number, sha256: string } {
  const entries = parseLang(content)
  if (entries.length < MIN_ENTRIES)
    throw new Error(`${label} GregTech.lang has only ${entries.length} entries (min ${MIN_ENTRIES})`)
  return {
    entries: entries.length,
    sha256: createHash('sha256').update(content).digest('hex'),
  }
}

async function readJsonIfExists(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as unknown
  }
  catch {
    return undefined
  }
}

async function writeGeneratedOutput(content: string, meta: Record<string, unknown>): Promise<void> {
  await mkdir(OUT_ROOT, { recursive: true })
  await writeFile(OUT_LANG, content, 'utf8')
  await writeFile(OUT_META, `${JSON.stringify(meta, null, 2)}\n`, 'utf8')
}

async function writeLangCache(content: string, meta: Record<string, unknown>): Promise<void> {
  await mkdir(CACHE_ROOT, { recursive: true })
  await writeFile(CACHE_LANG, content, 'utf8')
  await writeFile(
    CACHE_META,
    `${JSON.stringify({
      ...meta,
      cachePath: resolve(CACHE_LANG),
      cachedAt: new Date().toISOString(),
    }, null, 2)}\n`,
    'utf8',
  )
}

async function restoreFromLangCache(mode: 'cache-only' | 'cache-fallback', reason?: unknown): Promise<void> {
  if (!existsSync(CACHE_LANG)) {
    const message = mode === 'cache-only'
      ? `missing cached GregTech.lang at ${CACHE_LANG}; GT5U_LANG_USE_CACHE_ONLY=1 will not run GT5U as a fallback`
      : `missing cached GregTech.lang at ${CACHE_LANG}`
    throw new Error(message)
  }

  const content = await readFile(CACHE_LANG, 'utf8')
  const { entries, sha256 } = validateLangContent(content, 'cached')
  const cachedMeta = await readJsonIfExists(CACHE_META)
  const meta = {
    mode,
    cachePath: resolve(CACHE_LANG),
    outputPath: resolve(OUT_LANG),
    entries,
    sha256,
    restoredAt: new Date().toISOString(),
    ...(cachedMeta != null ? { cachedMeta } : {}),
    ...(reason instanceof Error ? { fallbackReason: reason.message } : reason != null ? { fallbackReason: String(reason) } : {}),
  }

  await writeGeneratedOutput(content, meta)
  // eslint-disable-next-line no-console
  console.log(`[gregtech-lang] restored ${OUT_LANG} from cache (${entries} entries, sha256=${sha256}, mode=${mode})`)
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

function defaultXdgDataHome(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.XDG_DATA_HOME?.trim()
  return configured ? resolve(configured) : join(homedir(), '.local', 'share')
}

function withHeadlessClientEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (process.platform !== 'linux')
    return { ...env }

  return {
    ...env,
    XDG_DATA_HOME: env.XDG_DATA_HOME?.trim() ? env.XDG_DATA_HOME : defaultXdgDataHome(env),
    LIBGL_ALWAYS_SOFTWARE: env.LIBGL_ALWAYS_SOFTWARE ?? '1',
    MESA_LOADER_DRIVER_OVERRIDE: env.MESA_LOADER_DRIVER_OVERRIDE ?? 'llvmpipe',
    ALSOFT_DRIVERS: env.ALSOFT_DRIVERS ?? 'null',
  }
}

async function ensureLinuxDataHome(): Promise<void> {
  if (process.platform !== 'linux')
    return

  const xdgDataHome = defaultXdgDataHome()
  if (!process.env.XDG_DATA_HOME?.trim())
    process.env.XDG_DATA_HOME = xdgDataHome
  await mkdir(join(xdgDataHome, 'applications'), { recursive: true })
  // eslint-disable-next-line no-console
  console.log(`[gregtech-lang] ensured XDG_DATA_HOME=${xdgDataHome}`)
}

function javaStringLiteral(value: string): string {
  return `"${value
    .replaceAll('\\', '\\\\')
    .replaceAll('"', '\\"')
    .replaceAll('\n', '\\n')
    .replaceAll('\r', '\\r')
    .replaceAll('\t', '\\t')}"`
}

function langProbeSource(worldName: string, worldSettleMs: number): string {
  return [
    'package gtnh.langprobe;',
    '',
    'import cpw.mods.fml.common.FMLCommonHandler;',
    'import cpw.mods.fml.common.FMLLog;',
    'import cpw.mods.fml.common.Mod;',
    'import cpw.mods.fml.common.event.FMLInitializationEvent;',
    'import cpw.mods.fml.common.event.FMLPreInitializationEvent;',
    'import cpw.mods.fml.common.eventhandler.SubscribeEvent;',
    'import cpw.mods.fml.common.gameevent.TickEvent;',
    'import cpw.mods.fml.relauncher.Side;',
    'import net.minecraft.client.Minecraft;',
    'import net.minecraft.world.WorldSettings;',
    'import net.minecraft.world.WorldType;',
    'import net.minecraftforge.fluids.Fluid;',
    'import net.minecraftforge.fluids.FluidRegistry;',
    'import net.minecraftforge.fluids.FluidStack;',
    '',
    '@Mod(modid = "gtnh_lang_probe", name = "GTNH Lang Probe", version = "1.0", acceptableRemoteVersions = "*", dependencies = "before:gregtech;before:gtnhintergalactic;before:galacticgreg")',
    'public final class GTNHLangProbe {',
    `    private static final String WORLD_NAME = ${javaStringLiteral(worldName)};`,
    `    private static final long WORLD_SETTLE_MS = ${Math.max(0, Math.trunc(worldSettleMs))}L;`,
    '    private boolean launched;',
    '    private boolean shutdownRequested;',
    '    private long worldReadyAt;',
    '',
    '    @Mod.EventHandler',
    '    public void preInit(FMLPreInitializationEvent event) {',
    '        registerFluidStub("endergoo", "Ender Goo");',
    '    }',
    '',
    '    @Mod.EventHandler',
    '    public void init(FMLInitializationEvent event) {',
    '        if (FMLCommonHandler.instance().getSide() == Side.CLIENT) {',
    '            FMLCommonHandler.instance().bus().register(this);',
    '            FMLLog.info("[GTNHLangProbe] registered client world launcher");',
    '        }',
    '    }',
    '',
    '    private static void registerFluidStub(String fluidName, String localizedName) {',
    '        if (FluidRegistry.getFluid(fluidName) != null) {',
    '            return;',
    '        }',
    '',
    '        FluidRegistry.registerFluid(new LangProbeFluid(fluidName, localizedName));',
    '        FMLLog.info("[GTNHLangProbe] registered lang-only fluid stub %s", fluidName);',
    '    }',
    '',
    '    private static final class LangProbeFluid extends Fluid {',
    '        private final String localizedName;',
    '',
    '        private LangProbeFluid(String fluidName, String localizedName) {',
    '            super(fluidName);',
    '            this.localizedName = localizedName;',
    '        }',
    '',
    '        @Override',
    '        public String getLocalizedName(FluidStack stack) {',
    '            return localizedName;',
    '        }',
    '',
    '        @Override',
    '        public String getLocalizedName() {',
    '            return localizedName;',
    '        }',
    '    }',
    '',
    '    @SubscribeEvent',
    '    public void onClientTick(TickEvent.ClientTickEvent event) {',
    '        if (event.phase != TickEvent.Phase.END || shutdownRequested) {',
    '            return;',
    '        }',
    '',
    '        Minecraft mc = Minecraft.getMinecraft();',
    '        if (mc == null) {',
    '            return;',
    '        }',
    '',
    '        if (!launched) {',
    '            if (mc.theWorld != null || mc.currentScreen == null) {',
    '                return;',
    '            }',
    '',
    '            launched = true;',
    '            FMLLog.info("[GTNHLangProbe] launching integrated server world %s from screen %s", WORLD_NAME, mc.currentScreen.getClass().getName());',
    '            WorldSettings settings = new WorldSettings(1L, WorldSettings.GameType.CREATIVE, true, false, WorldType.DEFAULT);',
    '            settings.enableCommands();',
    '            mc.launchIntegratedServer(WORLD_NAME, WORLD_NAME, settings);',
    '            return;',
    '        }',
    '',
    '        if (mc.theWorld == null || mc.thePlayer == null) {',
    '            return;',
    '        }',
    '',
    '        long now = System.currentTimeMillis();',
    '        if (worldReadyAt == 0L) {',
    '            worldReadyAt = now;',
    '            FMLLog.info("[GTNHLangProbe] world ready; shutdown in %dms", WORLD_SETTLE_MS);',
    '        }',
    '',
    '        long settleMs = now - worldReadyAt;',
    '        if (settleMs < WORLD_SETTLE_MS) {',
    '            return;',
    '        }',
    '',
    '        shutdownRequested = true;',
    '        FMLLog.info("[GTNHLangProbe] requesting Minecraft shutdown after %dms world settle", settleMs);',
    '        mc.shutdown();',
    '    }',
    '}',
    '',
  ].join('\n')
}

async function injectLangProbeMod(gt5uRoot: string): Promise<void> {
  const sourcePath = join(gt5uRoot, LANG_PROBE_SOURCE_PATH)
  await mkdir(join(gt5uRoot, 'src', 'main', 'java', 'gtnh', 'langprobe'), { recursive: true })
  await writeFile(sourcePath, langProbeSource(WORLD_NAME, WORLD_SETTLE_MS), 'utf8')
  // eslint-disable-next-line no-console
  console.log(`[gregtech-lang] injected headless lang probe mod at ${sourcePath}`)
}

async function startDisplay(): Promise<DisplaySession> {
  if (process.platform !== 'linux' || (process.env.DISPLAY && USE_EXISTING_DISPLAY)) {
    return {
      env: withHeadlessClientEnv(process.env),
      stop() {},
    }
  }

  // eslint-disable-next-line no-console
  console.log('[gregtech-lang] checking Xvfb availability')
  if (!commandExists('Xvfb')) {
    if (process.env.DISPLAY) {
      // eslint-disable-next-line no-console
      console.log('[gregtech-lang] Xvfb unavailable; falling back to existing DISPLAY')
      return {
        env: withHeadlessClientEnv(process.env),
        stop() {},
      }
    }
    throw new Error(`Xvfb is required for GT5U ${RUN_CLIENT_TASK} on headless Linux`)
  }

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
  const env = withHeadlessClientEnv({
    ...process.env,
    DISPLAY: display,
  })
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
  await ensureLinuxDataHome()
  await mkdir(clientDir, { recursive: true })
  await Promise.all([
    rmIfExists(join(clientDir, 'GregTech.lang')),
    rmIfExists(join(clientDir, 'config', 'GregTech.lang')),
    rmIfExists(join(clientDir, 'logs', 'GregTech.log')),
    rmIfExists(join(clientDir, 'logs', 'latest.log')),
    rmIfExists(join(clientDir, 'logs', 'fml-client-latest.log')),
    rmIfExists(join(clientDir, 'saves', WORLD_NAME)),
  ])
  await Promise.all([
    writeCodeChickenLibConfig(clientDir),
    writeDreamCoreModConfig(clientDir),
    writeLwjgl3ifyConfig(clientDir),
    writeAppliedEnergisticsConfig(clientDir),
  ])
  // eslint-disable-next-line no-console
  console.log('[gregtech-lang] client dir prepared')
}

async function writeCodeChickenLibConfig(clientDir: string): Promise<void> {
  const configDir = join(clientDir, 'config')
  await mkdir(configDir, { recursive: true })
  await writeFile(
    join(configDir, 'CodeChickenLib.cfg'),
    [
      '#CodeChickenLib development configuration file.',
      '',
      '#Path to directory holding packaged.srg, fields.csv and methods.csv for mcp remapping',
      `mappingDir=${MCP_CONF_DIR}`,
      '',
    ].join('\n'),
    'utf8',
  )
  // eslint-disable-next-line no-console
  console.log(`[gregtech-lang] configured CodeChickenLib mappingDir=${MCP_CONF_DIR}`)
}

async function writeDreamCoreModConfig(clientDir: string): Promise<void> {
  const configDir = join(clientDir, 'config')
  await mkdir(configDir, { recursive: true })
  await writeFile(
    join(configDir, 'DreamCoreMod.properties'),
    [
      '#Config file for the ASM part of GTNHCoreMod',
      'showConfirmExitWindow=false',
      '',
    ].join('\n'),
    'utf8',
  )
  // eslint-disable-next-line no-console
  console.log('[gregtech-lang] disabled DreamCoreMod confirm-exit window')
}

function upsertForgeBoolean(content: string, category: string, key: string, value: boolean): string {
  const desiredValue = value ? 'true' : 'false'
  const lines = content.split(/\r?\n/)
  const keyPattern = new RegExp(`^(\\s*)B:${escapeRegExp(key)}=.*$`)
  let updatedExisting = false

  const nextLines = lines.map((line) => {
    const match = line.match(keyPattern)
    if (!match)
      return line
    updatedExisting = true
    return `${match[1]}B:${key}=${desiredValue}`
  })
  if (updatedExisting)
    return nextLines.join('\n')

  const categoryPattern = new RegExp(`^\\s*${escapeRegExp(category)}\\s*\\{\\s*$`)
  const categoryIndex = nextLines.findIndex(line => categoryPattern.test(line))
  if (categoryIndex >= 0) {
    nextLines.splice(categoryIndex + 1, 0, `    B:${key}=${desiredValue}`)
    return nextLines.join('\n')
  }

  const trimmed = content.replace(/\s*$/, '')
  const prefix = trimmed.length > 0 ? `${trimmed}\n\n` : ''
  return `${prefix}${category} {\n    B:${key}=${desiredValue}\n}\n`
}

async function writeLwjgl3ifyConfig(clientDir: string): Promise<void> {
  const configDir = join(clientDir, 'config')
  const configPath = join(configDir, 'lwjgl3ify.cfg')
  await mkdir(configDir, { recursive: true })
  const existing = await readIfExists(configPath)
  const base = existing.length > 0 ? existing : '# Configuration file\n'
  const next = upsertForgeBoolean(base, 'window', 'linuxCreateAppDesktopEntry', false)
  await writeFile(configPath, next, 'utf8')
  // eslint-disable-next-line no-console
  console.log('[gregtech-lang] disabled lwjgl3ify Linux desktop entry creation')
}

async function writeAppliedEnergisticsConfig(clientDir: string): Promise<void> {
  const configDir = join(clientDir, 'config', 'AppliedEnergistics2')
  const configPath = join(configDir, 'AppliedEnergistics2.cfg')
  await mkdir(configDir, { recursive: true })
  const existing = await readIfExists(configPath)
  const base = existing.length > 0 ? existing : '# Configuration file\n'
  const next = upsertForgeBoolean(base, 'general', 'exportItemNames', false)
  await writeFile(configPath, next, 'utf8')
  // eslint-disable-next-line no-console
  console.log('[gregtech-lang] disabled Applied Energistics 2 item CSV export')
}

function lastInterestingLine(text: string): string {
  const lines = text
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
  return lines.at(-1) ?? ''
}

function firstMarkerIndex(text: string, markers: string[]): number {
  let first = -1
  for (const marker of markers) {
    const idx = text.indexOf(marker)
    if (idx >= 0 && (first < 0 || idx < first))
      first = idx
  }
  return first
}

function sawWorldStarted(logs: string): boolean {
  return firstMarkerIndex(logs, WORLD_START_MARKERS) >= 0
}

function sawWorldReady(logs: string): boolean {
  if (!sawWorldStarted(logs))
    return false
  return WORLD_READY_MARKERS.some(marker => logs.includes(marker))
}

function missingRuntimeDependencyMessage(logs: string): string | undefined {
  const match = logs.match(/The mod .+ requires mods \[[^\]]+\] to be available/)
  return match?.[0]
}

async function waitForCompleteClientLang(gt5uRoot: string): Promise<string> {
  const clientDir = join(gt5uRoot, 'run', 'client')
  await prepareClientDir(clientDir)

  const gradlew = process.platform === 'win32' ? 'gradlew.bat' : './gradlew'
  const display = await startDisplay()
  // eslint-disable-next-line no-console
  console.log(`[gregtech-lang] starting ${gradlew} ${GRADLE_RUN_ARGS.join(' ')}`)
  const child = spawn(gradlew, GRADLE_RUN_ARGS, {
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
  let shutdownRequested = false
  let waitingForWorld = false
  let probeWorldReady = false
  let waitingForProbeShutdownLogged = false
  let postloadSince: number | undefined
  let worldReadySince: number | undefined
  let lastProgressLogAt = 0
  // eslint-disable-next-line no-console
  console.log(`[gregtech-lang] ${RUN_CLIENT_TASK} pid=${child.pid ?? 'unknown'}`)

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
        const worldStarted = sawWorldStarted(logs)
        const worldReady = sawWorldReady(logs)
        const sawProbeWorldReady = logs.includes(PROBE_WORLD_READY_MARKER)
        const sawProbeShutdown = logs.includes(PROBE_SHUTDOWN_MARKER)
        const missingDependency = missingRuntimeDependencyMessage(logs)
        const now = Date.now()
        if (missingDependency) {
          finish(new Error(`GT5U ${RUN_CLIENT_TASK} stopped on missing runtime dependency screen: ${missingDependency}`))
          return
        }
        if (sawPostload && postloadSince == null)
          postloadSince = now
        if (worldReady && worldReadySince == null) {
          worldReadySince = now
          // eslint-disable-next-line no-console
          console.log(`[gregtech-lang] temporary world ${WORLD_NAME} reached ready markers`)
        }
        if (sawProbeWorldReady && !probeWorldReady) {
          probeWorldReady = true
          // eslint-disable-next-line no-console
          console.log('[gregtech-lang] injected probe reached temporary world')
        }
        if (sawProbeShutdown && !shutdownRequested) {
          shutdownRequested = true
          // eslint-disable-next-line no-console
          console.log('[gregtech-lang] injected probe requested Minecraft shutdown')
        }

        if (now - lastProgressLogAt > 30_000) {
          lastProgressLogAt = now
          const langPath = findGeneratedLang(clientDir)
          const langBytes = langPath ? statSync(langPath).size : 0
          // eslint-disable-next-line no-console
          console.log(
            `[gregtech-lang] progress postload=${sawPostload} ready=${sawReady} `
            + `waitingForWorld=${waitingForWorld} worldStarted=${worldStarted} worldReady=${worldReady} `
            + `probeWorldReady=${sawProbeWorldReady} probeShutdown=${sawProbeShutdown} `
            + `langBytes=${langBytes} last="${lastInterestingLine(logs).slice(0, 240)}"`,
          )
        }

        const postloadWaitMs = postloadSince == null ? 0 : now - postloadSince
        const shouldEnterWorld = sawPostload && (sawReady || postloadWaitMs >= CLOSE_AFTER_POSTLOAD_MS)
        if (shouldEnterWorld && !waitingForWorld) {
          waitingForWorld = true
          // eslint-disable-next-line no-console
          console.log(
            `[gregtech-lang] client load accepted (ready=${sawReady}, postloadWait=${postloadWaitMs}ms); `
            + `waiting for injected probe mod to enter temporary world ${WORLD_NAME}`,
          )
          return
        }

        if (probeWorldReady && !shutdownRequested && !waitingForProbeShutdownLogged) {
          if (sawProbeWorldReady) {
            waitingForProbeShutdownLogged = true
            // eslint-disable-next-line no-console
            console.log(
              `[gregtech-lang] temporary world accepted; waiting ${WORLD_SETTLE_MS}ms for injected probe shutdown`,
            )
          }
        }
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
      if (code === 0 && langPath && (shutdownRequested || worldReadySince != null)) {
        finish(undefined, langPath)
        return
      }
      const hint = langPath
        ? `; generated file exists but readiness markers were incomplete`
        : ''
      finish(new Error(`GT5U ${RUN_CLIENT_TASK} exited before GregTech.lang was complete (code=${code}, signal=${signal})${hint}`))
    })
  })
}

async function generateFresh(): Promise<void> {
  const gt5uRoot = ensureGt5uCheckout()
  const commit = runCapture('git', ['rev-parse', 'HEAD'], gt5uRoot)
  // eslint-disable-next-line no-console
  console.log(`[gregtech-lang] generating from ${GT5U_REPO}@${commit}`)

  const runtimeIntegrations = await enableLangRuntimeIntegrations(gt5uRoot)
  await injectLangProbeMod(gt5uRoot)
  const generated = await waitForCompleteClientLang(gt5uRoot)
  const content = await readFile(generated, 'utf8')
  const { entries, sha256 } = validateLangContent(content, 'generated')

  const meta = {
    repo: GT5U_REPO,
    ref: GT5U_REF,
    commit,
    mode: RUN_CLIENT_TASK,
    runClientTask: RUN_CLIENT_TASK,
    readyMarkers: READY_MARKERS,
    worldName: WORLD_NAME,
    worldEntry: 'injected-client-probe',
    worldShutdown: 'injected-client-probe',
    langProbeSourcePath: LANG_PROBE_SOURCE_PATH,
    worldSettleMs: WORLD_SETTLE_MS,
    runtimeIntegrations,
    fluidStubs: [...LANG_FLUID_STUBS],
    worldStartMarkers: WORLD_START_MARKERS,
    worldReadyMarkers: WORLD_READY_MARKERS,
    sourcePath: resolve(generated),
    outputPath: resolve(OUT_LANG),
    entries,
    sha256,
    generatedAt: new Date().toISOString(),
  }
  await writeGeneratedOutput(content, meta)
  await writeLangCache(content, meta)

  // eslint-disable-next-line no-console
  console.log(`[gregtech-lang] wrote ${OUT_LANG} (${entries} entries, sha256=${sha256})`)
  // eslint-disable-next-line no-console
  console.log(`[gregtech-lang] cached ${CACHE_LANG}`)
}

async function main(): Promise<void> {
  await mkdir(REPO_CACHE_DIR, { recursive: true })
  await rm(OUT_ROOT, { recursive: true, force: true })
  await mkdir(OUT_ROOT, { recursive: true })

  if (USE_CACHE_ONLY) {
    // eslint-disable-next-line no-console
    console.log('[gregtech-lang] GT5U run skipped by GT5U_LANG_USE_CACHE_ONLY=1')
    await restoreFromLangCache('cache-only')
    return
  }

  try {
    await generateFresh()
  }
  catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`[gregtech-lang] fresh GT5U generation failed; trying cache: ${err instanceof Error ? err.message : err}`)
    try {
      await restoreFromLangCache('cache-fallback', err)
    }
    catch (cacheErr) {
      throw new Error(
        'fresh GT5U generation failed and cached GregTech.lang could not be used: '
        + `fresh=${err instanceof Error ? err.message : err}; `
        + `cache=${cacheErr instanceof Error ? cacheErr.message : cacheErr}`,
      )
    }
  }
}

void main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[gregtech-lang] failed:', err)
  process.exit(1)
})
