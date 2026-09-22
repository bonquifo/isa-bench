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
import { rv64Backend } from '../isa/riscv/backend.ts'
import * as rv64Shipped from '../isa/riscv/shipped.ts'

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
    shipped: rv64Shipped,
  },
  {
    id: IsaId.ARM,
    backend: aarch64Backend,
    label: 'AArch64',
    instructions: 'AArch64',
    oracle: 'qemu-aarch64',
    verified: 'register by register and flag by flag, before every instruction',
    shipped: aarch64Shipped,
  },
]
