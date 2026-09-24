// Renders the app's icon from its one source, desktop/icon.svg.
//
//   node scripts/icons.mjs          write the rasters
//   node scripts/icons.mjs --check  fail if a committed raster is stale
//
// desktop/icon.png is what electron-builder makes the Windows .ico, the
// macOS .icns and the Linux icons from; public/icon.png is the window's own
// icon, which Vite ships in dist/. The browser favicon, public/favicon.svg,
// is the same design drawn separately for 16 and 32 pixels, where the
// master's glow and fine lines would blur to nothing.
import { Resvg } from '@resvg/resvg-js'
import { readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const SOURCE = join(ROOT, 'desktop/icon.svg')

export const RASTERS = [
  { path: 'desktop/icon.png', size: 1024 },
  { path: 'public/icon.png', size: 256 },
]

export function render(size) {
  const svg = readFileSync(SOURCE)
  return new Resvg(svg, { fitTo: { mode: 'width', value: size } }).render().asPng()
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const check = process.argv.includes('--check')
  let stale = false
  for (const { path, size } of RASTERS) {
    const png = render(size)
    const file = join(ROOT, path)
    if (check) {
      let current = null
      try { current = readFileSync(file) } catch { /* missing counts as stale */ }
      if (!current || !Buffer.from(png).equals(current)) {
        console.error(`${path} is not what desktop/icon.svg renders to; run node scripts/icons.mjs`)
        stale = true
      }
    } else {
      writeFileSync(file, png)
      console.log(`${path}: ${size}x${size}, ${png.length} bytes`)
    }
  }
  if (stale) process.exit(1)
}
