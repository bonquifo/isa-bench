import { app, BrowserWindow, Menu, net, protocol, shell } from 'electron'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { desktopFromMain, toolchainFileFor } from './paths.js'

const started = desktopFromMain(import.meta.url, process.argv, process.env, process.resourcesPath)
let window: BrowserWindow | undefined

/**
 * The in-app compiler is tens of megabytes of WebAssembly and libraries,
 * too large to inline into the bundle the way the shipped binaries are,
 * and a page loaded from file:// cannot fetch a sibling file. So it is
 * served under its own scheme, read-only, from the app's resources.
 */
const TOOLCHAIN_SCHEME = 'isa-toolchain'
protocol.registerSchemesAsPrivileged([{
  scheme: TOOLCHAIN_SCHEME,
  privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true },
}])

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

function serveToolchain(): void {
  const dir = started.layout.toolchainDir
  protocol.handle(TOOLCHAIN_SCHEME, async (request) => {
    const file = dir ? toolchainFileFor(dir, new URL(request.url).pathname) : null
    if (!file) return new Response('not found', { status: 404 })
    const response = await net.fetch(pathToFileURL(file).toString())
    const headers = new Headers(response.headers)
    // The page and its workers are file:// documents, a different origin.
    headers.set('Access-Control-Allow-Origin', '*')
    if (file.endsWith('.wasm')) headers.set('Content-Type', 'application/wasm')
    return new Response(response.body, { status: response.status, headers })
  })
}

async function start(): Promise<void> {
  serveToolchain()
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
    ...(started.layout.iconPath ? { icon: started.layout.iconPath } : {}),
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
    // `npm run desktop:dev` starts Vite and Electron together, and Electron
    // is usually first, so the server is waited for rather than assumed.
    const url = process.env.ISA_BENCH_DEV_URL ?? 'http://127.0.0.1:5173'
    for (let attempt = 1; ; attempt++) {
      try {
        await window.loadURL(url)
        return
      } catch (error) {
        if (attempt >= 60) throw new Error(`no development server at ${url} after 30 s`, { cause: error })
        await new Promise((resolve) => setTimeout(resolve, 500))
      }
    }
  }
  // The simulation runs entirely in the renderer, so the packaged app loads the
  // built bundle straight off disk. There is no local server and no network use.
  if (!started.layout.staticDir) throw new Error('packaged UI bundle is missing; run `npm run build` first')
  await window.loadFile(join(started.layout.staticDir, 'index.html'))
}
