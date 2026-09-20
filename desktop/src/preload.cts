// Electron loads sandboxed preload scripts as CommonJS, so this file is authored
// as .cts: an ES-module preload fails with "Cannot use import statement outside
// a module" and the isaBenchDesktop bridge never reaches the renderer.
import electron = require('electron')

electron.contextBridge.exposeInMainWorld('isaBenchDesktop', {
  embedded: true as const,
  shell: 'electron' as const,
})
