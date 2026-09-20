import { app, BrowserWindow, Menu, shell } from 'electron'
import { join } from 'node:path'
import { desktopFromMain } from './paths.js'

const started = desktopFromMain(import.meta.url, process.argv, process.env)
let window: BrowserWindow | undefined

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    window?.show()
    window?.focus()
  })
  void app.whenReady().then(start)
}

app.on('window-all-closed', () => {
  app.quit()
})

async function start(): Promise<void> {
  if (process.platform === 'darwin') {
    Menu.setApplicationMenu(Menu.buildFromTemplate([{ role: 'appMenu' }, { role: 'editMenu' }, { role: 'viewMenu' }]))
  } else {
    Menu.setApplicationMenu(null)
  }
  window = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 960,
    minHeight: 700,
    title: 'ISA Bench',
    autoHideMenuBar: true,
    webPreferences: {
      preload: started.layout.preloadPath,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  })
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https:')) void shell.openExternal(url)
    return { action: 'deny' }
  })
  if (started.development) {
    await window.loadURL(process.env.ISA_BENCH_DEV_URL ?? 'http://127.0.0.1:5173')
    return
  }
  // The simulation runs entirely in the renderer, so the packaged app loads the
  // built bundle straight off disk. There is no local server and no network use.
  if (!started.layout.staticDir) throw new Error('packaged UI bundle is missing; run `npm run build` first')
  await window.loadFile(join(started.layout.staticDir, 'index.html'))
}
