// The Docker images the fixtures and the in-app compiler are built with,
// addressed by what they are built from.
//
//   node scripts/images.mjs plan        which images the registry lacks (JSON)
//   node scripts/images.mjs build NAME  build one and push it to the registry
//   node scripts/images.mjs pull [NAME...]
//                                       pull images (default: all) and tag
//                                       them with the local names the build
//                                       scripts use
//
// Each image's key is a hash of its Dockerfile, the files the Dockerfile
// copies in, and the keys of the images it is built on. An image is only
// ever built when that key is not in the registry yet, so an unchanged image
// costs a pull instead of hours, a changed one is rebuilt along with
// everything built on it, and two branches can never overwrite each other's
// images: different inputs are different tags.
//
// The registry is ISA_IMAGE_REGISTRY, by default this repository's
// packages on GitHub.
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const CONTEXT = join(ROOT, 'tools/isa')
const REGISTRY = process.env.ISA_IMAGE_REGISTRY ?? 'ghcr.io/bonquifo/isa-bench-images'

/**
 * Every image, with the local tag the build scripts refer to it by and the
 * build arguments through which it names the images it is built on.
 * `heavy` marks the two that compile LLVM, which get a runner to themselves.
 */
export const IMAGES = [
  { name: 'codegen-min', file: 'Dockerfile.codegen-min', tag: 'isa-bench/codegen-min:23.1.0' },
  { name: 'codegen-musl', file: 'Dockerfile.sysroot', tag: 'isa-bench/codegen-musl:23.1.0-1.2.5-r3',
    args: { LLVM: 'codegen-min', BASE: 'codegen-min' } },
  { name: 'sparc-picolibc', file: 'Dockerfile.sparc-libc', tag: 'isa-bench/sparc-picolibc:1.8.10',
    args: { LLVM: 'codegen-min' } },
  { name: 'sparc-linker', file: 'Dockerfile.sparc', tag: 'isa-sim/sparc-linker:2.40-2' },
  { name: 'qemu-user', file: 'Dockerfile.qemu', tag: 'isa-sim/qemu-user:11.1.0' },
  { name: 'native-x86', file: 'Dockerfile.native', tag: 'isa-bench/native-x86:1' },
  { name: 'wasi', file: 'Dockerfile.wasi', tag: 'isa-sim/wasi:33.0-48.0.1' },
  { name: 'mos', file: 'Dockerfile.mos', tag: 'isa-sim/mos:23.0.1' },
  { name: 'clang-wasm', file: 'Dockerfile.clang-wasm', tag: 'isa-bench/clang-wasm:23.1.0',
    args: { WASI: 'wasi' }, heavy: true },
  { name: 'mos-wasm', file: 'Dockerfile.mos-wasm', tag: 'isa-bench/mos-wasm:23.0.1',
    args: { WASI: 'wasi' }, heavy: true },
]

const byName = new Map(IMAGES.map((image) => [image.name, image]))

/** Text with its line endings normalised, so a Windows checkout agrees. */
function lf(path) {
  return readFileSync(path, 'utf8').replace(/\r\n/g, '\n')
}

/** The files a Dockerfile copies from the build context. */
function copiedFiles(dockerfile) {
  const files = []
  for (const line of dockerfile.split('\n')) {
    const match = /^COPY\s+(.*)$/.exec(line.trim())
    if (!match || /--from=/.test(match[1])) continue
    const operands = match[1].split(/\s+/).filter((token) => !token.startsWith('--'))
    files.push(...operands.slice(0, -1))
  }
  return files.sort()
}

const keys = new Map()
export function keyOf(name) {
  if (keys.has(name)) return keys.get(name)
  const image = byName.get(name)
  if (!image) throw new Error(`unknown image ${name}`)
  const hash = createHash('sha256')
  const dockerfile = lf(join(CONTEXT, image.file))
  hash.update(`dockerfile\0${dockerfile}\0`)
  for (const file of copiedFiles(dockerfile)) hash.update(`file\0${file}\0${lf(join(CONTEXT, file))}\0`)
  for (const [arg, dep] of Object.entries(image.args ?? {}).sort()) hash.update(`arg\0${arg}\0${keyOf(dep)}\0`)
  const key = hash.digest('hex').slice(0, 20)
  keys.set(name, key)
  return key
}

export const refOf = (name) => `${REGISTRY}/${name}:${keyOf(name)}`

function inRegistry(name) {
  return spawnSync('docker', ['manifest', 'inspect', refOf(name)], { stdio: 'ignore' }).status === 0
}

function run(command, args) {
  console.log(`$ ${command} ${args.join(' ')}`)
  execFileSync(command, args, { stdio: 'inherit', env: { ...process.env, MSYS_NO_PATHCONV: '1' } })
}

const [command, target] = process.argv.slice(2)
switch (command) {
  case 'plan': {
    // Two waves: images built on nothing of ours, then images built on
    // those. An image is in a wave only if the registry lacks it.
    const missing = IMAGES.filter((image) => !inRegistry(image.name))
    const wave = (first) => missing
      .filter((image) => first === !image.args)
      .map((image) => ({ name: image.name, heavy: Boolean(image.heavy), ref: refOf(image.name) }))
    console.log(JSON.stringify({ first: wave(true), second: wave(false), keys: Object.fromEntries(IMAGES.map((i) => [i.name, keyOf(i.name)])) }))
    break
  }
  case 'build': {
    const image = byName.get(target)
    if (!image) throw new Error(`unknown image ${target}; known: ${[...byName.keys()].join(', ')}`)
    const args = Object.entries(image.args ?? {}).flatMap(([arg, dep]) => ['--build-arg', `${arg}=${refOf(dep)}`])
    run('docker', ['buildx', 'build', '--push', '--progress=plain', '-f', join(CONTEXT, image.file),
      '-t', refOf(image.name), ...args, CONTEXT])
    break
  }
  case 'pull': {
    const wanted = process.argv.slice(3)
    for (const name of wanted) if (!byName.has(name)) throw new Error(`unknown image ${name}`)
    for (const image of IMAGES.filter((i) => wanted.length === 0 || wanted.includes(i.name))) {
      run('docker', ['pull', '--quiet', refOf(image.name)])
      run('docker', ['tag', refOf(image.name), image.tag])
    }
    break
  }
  case 'keys':
    for (const image of IMAGES) console.log(`${image.name.padEnd(15)} ${keyOf(image.name)}  ${image.tag}`)
    break
  default:
    console.error('usage: node scripts/images.mjs plan | build <name> | pull [name...] | keys')
    process.exit(1)
}
