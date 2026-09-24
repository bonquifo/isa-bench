import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export interface DesktopLayout {
  /** Directory holding the built `index.html`, absent only in development. */
  staticDir?: string
  preloadPath: string
  /**
   * Directory holding the in-app compiler (llvm.wasm, mos.wasm,
   * sysroot.tar), absent when it was not packaged or built.
   */
  toolchainDir?: string
  /**
   * The window's icon. Installers carry their own, but a Linux window and
   * the development shell show Electron's unless the window is given one.
   */
  iconPath?: string
}

/** The files the toolchain protocol will serve, and nothing else. */
export const TOOLCHAIN_FILES = ['llvm.wasm', 'mos.wasm', 'sysroot.tar', 'manifest.json'] as const

/**
 * The file a toolchain request names, or null when it names anything else.
 *
 * Only the bundle's own file names are accepted, by exact match, so no
 * path a page could construct reaches outside the directory.
 */
export function toolchainFileFor(dir: string, requestPath: string): string | null {
  const name = decodeURIComponent(requestPath.replace(/^\/+/, ''))
  return (TOOLCHAIN_FILES as readonly string[]).includes(name) ? join(dir, name) : null
}

export function desktopFromMain(
  mainUrl: string,
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
  resourcesPath?: string,
): {
  development: boolean
  layout: DesktopLayout
} {
  const development = argv.includes('--dev') || env.ISA_BENCH_DEV_URL !== undefined
  const here = dirname(fileURLToPath(mainUrl))
  const packagedRoot = resolve(here, '..', '..')
  const staticDir = firstUiDirectory([
    env.ISA_SIM_STATIC_DIR,
    join(packagedRoot, 'dist'),
    join(packagedRoot, 'ui'),
    join(here, '..', 'ui'),
    // Development checkout: desktop/dist/main.js sits one level deeper.
    join(here, '..', '..', '..', 'dist'),
  ])
  const toolchainDir = firstDirectoryWith('llvm.wasm', [
    env.ISA_BENCH_TOOLCHAIN_DIR,
    // Packaged: electron-builder copies it into the app's resources.
    resourcesPath ? join(resourcesPath, 'toolchain') : undefined,
    // Development checkout: desktop/dist/main.js is two levels down.
    join(here, '..', '..', 'toolchain'),
  ])
  const iconDir = firstDirectoryWith('icon.png', [
    staticDir,
    // Development checkout: Vite serves public/, and dist/ may not exist.
    join(here, '..', '..', 'public'),
  ])
  return {
    development,
    layout: {
      ...(staticDir ? { staticDir } : {}),
      preloadPath: join(here, 'preload.cjs'),
      ...(toolchainDir ? { toolchainDir } : {}),
      ...(iconDir ? { iconPath: join(iconDir, 'icon.png') } : {}),
    },
  }
}

function firstDirectoryWith(file: string, candidates: Array<string | undefined>): string | undefined {
  for (const candidate of candidates) {
    if (!candidate) continue
    const directory = resolve(candidate)
    if (existsSync(join(directory, file))) return directory
  }
  return undefined
}

function firstUiDirectory(candidates: Array<string | undefined>): string | undefined {
  for (const candidate of candidates) {
    if (!candidate) continue
    const directory = resolve(candidate)
    if (existsSync(join(directory, 'index.html'))) return directory
  }
  return undefined
}
