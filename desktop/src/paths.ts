import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export interface DesktopLayout {
  /** Directory holding the built `index.html`, absent only in development. */
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
  const staticDir = firstUiDirectory([
    env.ISA_SIM_STATIC_DIR,
    join(packagedRoot, 'dist'),
    join(packagedRoot, 'ui'),
    join(here, '..', 'ui'),
    // Development checkout: desktop/dist/main.js sits one level deeper.
    join(here, '..', '..', '..', 'dist'),
  ])
  return {
    development,
    layout: {
      ...(staticDir ? { staticDir } : {}),
      preloadPath: join(here, 'preload.cjs'),
    },
  }
}

function firstUiDirectory(candidates: Array<string | undefined>): string | undefined {
  for (const candidate of candidates) {
    if (!candidate) continue
    const directory = resolve(candidate)
    if (existsSync(join(directory, 'index.html'))) return directory
  }
  return undefined
}
