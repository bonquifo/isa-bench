import { app, BrowserWindow, Menu, shell } from 'electron'
import { join, resolve } from 'node:path'
import { createBackend, type Backend } from '@isa-sim/server'
import { desktopFromMain, listenPort, loopbackUrl } from './paths.js'

const started = desktopFromMain(import.meta.url, process.argv, process.env)
let backend: Backend | undefined
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

app.on('before-quit', () => {
  void backend?.app.close()
})

async function start(): Promise<void> {
  // The server honors ISA_SIM_DATA_DIR; passing an explicit override here used
  // to silently discard it, leaving the packaged app unable to reach a native
  // corpus built anywhere but its own userData directory.
  const dataDir = process.env.ISA_SIM_DATA_DIR
    ? resolve(process.env.ISA_SIM_DATA_DIR)
    : join(app.getPath('userData'), 'data')
  process.chdir(started.layout.repositoryRoot)
  backend = await createBackend({
    host: '127.0.0.1',
    port: started.development ? 4317 : 0,
    dataDir,
    repositoryRoot: started.layout.repositoryRoot,
    ...(!started.development && started.layout.staticDir ? { staticDir: started.layout.staticDir } : {}),
  })
  try {
    await backend.app.listen({ host: backend.config.host, port: backend.config.port })
  } catch (error) {
    if (!started.development || !addressInUse(error)) throw error
  }
  const url = started.development
    ? (process.env.ISA_BENCH_DEV_URL ?? 'http://127.0.0.1:5173')
    : loopbackUrl(listenPort(backend.app.server.address()))
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
      additionalArguments: started.development ? [] : [`--isa-bench-origin=${url}`],
    },
  })
  window.webContents.setWindowOpenHandler(({ url: target }) => {
    if (target.startsWith('https:') || target.startsWith('http://127.0.0.1')) void shell.openExternal(target)
    return { action: 'deny' }
  })
  await window.loadURL(url)
}

function addressInUse(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'EADDRINUSE'
}
