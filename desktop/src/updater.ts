/**
 * Keeps an installed app current with the newest numbered release.
 *
 * Where the app can replace itself (the Windows installer, the Linux
 * AppImage), electron-updater downloads the release in the background and
 * the app asks to restart; choosing Later installs it on the next quit.
 * Everywhere else the app reads the same release description and offers to
 * open the download page. Either way it looks once shortly after start-up
 * and again every twelve hours, asks about each version at most once per
 * run, and never lets a failed check disturb the app.
 */
import { app, dialog, net, shell, type BrowserWindow } from 'electron'
import electronUpdater from 'electron-updater'
import {
  CHECK_INTERVAL_MS,
  DOWNLOAD_PAGE_URL,
  isNewer,
  updateBaseUrl,
  updateInfoFile,
  versionFromUpdateInfo,
  type UpdateMode,
} from './updates.js'

const FIRST_CHECK_DELAY_MS = 10_000

export function startUpdates(mode: UpdateMode, window: () => BrowserWindow | undefined): void {
  if (mode === 'off') return
  const base = updateBaseUrl(process.env)
  const asked = new Set<string>()
  const check = mode === 'install' ? installer(base, asked, window) : notifier(base, asked, window)
  setTimeout(check, FIRST_CHECK_DELAY_MS)
  setInterval(check, CHECK_INTERVAL_MS).unref()
}

function installer(base: string, asked: Set<string>, window: () => BrowserWindow | undefined): () => void {
  const { autoUpdater } = electronUpdater
  // The packaged app-update.yml already names this address; setting it
  // here as well lets ISA_BENCH_UPDATE_URL point a test build elsewhere.
  autoUpdater.setFeedURL({ provider: 'generic', url: base })
  // A build of main is a prerelease (1.1.0-main.30), and electron-builder
  // gives such a build the channel "main", which would have it look for
  // main.yml. Numbered releases publish latest.yml, so the channel is
  // pinned. Setting a channel also allows downgrades, so that goes after.
  autoUpdater.channel = 'latest'
  autoUpdater.allowDowngrade = false
  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.disableWebInstaller = true
  autoUpdater.on('error', (error: Error) => console.warn(`update check failed: ${error.message}`))
  autoUpdater.on('update-downloaded', async (info: { version: string }) => {
    if (asked.has(info.version)) return
    asked.add(info.version)
    const options = {
      type: 'info' as const,
      buttons: ['Restart now', 'Later'],
      defaultId: 0,
      cancelId: 1,
      title: 'Update ready',
      message: `ISA Bench ${info.version} is ready to install`,
      detail: 'Restart now to update, or choose Later and it installs the next time you quit.',
    }
    const parent = window()
    const { response } = parent ? await dialog.showMessageBox(parent, options) : await dialog.showMessageBox(options)
    if (response === 0) autoUpdater.quitAndInstall()
  })
  return () => {
    autoUpdater.checkForUpdates().catch((error: Error) => console.warn(`update check failed: ${error.message}`))
  }
}

function notifier(base: string, asked: Set<string>, window: () => BrowserWindow | undefined): () => void {
  return () => {
    void (async () => {
      try {
        const response = await net.fetch(`${base}${updateInfoFile(process.platform)}`)
        // No numbered release yet, or none for this platform: nothing to say.
        if (!response.ok) return
        const latest = versionFromUpdateInfo(await response.text())
        if (!latest || !isNewer(latest, app.getVersion()) || asked.has(latest)) return
        asked.add(latest)
        const options = {
          type: 'info' as const,
          buttons: ['Open download page', 'Later'],
          defaultId: 0,
          cancelId: 1,
          title: 'Update available',
          message: `ISA Bench ${latest} is available`,
          detail: `You have ${app.getVersion()}. This copy can't update itself, so download the new version and replace it.`,
        }
        const parent = window()
        const { response: choice } = parent ? await dialog.showMessageBox(parent, options) : await dialog.showMessageBox(options)
        if (choice === 0) await shell.openExternal(DOWNLOAD_PAGE_URL)
      } catch (error) {
        console.warn(`update check failed: ${(error as Error).message}`)
      }
    })()
  }
}
