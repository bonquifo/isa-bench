// Downloads the in-app compiler instead of building it.
//
//   node scripts/fetch-toolchain.mjs [base-url]
//
// Building the bundle (tools/isa/build-toolchain.ts) compiles LLVM twice,
// to WebAssembly, which takes hours. The bundle it produces is published as
// release assets, and this fetches them from `base-url` -- by default the
// release tagged toolchain-<lock hash> -- and checks every file against the
// checksum tools/isa/toolchain.lock.json pins before writing it. A file
// that does not match is never written and the script fails: nothing
// unverified is ever left where packaging would find it.
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const root = process.cwd()
const dir = join(root, 'toolchain')
const lockText = readFileSync(join(root, 'tools/isa/toolchain.lock.json'))
const lock = JSON.parse(lockText.toString('utf8'))
// Hashed with LF line endings, so a Windows checkout names the same release.
const lockLf = lockText.toString('utf8').replace(/\r\n/g, '\n')
const tag = `toolchain-${createHash('sha256').update(lockLf).digest('hex').slice(0, 12)}`
const base = process.argv[2] ?? `https://github.com/bonquifo/isa-bench/releases/download/${tag}/`
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')

mkdirSync(dir, { recursive: true })
for (const name of [...Object.keys(lock.files), 'manifest.json']) {
  const path = join(dir, name)
  const expected = lock.files[name]?.sha256
  if (expected && existsSync(path) && sha256(readFileSync(path)) === expected) {
    console.log(`${name}: already present`)
    continue
  }
  const url = new URL(name, base.endsWith('/') ? base : `${base}/`)
  const response = await fetch(url)
  if (!response.ok) {
    console.error(`${url}: ${response.status} ${response.statusText}`)
    if (response.status === 404) {
      const files = [...Object.keys(lock.files), 'manifest.json'].map((file) => `toolchain/${file}`)
      console.error('\nThe bundle this lock pins has not been published. From a checkout that built it:\n' +
        `  gh release create ${tag} --title "In-app compiler" --notes "tools/isa/build-toolchain.ts output" ${files.join(' ')}`)
    }
    process.exitCode = 1
    break
  }
  const bytes = new Uint8Array(await response.arrayBuffer())
  // manifest.json is description, not code, and the lock does not pin it;
  // it is kept only beside files that were.
  if (expected && sha256(bytes) !== expected) {
    console.error(`${name}: checksum does not match tools/isa/toolchain.lock.json; discarded`)
    process.exitCode = 1
    break
  }
  writeFileSync(`${path}.part`, bytes)
  renameSync(`${path}.part`, path)
  console.log(`${name}: ${bytes.length} bytes${expected ? ', checksum verified' : ''}`)
}
