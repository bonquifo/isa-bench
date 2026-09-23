// Refuses to package the desktop app without its compiler.
//
// The in-app compiler (toolchain/) is not committed. It is built by
// tools/isa/build-toolchain.ts, or fetched by scripts/fetch-toolchain.mjs,
// and either way it must be the bundle tools/isa/toolchain.lock.json pins:
// every file is checked against the lock's checksum, so a stale, partial or
// substituted bundle is caught here rather than on a user's machine.
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const dir = join(process.cwd(), 'toolchain')
const lock = JSON.parse(readFileSync(join(process.cwd(), 'tools/isa/toolchain.lock.json'), 'utf8'))
let failed = false
for (const [name, expected] of Object.entries(lock.files)) {
  const path = join(dir, name)
  if (!existsSync(path)) {
    console.error(`toolchain/${name} is missing. Fetch the bundle with: node scripts/fetch-toolchain.mjs`)
    failed = true
    continue
  }
  const actual = createHash('sha256').update(readFileSync(path)).digest('hex')
  if (actual !== expected.sha256) {
    console.error(`toolchain/${name} is not the one tools/isa/toolchain.lock.json pins`)
    failed = true
  }
}
if (!existsSync(join(dir, 'manifest.json'))) {
  console.error('toolchain/manifest.json is missing')
  failed = true
}
if (failed) process.exit(1)
console.log(`toolchain: ${Object.keys(lock.files).length} files match the lock`)
