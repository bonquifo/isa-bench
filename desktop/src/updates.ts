/**
 * What the app does about updates, decided without Electron so it can be
 * tested. desktop/src/updater.ts carries it out.
 *
 * Updates come only from numbered releases: GitHub redirects
 * releases/latest/download/<file> to the newest release that is neither a
 * draft nor a prerelease, so the rolling Latest main build and the
 * compiler bundles can never be offered, whatever their version.
 */

export type UpdateMode =
  /** Downloads in the background and asks to restart. */
  | 'install'
  /** Can't replace itself: says a version is available and links to it. */
  | 'notify'
  /** Development, or switched off. */
  | 'off'

export const UPDATE_BASE_URL = 'https://github.com/bonquifo/isa-bench/releases/latest/download/'
export const DOWNLOAD_PAGE_URL = 'https://bonquifo.github.io/isa-bench/#download'
/** How often a running app looks again, after the check at start-up. */
export const CHECK_INTERVAL_MS = 12 * 60 * 60 * 1000

/**
 * Only the Windows installer and the Linux AppImage can replace
 * themselves. The portable exe and the tarball have no installer to hand
 * the update to, and macOS refuses to let an unsigned app replace itself.
 */
export function updateMode(options: {
  development: boolean
  platform: NodeJS.Platform
  env: NodeJS.ProcessEnv
}): UpdateMode {
  const { development, platform, env } = options
  if (development || env.ISA_BENCH_NO_UPDATES) return 'off'
  if (platform === 'win32') return env.PORTABLE_EXECUTABLE_FILE ? 'notify' : 'install'
  if (platform === 'linux') return env.APPIMAGE ? 'install' : 'notify'
  if (platform === 'darwin') return 'notify'
  return 'off'
}

/** Where to look; ISA_BENCH_UPDATE_URL points a test build at its own server. */
export function updateBaseUrl(env: NodeJS.ProcessEnv): string {
  const override = env.ISA_BENCH_UPDATE_URL
  if (!override) return UPDATE_BASE_URL
  return override.endsWith('/') ? override : `${override}/`
}

/** The file electron-builder writes describing a release, per platform. */
export function updateInfoFile(platform: NodeJS.Platform): string {
  if (platform === 'linux') return 'latest-linux.yml'
  if (platform === 'darwin') return 'latest-mac.yml'
  return 'latest.yml'
}

/** The `version:` line of an update info file, or null if there is none. */
export function versionFromUpdateInfo(text: string): string | null {
  const match = /^version:\s*['"]?([^'"\s]+)['"]?\s*$/m.exec(text)
  return match ? match[1]! : null
}

interface Semver {
  core: [number, number, number]
  pre: string[]
}

function parse(version: string): Semver | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(version.trim())
  if (!match) return null
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    pre: match[4] ? match[4].split('.') : [],
  }
}

/**
 * Semantic-version order: negative when a is older than b. A build of main
 * (1.1.0-main.30) is older than the release it leads up to (1.1.0), so it
 * is offered that release when it comes out. Unparseable versions compare
 * equal, which offers nothing.
 */
export function compareVersions(a: string, b: string): number {
  const x = parse(a)
  const y = parse(b)
  if (!x || !y) return 0
  for (let i = 0; i < 3; i++) {
    if (x.core[i] !== y.core[i]) return x.core[i]! - y.core[i]!
  }
  if (x.pre.length === 0 || y.pre.length === 0) return y.pre.length - x.pre.length
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i]
    const q = y.pre[i]
    if (p === undefined) return -1
    if (q === undefined) return 1
    const pn = /^\d+$/.test(p)
    const qn = /^\d+$/.test(q)
    if (pn && qn && Number(p) !== Number(q)) return Number(p) - Number(q)
    if (pn !== qn) return pn ? -1 : 1
    if (!pn && p !== q) return p < q ? -1 : 1
  }
  return 0
}

/** Whether `latest` should be offered to an app at `current`. */
export function isNewer(latest: string, current: string): boolean {
  return compareVersions(latest, current) > 0
}
