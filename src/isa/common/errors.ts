/**
 * Faults raised by the real-ISA interpreters.
 *
 * Every one of these is deliberately loud. The worst outcome for this project
 * is an instruction that quietly does something plausible: the architectural
 * state is then wrong, every timing number downstream inherits the error, and
 * nothing looks broken. So there is no default arm in any decoder or execute
 * switch — an encoding we have not implemented throws, and the message carries
 * enough to reproduce it.
 */

/** Base for every guest-visible fault, so callers can catch the family. */
export class IsaError extends Error {}

function hexBytes(raw: Uint8Array): string {
  return Array.from(raw, (b) => b.toString(16).padStart(2, '0')).join(' ')
}

/** An encoding the decoder recognises the shape of but does not implement. */
export class UnimplementedInstruction extends IsaError {
  readonly isa: string
  readonly address: bigint
  readonly raw: Uint8Array
  readonly detail: string

  constructor(isa: string, address: bigint, raw: Uint8Array, detail: string) {
    super(
      `${isa}: unimplemented instruction at 0x${address.toString(16)} ` +
      `[${hexBytes(raw)}] — ${detail}`,
    )
    this.name = 'UnimplementedInstruction'
    this.isa = isa
    this.address = address
    this.raw = raw
    this.detail = detail
  }
}

/** A bit pattern that is not a valid instruction in this ISA at all. */
export class IllegalInstruction extends IsaError {
  readonly isa: string
  readonly address: bigint
  readonly raw: Uint8Array

  constructor(isa: string, address: bigint, raw: Uint8Array, detail = 'illegal encoding') {
    super(`${isa}: ${detail} at 0x${address.toString(16)} [${hexBytes(raw)}]`)
    this.name = 'IllegalInstruction'
    this.isa = isa
    this.address = address
    this.raw = raw
  }
}

export type AccessKind = 'read' | 'write' | 'execute'

/** An access outside anything the loader mapped. */
export class GuestFault extends IsaError {
  readonly address: bigint
  readonly width: number
  readonly kind: AccessKind

  constructor(kind: AccessKind, address: bigint, width: number, detail = 'unmapped') {
    super(`guest ${kind} fault: ${width} byte(s) at 0x${address.toString(16)} (${detail})`)
    this.name = 'GuestFault'
    this.address = address
    this.width = width
    this.kind = kind
  }
}

/** A syscall number, or an argument shape, the emulation layer does not cover. */
export class UnsupportedSyscall extends IsaError {
  readonly number: number

  constructor(isa: string, num: number, detail = 'not implemented') {
    super(`${isa}: syscall ${num} ${detail}`)
    this.name = 'UnsupportedSyscall'
    this.number = num
  }
}

/** The guest ran past its instruction budget; almost always a real hang. */
export class ExecutionBudgetExceeded extends IsaError {
  readonly retired: number

  constructor(isa: string, retired: number) {
    super(`${isa}: execution budget exceeded after ${retired} retired instructions`)
    this.name = 'ExecutionBudgetExceeded'
    this.retired = retired
  }
}
