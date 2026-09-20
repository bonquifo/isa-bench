import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export interface DesktopLayout {
  repositoryRoot: string
  staticDir?: string
  preloadPath: string
}

export function desktopFromMain(mainUrl: string, argv: readonly string[], env: NodeJS.ProcessEnv): {
  development: boolean
  layout: DesktopLayout
} {
  const development = argv.includes('--dev') || env.ISA_BENCH_DEV_URL !== undefined
  const here = dirname(fileURLToPath(mainUrl))
  const packagedRoot = resolve(here, '..', '..')
  const repositoryRoot = firstExisting([
    env.ISA_SIM_REPOSITORY_ROOT,
    packagedRoot,
    resolve(here, '..', '..', '..'),
  ], 'src/engine/index.ts') ?? packagedRoot
  const staticDir = firstUiDirectory([
    env.ISA_SIM_STATIC_DIR,
    join(repositoryRoot, 'dist'),
    join(packagedRoot, 'ui'),
    join(here, '..', 'ui'),
  ])
  return {
    development,
    layout: {
      repositoryRoot,
      ...(staticDir ? { staticDir } : {}),
      preloadPath: join(here, 'preload.cjs'),
    },
  }
}

export function loopbackUrl(port: number): string {
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error('desktop backend port is invalid')
  return `http://127.0.0.1:${port}`
}

export function listenPort(address: string | { port?: number } | null): number {
  if (typeof address === 'object' && address && typeof address.port === 'number') return address.port
  throw new Error('desktop backend did not bind a TCP port')
}

function firstExisting(candidates: Array<string | undefined>, child?: string): string | undefined {
  for (const candidate of candidates) {
    if (!candidate) continue
    const path = child ? resolve(candidate, child) : resolve(candidate)
    if (existsSync(path)) return child ? resolve(candidate) : path
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
