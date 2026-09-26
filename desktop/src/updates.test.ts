import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  UPDATE_BASE_URL,
  compareVersions,
  isNewer,
  updateBaseUrl,
  updateInfoFile,
  updateMode,
  versionFromUpdateInfo,
} from './updates.ts'

describe('which copies update themselves', () => {
  const mode = (platform: NodeJS.Platform, env: NodeJS.ProcessEnv = {}, development = false) =>
    updateMode({ development, platform, env })

  it('installs on the Windows installer and the Linux AppImage', () => {
    expect(mode('win32')).toBe('install')
    expect(mode('linux', { APPIMAGE: '/home/me/ISA-Bench.AppImage' })).toBe('install')
  })

  it('only notifies where the app cannot replace itself', () => {
    expect(mode('win32', { PORTABLE_EXECUTABLE_FILE: 'C:\\ISA-Bench-Portable.exe' })).toBe('notify')
    expect(mode('linux')).toBe('notify') // the tarball
    expect(mode('darwin')).toBe('notify') // unsigned
  })

  it('does nothing in development or when switched off', () => {
    expect(mode('win32', {}, true)).toBe('off')
    expect(mode('win32', { ISA_BENCH_NO_UPDATES: '1' })).toBe('off')
  })
})

describe('where it looks', () => {
  it('asks GitHub for the newest numbered release, which excludes every prerelease', () => {
    expect(UPDATE_BASE_URL).toBe('https://github.com/bonquifo/isa-bench/releases/latest/download/')
    expect(updateBaseUrl({})).toBe(UPDATE_BASE_URL)
  })

  it('can be pointed at a test server', () => {
    expect(updateBaseUrl({ ISA_BENCH_UPDATE_URL: 'http://127.0.0.1:8080' })).toBe('http://127.0.0.1:8080/')
  })

  it('agrees with the feed electron-builder writes into the app', () => {
    const build = JSON.parse(readFileSync(resolve(import.meta.dirname, '../../package.json'), 'utf8')).build
    expect(build.publish).toEqual({ provider: 'generic', url: UPDATE_BASE_URL })
  })

  it('reads the release description each platform publishes', () => {
    expect(updateInfoFile('win32')).toBe('latest.yml')
    expect(updateInfoFile('linux')).toBe('latest-linux.yml')
    expect(updateInfoFile('darwin')).toBe('latest-mac.yml')
    expect(versionFromUpdateInfo("version: 1.2.0\nfiles:\n  - url: ISA-Bench-Setup-1.2.0-win-x64.exe\n")).toBe('1.2.0')
    expect(versionFromUpdateInfo("version: '1.2.0'\n")).toBe('1.2.0')
    expect(versionFromUpdateInfo('files: []\n')).toBeNull()
  })
})

describe('what counts as newer', () => {
  it('orders releases', () => {
    expect(isNewer('1.1.0', '1.0.0')).toBe(true)
    expect(isNewer('1.0.10', '1.0.9')).toBe(true)
    expect(isNewer('2.0.0', '1.99.99')).toBe(true)
    expect(isNewer('1.0.0', '1.0.0')).toBe(false)
    expect(isNewer('1.0.0', '1.1.0')).toBe(false) // never a downgrade
    expect(isNewer('v1.2.0', '1.1.0')).toBe(true)
  })

  it('offers a build of main the release it leads up to, and nothing older', () => {
    expect(isNewer('1.0.0', '1.0.0-main.24')).toBe(true)
    expect(isNewer('1.1.0', '1.0.0-main.24')).toBe(true)
    expect(isNewer('1.0.0', '1.1.0-main.30')).toBe(false)
  })

  it('orders prerelease identifiers as semver does', () => {
    expect(compareVersions('1.0.0-main.9', '1.0.0-main.10')).toBeLessThan(0)
    expect(compareVersions('1.0.0-alpha', '1.0.0-alpha.1')).toBeLessThan(0)
    expect(compareVersions('1.0.0-1', '1.0.0-alpha')).toBeLessThan(0)
    expect(compareVersions('1.0.0-beta', '1.0.0-alpha')).toBeGreaterThan(0)
  })

  it('offers nothing for a version it cannot read', () => {
    expect(isNewer('latest', '1.0.0')).toBe(false)
    expect(isNewer('1.0', '0.9.0')).toBe(false)
  })
})
