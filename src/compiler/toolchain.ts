/**
 * Compiles a user's C program for each real target, inside the app.
 *
 * The compiler is LLVM 23.1.0 built to WebAssembly (see
 * tools/isa/Dockerfile.clang-wasm) -- the same release, from the same
 * checksummed source, that compiled every fixture and every shipped binary.
 * The libraries are the same too: build-toolchain.ts copies them out of the
 * images the fixture builder uses. So a program compiled here is compiled
 * the way the app's own programs were, and runs on the same verified
 * interpreters.
 *
 * Each target is two steps, because WebAssembly has no processes and the
 * clang driver cannot start a linker itself: `clang -c` with the flags the
 * fixture builder uses, then the link the native driver would have run,
 * spelled out argument for argument (captured with `clang -###`). SPARC
 * links with this project's own linker, because lld cannot link it.
 *
 * The 6502 has its own compiler, llvm-mos, a fork of LLVM with the MOS
 * backend, built to WebAssembly the same way (tools/isa/Dockerfile.mos-wasm)
 * from the commit the llvm-mos SDK release the fixtures used was built from.
 */
import { Directory } from '@bjorn3/browser_wasi_shim'
import { IsaId } from '../engine/types.ts'
import { linkSparc } from './sparcLink.ts'
import { readTar } from './tar.ts'
import { getFile, putFile, runWasi } from './wasi.ts'
import { REAL_TARGET_FLAGS, wrapForRealTarget, type ReturnChannel } from './wrap.ts'

/** The compiler and libraries, as loaded from the toolchain bundle. */
export interface ToolchainFiles {
  llvm: WebAssembly.Module
  /** llvm-mos: clang and lld for the 6502. */
  mos: WebAssembly.Module
  sysroot: Uint8Array
}

export type CompileResult =
  | { ok: true; binary: Uint8Array; warnings: string }
  | { ok: false; stage: 'compile' | 'link'; message: string }

/** The flags every target compiles with; `-Wl,` ones belong to the link. */
const COMPILE_FLAGS = ['-O2', ...REAL_TARGET_FLAGS.filter((flag) => !flag.startsWith('-Wl,'))]

interface MuslTarget {
  kind: 'musl'
  /** Directory under /musl in the sysroot, and the triple's arch. */
  arch: 'riscv64' | 'aarch64' | 'x86_64' | 'mipsel' | 'powerpc64le'
  /** The link, as the native driver runs it, before the objects. */
  linkPrefix: string[]
}

type Recipe = MuslTarget | { kind: 'sparc' } | { kind: 'wasm' } | { kind: 'mos' }

/**
 * The 6502's compile, as `mos-sim-clang -Os -fwrapv` runs it (captured with
 * `-###` from the SDK the fixtures were built with; tools/isa/mos/
 * build-corpus.ts). It is the front end itself, `-cc1`, because the driver
 * reads the platform's flags from configuration files beside its own
 * executable, which a WebAssembly module does not have. The output is
 * bitcode: the SDK compiles every program with full link-time optimisation,
 * and the code is generated during the link.
 */
const MOS_TUNING = [
  '-force-precise-rotation-cost', '-jump-inst-cost=6', '-force-loop-cold-block',
  '-phi-node-folding-threshold=0', '-speculate-blocks=0', '-align-large-globals=false',
  '-disable-spill-hoist', '-lsr-complexity-limit=10000000',
].flatMap((option) => ['-mllvm', option])

function mosCompile(S: string): string[] {
  const M = `${S}/mos`
  return [
    'clang', '-cc1', '-triple', 'mos-sim', '-Os', '-emit-llvm-bc', '-flto=full', '-flto-unit',
    '-disable-free', '-clear-ast-before-backend', '-disable-llvm-verifier', '-discard-value-names',
    '-main-file-name', 'prog.c', '-mrelocation-model', 'static', '-mframe-pointer=all',
    '-fmath-errno', '-ffp-contract=on', '-fno-rounding-math', '-mconstructor-aliases',
    '-nostdsysteminc', '-fexperimental-assignment-tracking=disabled', ...MOS_TUNING,
    '-debugger-tuning=gdb', '-fdebug-compilation-dir=/work', '-ffunction-sections',
    '-fdata-sections', '-fcoverage-compilation-dir=/work', '-resource-dir', `${M}/clang`,
    '-isystem', `${M}/sim/include`, '-isystem', `${M}/common/include`,
    '-I', `${M}/sim/asminc`, '-I', `${M}/common/asminc`,
    '-internal-isystem', `${M}/clang/include`,
    // The SDK image's SOURCE_DATE_EPOCH, which fixes __DATE__ and __TIME__.
    '-source-date-epoch', '1787616000', '-ferror-limit', '19', '-fwrapv', '-fshort-enums',
    '-fno-signed-char', '-fgnuc-version=4.2.1', '-fskip-odr-check-in-gmf', '-vectorize-loops',
    '-vectorize-slp', '-faddrsig', '-o', '/work/prog.o', '-x', 'c', '/work/prog.c',
  ]
}

/** The link that goes with it, which is where the 6502 code is generated. */
function mosLink(S: string): string[] {
  const M = `${S}/mos`
  return [
    'ld.lld', '--gc-sections', '--sort-section=alignment', '/work/prog.o',
    '-plugin-opt=O2', '-plugin-opt=-function-sections=1', '-plugin-opt=-data-sections=1',
    ...MOS_TUNING, '-mllvm', '-zp-avail=224',
    `-L${M}/sim/lib`, `-L${M}/common/lib`, '-l:crt0.o', '-lcrt0', '-lcrt', '-lc',
    '-Tlink.ld', '-o', '/work/out.bin',
  ]
}

/**
 * What each target is compiled with. The link prefixes are the native
 * driver's own arguments for these targets, less the host library
 * directories it adds and nothing here uses.
 */
export const RECIPES: Readonly<Partial<Record<IsaId, Recipe>>> = {
  [IsaId.RISCV]: {
    kind: 'musl',
    arch: 'riscv64',
    linkPrefix: ['-z', 'relro', '--hash-style=gnu', '--eh-frame-hdr', '-m', 'elf64lriscv', '-X', '-static'],
  },
  [IsaId.ARM]: {
    kind: 'musl',
    arch: 'aarch64',
    linkPrefix: ['-EL', '-z', 'relro', '--hash-style=gnu', '--eh-frame-hdr', '-m', 'aarch64linux', '-static'],
  },
  [IsaId.X86]: {
    kind: 'musl',
    arch: 'x86_64',
    linkPrefix: ['-z', 'relro', '--hash-style=gnu', '--eh-frame-hdr', '-m', 'elf_x86_64', '-static'],
  },
  [IsaId.MIPS]: {
    kind: 'musl',
    arch: 'mipsel',
    linkPrefix: ['-z', 'relro', '--eh-frame-hdr', '-m', 'elf32ltsmip', '-static'],
  },
  [IsaId.POWER]: {
    kind: 'musl',
    arch: 'powerpc64le',
    linkPrefix: ['-z', 'relro', '--hash-style=gnu', '--eh-frame-hdr', '-m', 'elf64lppc', '-static'],
  },
  [IsaId.SPARC]: { kind: 'sparc' },
  [IsaId.WASM]: { kind: 'wasm' },
  [IsaId.MOS]: { kind: 'mos' },
}

/** The targets this toolchain can compile for. */
export function compilableTargets(): IsaId[] {
  return Object.keys(RECIPES) as IsaId[]
}

/**
 * A loaded toolchain. Construction unpacks the sysroot once; each compile
 * then works in a fresh copy of the tree, so one target's objects never
 * reach another's link.
 */
export class Toolchain {
  private readonly llvm: WebAssembly.Module
  private readonly mos: WebAssembly.Module
  private readonly sysroot: { path: string; bytes: Uint8Array }[]

  constructor(files: ToolchainFiles) {
    this.llvm = files.llvm
    this.mos = files.mos
    this.sysroot = readTar(files.sysroot)
  }

  private tree(): Directory {
    const root = new Directory(new Map())
    for (const { path, bytes } of this.sysroot) putFile(root, `/sysroot/${path}`, bytes)
    return root
  }

  private async run(
    root: Directory,
    argv: string[],
    module = this.llvm,
  ): Promise<{ code: number; output: string }> {
    const result = await runWasi(module, argv, root)
    return { code: result.code, output: [result.stdout, result.stderr].filter(Boolean).join('\n') }
  }

  /**
   * Compiles a Guest C program's source for one target, wrapped with the
   * driver that reports its return value on `channel`.
   */
  async compile(isa: IsaId, guestSource: string, channel: ReturnChannel = 'stderr'): Promise<CompileResult> {
    const recipe = RECIPES[isa]
    if (!recipe) {
      return { ok: false, stage: 'compile', message: `this build of the app has no compiler for ${isa}` }
    }
    const root = this.tree()
    putFile(root, '/work/prog.c', new TextEncoder().encode(wrapForRealTarget(guestSource, channel)))
    const S = '/sysroot'

    let compileArgs: string[]
    switch (recipe.kind) {
      case 'musl':
        compileArgs = [
          'clang', '-target', `${recipe.arch}-unknown-linux-musl`, ...COMPILE_FLAGS,
          // -static changes what the front end defines, so it stays even
          // though the link is a separate step.
          '-static', '-resource-dir', `${S}/clang`,
          '-isystem', `${S}/musl/${recipe.arch}/include`,
          '-c', '-o', '/work/prog.o', '/work/prog.c',
        ]
        break
      case 'sparc':
        // As tools/isa/targets/sparc.ts: V8, no PIC, picolibc's headers.
        compileArgs = [
          'clang', '--target=sparc-unknown-linux-gnu', '-mcpu=v8', '-fno-pic', '-fno-pie',
          ...COMPILE_FLAGS, '-DISA_NO_LONG_DOUBLE_VARARGS',
          '-nostdlibinc', '-resource-dir', `${S}/clang`, '-isystem', `${S}/sparc/include`,
          '-c', '-o', '/work/prog.o', '/work/prog.c',
        ]
        break
      case 'wasm':
        compileArgs = [
          'clang', '--target=wasm32-wasip1', ...COMPILE_FLAGS,
          '-resource-dir', `${S}/clang`, `--sysroot=${S}/wasi`,
          '-c', '-o', '/work/prog.o', '/work/prog.c',
        ]
        break
      case 'mos':
        compileArgs = mosCompile(S)
        break
    }
    const compiled = await this.run(root, compileArgs, recipe.kind === 'mos' ? this.mos : this.llvm)
    if (compiled.code !== 0 || !getFile(root, '/work/prog.o')) {
      return { ok: false, stage: 'compile', message: compiled.output || `clang exited with ${compiled.code}` }
    }

    let binary: Uint8Array | null
    let linkOutput = ''
    try {
      switch (recipe.kind) {
        case 'musl': {
          const lib = `${S}/musl/${recipe.arch}/lib`
          const linked = await this.run(root, [
            'ld.lld', ...recipe.linkPrefix, '-o', '/work/out.elf', `-L${lib}`, '--strip-all',
            `${lib}/crt1.o`, `${lib}/crti.o`, '/work/prog.o', '-lc', '-lm',
            `${lib}/libclang_rt.builtins-${recipe.arch}.a`, `${lib}/crtn.o`,
          ])
          linkOutput = linked.output
          if (linked.code !== 0) return { ok: false, stage: 'link', message: linked.output }
          binary = getFile(root, '/work/out.elf')
          break
        }
        case 'sparc': {
          const lib = `${S}/sparc/lib`
          const read = (path: string) => {
            const bytes = getFile(root, path)
            if (!bytes) throw new Error(`the toolchain bundle has no ${path}`)
            return { name: path.slice(path.lastIndexOf('/') + 1), bytes }
          }
          binary = linkSparc([
            read(`${lib}/crt1.o`), read('/work/prog.o'), read(`${lib}/platform.o`),
            read(`${lib}/libc.a`), read(`${lib}/libclang_rt.builtins-sparc.a`),
          ])
          break
        }
        case 'wasm': {
          const lib = `${S}/wasi/lib/wasm32-wasip1`
          const linked = await this.run(root, [
            'wasm-ld', '-m', 'wasm32', `-L${lib}`, `${lib}/crt1-command.o`, '--strip-all',
            '/work/prog.o', '-lm', '-lc', `${lib}/libclang_rt.builtins.a`, '-o', '/work/out.wasm',
          ])
          linkOutput = linked.output
          if (linked.code !== 0) return { ok: false, stage: 'link', message: linked.output }
          binary = getFile(root, '/work/out.wasm')
          break
        }
        case 'mos': {
          const linked = await this.run(root, mosLink(S), this.mos)
          linkOutput = linked.output
          if (linked.code !== 0) return { ok: false, stage: 'link', message: linked.output }
          // The platform's link script writes the raw image the machine
          // loads, which is what the fixtures are; the ELF beside it is
          // for debuggers.
          binary = getFile(root, '/work/out.bin')
          break
        }
      }
    } catch (error) {
      return { ok: false, stage: 'link', message: (error as Error).message }
    }
    if (!binary) return { ok: false, stage: 'link', message: 'the linker produced no output' }
    return { ok: true, binary, warnings: [compiled.output, linkOutput].filter(Boolean).join('\n') }
  }
}
