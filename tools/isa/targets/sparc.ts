/**
 * SPARC V8 as a fixture target.
 *
 * Three things here differ from every other target, and each is forced
 * by the architecture or the toolchain rather than chosen.
 *
 * **It is linked in a different container from the one it is compiled
 * in.** `lld` cannot link 32-bit SPARC -- it refuses with `unknown
 * emulation: elf32_sparc` -- so clang produces objects in the codegen
 * image and GNU binutils links them in another. That is what
 * `ExternalLinker` in the builder exists for.
 *
 * **clang wants `-mcpu`, not `-march`**, for this target and rejects
 * `-march=` outright, so the architecture selector is passed through
 * `extraFlags` and `march` is left empty.
 *
 * **qemu emits a trapping instruction twice.** A window overflow or
 * underflow is handled inside qemu-user rather than by running guest
 * code, and qemu restarts the translation block afterwards, so the
 * trace contains the same pc, npc and registers twice in a row with
 * only `wim` changed. The parser collapses each such pair, keeping the
 * *first*: that is the state before the trap, which is what an
 * interpreter has before executing the instruction that traps, since
 * the spill happens inside it.
 *
 * Getting that backwards is not subtle in its effect -- it reports a
 * mismatch on `wim` at the first recursion deeper than eight frames --
 * but it is easy to get backwards, which is why it is written down.
 */
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { qemuOracle, type FixtureTarget, type LockstepStep } from '../fixture-builder.ts'
import { CORPUS_FLAGS, corpusPrograms } from '../corpus.ts'
import { generateRandomProgram } from '../sparc/random.ts'

/** Built from tools/isa/Dockerfile.sparc-libc. */
const SPARC_LIBC_IMAGE = 'isa-bench/sparc-picolibc:1.8.10'

const HERE = dirname(fileURLToPath(import.meta.url))
const TOOLS = resolve(HERE, '..')
const ROOT = resolve(TOOLS, '../..')

/**
 * The 32 window-relative registers, `y`, the four condition codes, the
 * window pointer, `npc` and `wim`. The order matches the resource ids
 * in src/isa/sparc/image.ts, so a mismatch is labelled with the name of
 * the thing that actually differs.
 *
 * `npc` is in the comparison because on this architecture it is
 * architectural state rather than a derived value: after a branch the
 * two program counters differ, and an implementation that got the delay
 * slot wrong would still agree on `pc` for one instruction longer than
 * it should. `cwp` and `wim` are there because the window traps move
 * them from inside an instruction, where nothing else would see it.
 */
export const SPARC_GPR_COUNT = 40
export const SPARC_Y_SLOT = 32
/** N, Z, V and C, each its own slot, in that order. */
export const SPARC_N_SLOT = 33
export const SPARC_CWP_SLOT = 37
export const SPARC_NPC_SLOT = 38
export const SPARC_WIM_SLOT = 39

const RANDOM_SEEDS = [1, 2, 3, 5, 8, 13, 21, 34, 55, 89, 144, 233]

const BLOCK = new RegExp(
  String.raw`pc: ([0-9a-f]+)\s+npc: ([0-9a-f]+)\s*\n` +
  String.raw`%g0-7:([^\n]*)\n%o0-7:([^\n]*)\n%l0-7:([^\n]*)\n%i0-7:([^\n]*)\n` +
  String.raw`psr: ([0-9a-f]+)[^\n]*wim: ([0-9a-f]+)\n` +
  String.raw`fsr: ([0-9a-f]+) y: ([0-9a-f]+)`,
  'g',
)

export function parseSparcCpuLog(text: string): LockstepStep[] {
  const raw: LockstepStep[] = []
  const words = (s: string): bigint[] =>
    s.trim().split(/\s+/).filter((t) => t.length > 0).map((t) => BigInt(`0x${t}`))

  BLOCK.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = BLOCK.exec(text)) !== null) {
    const psr = Number(BigInt(`0x${match[7]!}`))
    const x = [
      ...words(match[3]!), ...words(match[4]!),
      ...words(match[5]!), ...words(match[6]!),
    ]
    if (x.length !== 32) continue
    x[SPARC_Y_SLOT] = BigInt(`0x${match[10]!}`)
    // N Z V C occupy bits 23 down to 20 of the status register, in that
    // order. They are unpacked into a slot each so that a mismatch says
    // which flag, and so the timing model and the comparison can share
    // one set of resource ids.
    for (let bit = 0; bit < 4; bit++) {
      x[SPARC_N_SLOT + bit] = BigInt((psr >>> (23 - bit)) & 1)
    }
    // The window pointer is the low five bits of the same register.
    x[SPARC_CWP_SLOT] = BigInt(psr & 0x1f)
    x[SPARC_NPC_SLOT] = BigInt(`0x${match[2]!}`)
    x[SPARC_WIM_SLOT] = BigInt(`0x${match[8]!}`)
    raw.push({ pc: BigInt(`0x${match[1]!}`), x })
  }

  // Collapse the pair a window trap produces. Everything but `wim` is
  // identical across it, including both program counters, so comparing
  // those is enough to recognise one without also matching on the thing
  // that changed.
  const steps: LockstepStep[] = []
  for (let i = 0; i < raw.length; i++) {
    const now = raw[i]!
    const before = raw[i - 1]
    if (before && before.pc === now.pc &&
        before.x[SPARC_NPC_SLOT] === now.x[SPARC_NPC_SLOT] &&
        sameExceptWim(before.x, now.x)) {
      continue
    }
    steps.push(now)
  }
  return steps
}

function sameExceptWim(a: readonly bigint[], b: readonly bigint[]): boolean {
  for (let r = 0; r < SPARC_GPR_COUNT; r++) {
    if (r === SPARC_WIM_SLOT) continue
    if (a[r] !== b[r]) return false
  }
  return true
}

export const sparcTarget: FixtureTarget = {
  id: 'sparc',
  codegen: 'isa-bench/codegen-min:23.1.0',
  oracle: qemuOracle('isa-sim/qemu-user:11.1.0', '/opt/qemu/bin/qemu-sparc'),
  triple: 'sparc-unknown-linux-gnu',
  // clang rejects -march= for this target, so the selector is a flag.
  march: '',
  // `-fno-pic` for the same reason MIPS needs it, reached from the other
  // direction. This target defaults to position-independent code, and
  // there the assembler turns `%hi(sym)` into a GOT reference -- so the
  // hand-written entry stub loads a GOT *offset* into %sp rather than
  // the address of the stack, and the first store faults. With the flag
  // the relocations are ordinary R_SPARC_HI22 and R_SPARC_LO10.
  extraFlags: ['-mcpu=v8', '-fno-pic'],
  linker: {
    image: 'isa-sim/sparc-linker:2.40-2',
    command: (objects, out) =>
      `sparc64-linux-gnu-ld -m elf32_sparc -static -e _start -o ${out} ${objects.join(' ')}`,
  },
  harnessDir: join(TOOLS, 'sparc'),
  sharedProgramsDir: join(TOOLS, 'programs'),
  programsDir: join(TOOLS, 'sparc/programs'),
  outDir: join(ROOT, 'src/isa/sparc/fixtures'),
  workDir: join(ROOT, 'node_modules/.tmp/isa-fixtures/sparc'),
  /** Keep in sync with ISA_DUMP_BYTES in tools/isa/sparc/harness.h. */
  dumpBytes: 1296,
  gprCount: SPARC_GPR_COUNT,
  randomSeeds: RANDOM_SEEDS,
  randomGenerator: 'tools/isa/sparc/random.ts',
  generateRandom: (seed: number) => generateRandomProgram(seed),
  parseCpuLog: parseSparcCpuLog,
  // Whole programs against picolibc, since musl has no SPARC port. The
  // image, and why this library rather than another, is described in
  // tools/isa/Dockerfile.sparc-libc; the part that is this project's own
  // -- a Linux `_start`, a static heap and five system calls -- is in
  // tools/isa/sparc/platform/.
  libc: {
    triple: 'sparc-unknown-linux-gnu',
    image: SPARC_LIBC_IMAGE,
    sysroot: '/sysroot/sparc',
    builtins: '/sysroot/sparc/lib/libclang_rt.builtins-sparc.a',
    programsDir: join(TOOLS, 'libc'),
    libs: [],
    extra: corpusPrograms().map((program) => ({
      name: program.name,
      source: program.source,
      flags: CORPUS_FLAGS,
    })),
    // Compiled by clang like every other target, linked by GNU ld because
    // lld cannot. The -Wl flags a program carries go to the linker; the
    // rest go to the compiler.
    build: (flags) => {
      const compile = flags.filter((flag) => !flag.startsWith('-Wl,'))
      const link = flags.filter((flag) => flag.startsWith('-Wl,'))
        .flatMap((flag) => flag.slice(4).split(','))
      const lib = '/sysroot/sparc/lib'
      // ISA_NO_LONG_DOUBLE_VARARGS: see tools/isa/libc/mathfmt.c. clang
      // passes a long double through `...` wrongly on this target, so the
      // one program that prints one prints it through double here.
      return `clang $SPARC_CFLAGS -O2 -DISA_NO_LONG_DOUBLE_VARARGS ${compile.join(' ')} ` +
        '-nostdlibinc -isystem /sysroot/sparc/include ' +
        '-c -o /work/libc-prog.o /work/prog.c && ' +
        `sparc64-linux-gnu-ld -m elf32_sparc -static -e _start ${link.join(' ')} ` +
        `-o /work/out.elf ${lib}/crt1.o /work/libc-prog.o ${lib}/platform.o ` +
        `--start-group ${lib}/libc.a ${lib}/libclang_rt.builtins-sparc.a --end-group && ` +
        // The object is left for nobody: this image runs as root and the
        // freestanding stage's does not, and a root-owned file in the
        // shared work directory is one it then cannot overwrite.
        'rm -f /work/libc-prog.o'
    },
  },
}
