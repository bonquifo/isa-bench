/**
 * Assembles the toolchain the app compiles a user's C program with.
 *
 *   npx vite-node tools/isa/build-toolchain.ts
 *
 * Writes toolchain/ at the repository root:
 *
 *   llvm.wasm       clang, lld and llvm-ar for seven targets, as one WASI
 *                   program (tools/isa/Dockerfile.clang-wasm)
 *   mos.wasm        llvm-mos's clang and lld, for the 6502
 *                   (tools/isa/Dockerfile.mos-wasm)
 *   sysroot.tar     the headers, start files and libraries each target
 *                   links, taken from the same images the fixtures use
 *   manifest.json   what is in both, with checksums
 *
 * and tools/isa/toolchain.lock.json, the checksums alone, which is committed.
 *
 * Everything comes out of images built from pinned, checksummed sources,
 * so the bundle holds exactly what compiled the fixtures -- the same musl,
 * the same picolibc and platform layer, the same wasi-libc and compiler-rt.
 * The directory is not committed: it is tens of megabytes of build output
 * that this script reproduces, and the desktop packaging step refuses to
 * run without it.
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '../..')
const OUT = join(ROOT, 'toolchain')
const STAGE = join(ROOT, 'node_modules/.tmp/toolchain-stage')
const LOCK = join(ROOT, 'tools/isa/toolchain.lock.json')

const CLANG_WASM_IMAGE = 'isa-bench/clang-wasm:23.1.0'
const MOS_WASM_IMAGE = 'isa-bench/mos-wasm:23.0.1'
const MOS_SDK_IMAGE = 'isa-sim/mos:23.0.1'
const MUSL_IMAGE = 'isa-bench/codegen-musl:23.1.0-1.2.5-r3'
const SPARC_IMAGE = 'isa-bench/sparc-picolibc:1.8.10'
const WASI_IMAGE = 'isa-sim/wasi:33.0-48.0.1'
const TAR_IMAGE = 'debian:bookworm-slim@sha256:3783cc01769c7b2b1b83a5c5ad96c815348e28ed7da68e2e3687004faa906251'

/** The five musl targets, by the directory name their sysroot uses. */
const MUSL_TARGETS = ['riscv64', 'aarch64', 'x86_64', 'mipsel', 'powerpc64le'] as const

/**
 * Clang's own headers that no C program for these targets includes: SIMD
 * intrinsics, GPU and OpenCL support, other architectures' extensions.
 * Leaving them out is most of the bundle's headers by size.
 */
const UNUSED_CLANG_HEADERS =
  /(intrin|avx|sse|mmx|amx|keylocker|arm_|riscv_|altivec|htm|ppc_wrappers|cuda|hip|opencl|openmp|llvm_libc|hexagon|lasx|lsx|msa|s390|vecintrin|velintrin|wasm_simd|builtins\.h$|module\.modulemap$|cuda_wrappers|openmp_wrappers)/i

function mount(path: string): string {
  return resolve(path).replace(/\\/g, '/')
}

function docker(args: string[]): string {
  return execFileSync('docker', args, {
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    env: { ...process.env, MSYS_NO_PATHCONV: '1' },
  })
}

/** Runs a shell script in `image` with the stage directory at /stage. */
function inImage(image: string, script: string): void {
  docker(['run', '--rm', '--network', 'none', '-v', `${mount(STAGE)}:/stage`,
    '--entrypoint', 'sh', image, '-c', script])
}

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function buildToolchain(): void {
  rmSync(STAGE, { recursive: true, force: true })
  mkdirSync(join(STAGE, 'root'), { recursive: true })
  mkdirSync(OUT, { recursive: true })

  // The compilers, and clang's headers, out of images that have no shell.
  const container = docker(['create', CLANG_WASM_IMAGE, '/llvm.wasm']).trim()
  try {
    docker(['cp', `${container}:/llvm.wasm`, mount(join(OUT, 'llvm.wasm'))])
    mkdirSync(join(STAGE, 'root', 'clang'), { recursive: true })
    docker(['cp', `${container}:/clang-include`, mount(join(STAGE, 'root', 'clang', 'include'))])
  } finally {
    docker(['rm', container])
  }
  const mosContainer = docker(['create', MOS_WASM_IMAGE, '/mos.wasm']).trim()
  try {
    docker(['cp', `${mosContainer}:/mos.wasm`, mount(join(OUT, 'mos.wasm'))])
  } finally {
    docker(['rm', mosContainer])
  }

  // Five musl sysroots and their compiler-rt, as the libc tier links them.
  inImage(MUSL_IMAGE, [
    'set -e',
    ...MUSL_TARGETS.flatMap((t) => [
      `mkdir -p /stage/root/musl/${t}/lib`,
      `cp -r /sysroot/${t}/include /stage/root/musl/${t}/include`,
      `cp /sysroot/${t}/lib/crt1.o /sysroot/${t}/lib/crti.o /sysroot/${t}/lib/crtn.o ` +
        `/sysroot/${t}/lib/libc.a /sysroot/${t}/lib/libm.a /stage/root/musl/${t}/lib/`,
      `cp /sysroot/builtins/libclang_rt.builtins-${t}.a /stage/root/musl/${t}/lib/`,
    ]),
  ].join(' && '))

  // SPARC: picolibc with the project's platform layer.
  inImage(SPARC_IMAGE, [
    'set -e',
    'mkdir -p /stage/root/sparc/lib',
    'cp -r /sysroot/sparc/include /stage/root/sparc/include',
    'cd /sysroot/sparc/lib && cp crt1.o platform.o libc.a libclang_rt.builtins-sparc.a /stage/root/sparc/lib/',
  ].join(' && '))

  // WebAssembly: wasi-libc, its C headers only, and compiler-rt.
  inImage(WASI_IMAGE, [
    'set -e',
    'S=/opt/wasi-sdk/share/wasi-sysroot',
    // The sysroot's own layout, so --sysroot resolves as it does natively.
    'mkdir -p /stage/root/wasi/lib/wasm32-wasip1 /stage/root/wasi/include',
    'cp -r $S/include/wasm32-wasip1 /stage/root/wasi/include/',
    'rm -rf /stage/root/wasi/include/wasm32-wasip1/c++',
    'cd $S/lib/wasm32-wasip1 && cp crt1-command.o libc.a libm.a /stage/root/wasi/lib/wasm32-wasip1/',
    'cp /opt/wasi-sdk/lib/clang/*/lib/wasm32-unknown-wasip1/libclang_rt.builtins.a /stage/root/wasi/lib/wasm32-wasip1/',
  ].join(' && '))

  // The 6502: the llvm-mos SDK's sim platform, which the fixtures target,
  // the common layer under it, and llvm-mos's own clang headers -- the
  // SDK's, since its compiler is the one mos.wasm was built from.
  inImage(MOS_SDK_IMAGE, [
    'set -e',
    'mkdir -p /stage/root/mos/clang',
    'cp -r /opt/llvm-mos/mos-platform/sim /opt/llvm-mos/mos-platform/common /stage/root/mos/',
    'cp -r /opt/llvm-mos/lib/clang/23/include /stage/root/mos/clang/include',
  ].join(' && '))

  // Prune clang's headers to the ones a C program reaches.
  const pruned: string[] = []
  for (const dir of ['clang/include', 'mos/clang/include']) {
    const listing = docker(['run', '--rm', '-v', `${mount(STAGE)}:/stage`, '--entrypoint', 'sh', TAR_IMAGE,
      '-c', `cd /stage/root/${dir} && find . -type f`]).split('\n').filter(Boolean)
    const unused = listing.filter((file) => UNUSED_CLANG_HEADERS.test(file))
    if (unused.length === 0) continue
    writeFileSync(join(STAGE, 'prune.txt'), unused.join('\n'))
    inImage(TAR_IMAGE, `cd /stage/root/${dir} && xargs rm -f < /stage/prune.txt && find . -type d -empty -delete`)
    pruned.push(...unused.map((file) => `${dir}/${file.slice(2)}`))
  }

  // One reproducible tar: sorted, zero timestamps, no owners.
  inImage(TAR_IMAGE,
    'cd /stage/root && tar --sort=name --mtime=@0 --owner=0 --group=0 --numeric-owner ' +
    '--format=ustar -cf /stage/sysroot.tar .')
  const tar = readFileSync(join(STAGE, 'sysroot.tar'))
  writeFileSync(join(OUT, 'sysroot.tar'), tar)

  const manifest = {
    generator: 'tools/isa/build-toolchain.ts',
    llvm: { image: CLANG_WASM_IMAGE, version: '23.1.0' },
    mos: { image: MOS_WASM_IMAGE, sdk: MOS_SDK_IMAGE },
    images: { musl: MUSL_IMAGE, sparc: SPARC_IMAGE, wasi: WASI_IMAGE },
    files: Object.fromEntries(['llvm.wasm', 'mos.wasm', 'sysroot.tar'].map((name) => {
      const path = join(OUT, name)
      return [name, { bytes: statSync(path).size, sha256: sha256(path) }]
    })),
    prunedClangHeaders: pruned.length,
  }
  writeFileSync(join(OUT, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  // The lock is committed: it is what packaging and scripts/fetch-toolchain.mjs
  // hold a bundle to, so an app only ever ships the bundle built here.
  writeFileSync(LOCK, `${JSON.stringify({ files: manifest.files }, null, 2)}\n`)
  console.log(JSON.stringify(manifest.files, null, 2))
}

buildToolchain()
