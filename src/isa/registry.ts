/**
 * Which targets can execute real compiled code, and how to reach them.
 *
 * The app compares eight targets. Two are still pseudo-backends driven by
 * the engine's own lowering; six execute real instructions. Rather than
 * scatter that distinction through the UI and the comparison path, it is
 * asked for here: a target with a backend runs real code, and a target
 * without one continues to run exactly as it does today.
 *
 * Registering a backend is the whole act of adding an instruction set. What
 * it has to satisfy is in ./backend.ts, and whether it does is decided by the
 * conformance suite in ./conformance.node.ts.
 */
import type { IsaId } from '../engine/types.ts'
import type { IsaBackend } from './backend.ts'
import { aarch64Backend } from './aarch64/backend.ts'
import { mipsBackend } from './mips/backend.ts'
import { mosBackend } from './mos/backend.ts'
import { rv64Backend } from './riscv/backend.ts'
import { sparcBackend } from './sparc/backend.ts'
import { x86Backend } from './x86/backend.ts'

const BACKENDS: readonly IsaBackend[] = [
  rv64Backend, aarch64Backend, x86Backend, mipsBackend, mosBackend, sparcBackend,
]

const BY_ID = new Map<IsaId, IsaBackend>(BACKENDS.map((backend) => [backend.id, backend]))

/** The backend for a target, or undefined where none exists yet. */
export function backendFor(isa: IsaId): IsaBackend | undefined {
  return BY_ID.get(isa)
}

/** Whether this target executes real instructions rather than a lowering. */
export function hasRealBackend(isa: IsaId): boolean {
  return BY_ID.has(isa)
}

/** Every registered backend, in registration order. */
export function realBackends(): readonly IsaBackend[] {
  return BACKENDS
}
