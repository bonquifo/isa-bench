/**
 * The targets the real-ISA lane can run, and what the lane is allowed to
 * say about each.
 *
 * Every field here is a claim the differential suite has to have earned.
 * `oracle` names the emulator the interpreter was compared against, and
 * `verified` says how far that comparison went, because "runs real
 * instructions" means nothing without saying against what and how closely.
 * A target belongs in this list once its conformance suite is green, and the
 * registry in ../isa/registry.ts is what decides that it exists at all.
 *
 * This module pulls in every shipped binary for every target, so it is
 * imported by the lane and nothing else: the lane is loaded lazily, which
 * keeps tens of megabytes of inlined ELF out of the app's first chunk.
 */
import { IsaId } from '../engine/types.ts'
import { aarch64Backend } from '../isa/aarch64/backend.ts'
import * as aarch64Shipped from '../isa/aarch64/shipped.ts'
import type { IsaBackend } from '../isa/backend.ts'
import { mipsBackend } from '../isa/mips/backend.ts'
import * as mipsShipped from '../isa/mips/shipped.ts'
import { mosBackend } from '../isa/mos/backend.ts'
import * as mosShipped from '../isa/mos/shipped.ts'
import { powerBackend } from '../isa/power/backend.ts'
import * as powerShipped from '../isa/power/shipped.ts'
import { rv64Backend } from '../isa/riscv/backend.ts'
import * as rv64Shipped from '../isa/riscv/shipped.ts'
import { wasmBackend } from '../isa/wasm/backend.ts'
import * as wasmShipped from '../isa/wasm/shipped.ts'
import { x86Backend } from '../isa/x86/backend.ts'
import * as x86Shipped from '../isa/x86/shipped.ts'

/** The parts of a target's shipped-binary module the lane uses. */
interface ShippedModule {
  shippedPrograms: typeof rv64Shipped.shippedPrograms
  unshippedProgramIds: typeof rv64Shipped.unshippedProgramIds
  loadShippedElf: typeof rv64Shipped.loadShippedElf
}

export interface RealTarget {
  id: IsaId
  backend: IsaBackend
  /** What the lane calls the target, e.g. "RV64GC". */
  label: string
  /** What the instructions are called in prose, e.g. "RISC-V". */
  instructions: string
  /** The emulator the interpreter is compared against. */
  oracle: string
  /** One clause saying how far that comparison goes. */
  verified: string
  /** What the binaries are linked against, named rather than assumed. */
  libc: string
  /**
   * How the corpus driver reports the program's return value.
   *
   * Every target with two output streams puts it on stderr, where it
   * cannot disturb the program's own output. The 6502's platform is one
   * byte-wide port, so there the two share a stream and are framed apart
   * by RETURN_SEPARATOR instead.
   */
  returnChannel: 'stderr' | 'framed'
  /**
   * How wide a C `int` is on this target.
   *
   * The corpus was written where it is thirty-two, and several of the
   * programs accumulate past what sixteen holds. On a target where it is
   * narrower those programs compute a different value and are right to,
   * so the lane has to be able to say that rather than report a
   * mismatch.
   */
  intBits: 16 | 32
  shipped: ShippedModule
}

export const REAL_TARGETS: readonly RealTarget[] = [
  {
    id: IsaId.RISCV,
    backend: rv64Backend,
    label: 'RV64GC',
    instructions: 'RISC-V',
    oracle: 'qemu-riscv64',
    verified: 'register by register, before every instruction',
    libc: 'musl',
    returnChannel: 'stderr',
    intBits: 32,
    shipped: rv64Shipped,
  },
  {
    id: IsaId.ARM,
    backend: aarch64Backend,
    label: 'AArch64',
    instructions: 'AArch64',
    oracle: 'qemu-aarch64',
    verified: 'register by register and flag by flag, before every instruction',
    libc: 'musl',
    returnChannel: 'stderr',
    intBits: 32,
    shipped: aarch64Shipped,
  },
  {
    id: IsaId.X86,
    backend: x86Backend,
    label: 'x86-64',
    instructions: 'x86-64',
    // The one target whose reference is not an emulator. The machine the
    // tests run on is an x86-64 machine, so the comparison can be against
    // the processor itself, single-stepped through ptrace.
    oracle: 'the host processor',
    verified: 'register by register and flag by flag, before every instruction',
    libc: 'musl',
    returnChannel: 'stderr',
    intBits: 32,
    shipped: x86Shipped,
  },
  {
    id: IsaId.MIPS,
    backend: mipsBackend,
    label: 'MIPS32',
    instructions: 'MIPS32',
    oracle: 'qemu-mipsel',
    // The HI and LO pair is in the trace too, which matters here: they
    // are written by one instruction and read by another several later.
    verified: 'register by register, before every instruction',
    libc: 'musl',
    returnChannel: 'stderr',
    intBits: 32,
    shipped: mipsShipped,
  },
  {
    id: IsaId.POWER,
    backend: powerBackend,
    label: 'POWER',
    instructions: 'POWER (powerpc64le)',
    oracle: 'qemu-ppc64le',
    // The condition register is compared field by field, and the vector
    // unit -- which musl's string functions and the compiler's own
    // vectorised loops reach -- is covered by programs that dump every
    // result for a byte-for-byte comparison.
    verified: 'register by register, before every instruction',
    libc: 'musl',
    returnChannel: 'stderr',
    intBits: 32,
    shipped: powerShipped,
  },
  {
    id: IsaId.MOS,
    backend: mosBackend,
    label: 'MOS 6502',
    instructions: '6502',
    // The only target with no emulator to step alongside: mos-sim cannot
    // be traced. So the comparison is made per instruction instead of per
    // step, against cases recorded from the hardware itself, and then
    // whole programs are compared against the simulator end to end. Both
    // halves are named here because neither alone is what the others do.
    oracle: 'hardware-recorded opcode vectors, then mos-sim',
    verified: 'every documented opcode from arbitrary machine state, ' +
      'then whole programs end to end',
    libc: "llvm-mos's libc",
    // One output port, so stdout and stderr are the same stream here.
    returnChannel: 'framed',
    intBits: 16,
    shipped: mosShipped,
  },
  {
    id: IsaId.WASM,
    backend: wasmBackend,
    label: 'WebAssembly',
    instructions: 'WebAssembly',
    // Two references, and neither is an emulator. The systematic and
    // generated tiers run against the engine inside the process running
    // the tests, which is the only target here whose oracle needs no
    // container at all. The whole programs are compared against
    // wasmtime, a different engine from a different vendor -- so the
    // agreement is with two independent implementations rather than one.
    oracle: "the host's WebAssembly engine, then wasmtime",
    // No lockstep: no engine will single-step a module and report the
    // operand stack, which after compilation has largely stopped
    // existing. What replaces it is stronger per instruction and
    // stronger at the end -- every operation against every edge value,
    // and all of linear memory rather than a chosen set of registers.
    verified: 'every operation against every edge value, ' +
      'then whole modules on all of memory byte for byte',
    libc: 'wasi-libc',
    returnChannel: 'stderr',
    intBits: 32,
    shipped: wasmShipped,
  },
]
