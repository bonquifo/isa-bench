// Electron loads sandboxed preload scripts as CommonJS, so this file is authored
// as .cts: an ES-module preload fails with "Cannot use import statement outside
// a module" and the isaBenchDesktop bridge never reaches the renderer.
import electron = require('electron')

const flag = process.argv.find((item) => item.startsWith('--isa-bench-origin='))
let origin: string | undefined
try {
  const parsed = flag ? new URL(flag.slice('--isa-bench-origin='.length)) : undefined
  if (parsed?.protocol === 'http:' && parsed.hostname === '127.0.0.1') origin = parsed.origin
} catch {
  origin = undefined
}

electron.contextBridge.exposeInMainWorld('isaBenchDesktop', {
  embedded: true as const,
  shell: 'electron' as const,
  ...(origin ? { origin } : {}),
})
