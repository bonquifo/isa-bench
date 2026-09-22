/**
 * What this backend refuses, and that it refuses loudly.
 *
 * Three of these are particular to SPARC. The privileged state
 * registers are encoded in the same instruction as the one ordinary
 * program-visible one, so a decoder that read the field carelessly
 * would hand a user-mode program the window mask. Memory access must be
 * naturally aligned, with no unaligned pair to fall back on, so an
 * unaligned load is a fault rather than a slow path. And a trap that is
 * not the system call is a trap this backend does not implement, which
 * is different from one it implements as nothing.
 */
import { describe, expect, it } from 'vitest'
import { ElfError } from '../common/elf.ts'
import { ExecutionBudgetExceeded, GuestFault, IsaError, UnimplementedInstruction } from '../common/errors.ts'
import { GuestMemory, Prot } from '../common/memory.ts'
import { createRetireChunk, RunState } from '../common/trace.ts'
import { decode, SPARC } from './decode.ts'
import { NWINDOWS, SparcInterpreter } from './exec.ts'
import { SparcImage } from './image.ts'
import { loadSparc } from './load.ts'

const BASE = 0x1000

/** Assembles a tiny program at a known address and runs it. */
function machine(words: readonly number[], budget?: number): {
  cpu: SparcInterpreter
  memory: GuestMemory
} {
  const memory = new GuestMemory(false)
  // Page zero is mapped too, so a test can name a small address without
  // that turning into a fault about something else.
  memory.map(0n, 0x1000, Prot.READ | Prot.WRITE)
  memory.map(BigInt(BASE), 0x4000, Prot.READ | Prot.WRITE | Prot.EXEC)
  for (let i = 0; i < words.length; i++) {
    memory.store(BigInt(BASE + i * 4), 4, BigInt(words[i]! >>> 0))
  }
  const image = new SparcImage(memory, BigInt(BASE), words.length * 4)
  return {
    cpu: new SparcInterpreter(image, memory,
      budget === undefined ? {} : { instructionBudget: budget }),
    memory,
  }
}

function step(words: readonly number[], count = 1): SparcInterpreter {
  const { cpu } = machine(words)
  const chunk = createRetireChunk(count)
  cpu.run(chunk)
  return cpu
}

/** `op3` encodings in the format-3 arithmetic space. */
function format3(op: number, rd: number, op3: number, rs1: number, rs2: number): number {
  return ((op << 30) | (rd << 25) | (op3 << 19) | (rs1 << 14) | rs2) >>> 0
}

describe('sparc: instructions a user-mode program may not execute', () => {
  it('refuses to read the privileged state registers', () => {
    // rd %psr, %wim and %tbr share their encoding with `rd %y`, which is
    // the only one of the four a program may execute. They differ by the
    // rs1 field alone, so a decoder that ignored it would hand a guest
    // the window mask.
    for (const [rs1, name] of [[1, 'psr'], [2, 'wim'], [3, 'tbr']] as const) {
      expect(() => decode(format3(2, 5, 0x28 + rs1, 0, 0), 0x1000n), name)
        .toThrow(UnimplementedInstruction)
    }
    // And the one that is allowed still decodes.
    expect(decode(format3(2, 5, 0x28, 0, 0), 0x1000n).op).toBe(SPARC.RDY)
  })

  it('refuses to write them', () => {
    for (const op3 of [0x31, 0x32, 0x33]) {
      expect(() => decode(format3(2, 0, op3, 0, 0), 0x1000n)).toThrow(UnimplementedInstruction)
    }
  })

  it('refuses rett, which returns from a trap', () => {
    expect(() => decode(format3(2, 0, 0x39, 0, 0), 0x1000n)).toThrow(UnimplementedInstruction)
  })

  it('refuses the alternate-space loads, which name an address space', () => {
    // A user-mode program cannot execute one at all, so decoding it
    // would be claiming a capability the architecture does not give.
    expect(() => decode(format3(3, 5, 0x10, 1, 2), 0x1000n)).toThrow(UnimplementedInstruction)
  })
})

describe('sparc: alignment', () => {
  it('faults on an unaligned word load rather than splitting it', () => {
    // There is no unaligned pair on this architecture the way there is
    // on MIPS. A misaligned access traps, and a backend that quietly
    // performed it would be running programs the hardware would not.
    //   ld [%g0 + 2], %g1
    const words = [format3(3, 1, 0x00, 0, 0) | (1 << 13) | 2]
    expect(() => step(words)).toThrow(GuestFault)
  })

  it('faults on an unaligned halfword too', () => {
    //   lduh [%g0 + 1], %g1
    const words = [format3(3, 1, 0x02, 0, 0) | (1 << 13) | 1]
    expect(() => step(words)).toThrow(GuestFault)
  })

  it('allows a byte load at any address, which needs no alignment', () => {
    //   ldub [%g0 + 3], %g1
    const words = [format3(3, 1, 0x01, 0, 0) | (1 << 13) | 3]
    expect(() => step(words)).not.toThrow()
  })

  it('refuses to fetch an instruction from an unaligned address', () => {
    const { cpu } = machine([0x01000000])
    expect(() => cpu.image.at(BigInt(BASE + 2))).toThrow(IsaError)
  })
})

describe('sparc: traps', () => {
  it('refuses a trap that is not the system call', () => {
    // `ta 0x20` is a trap number this platform does not define. Running
    // it as nothing would let a program that meant to ask the kernel
    // something continue as though it had been answered.
    //   ta 0x20  =  Ticc, cond = 8 (always), rs1 = %g0, imm = 0x20
    const word = (((2 << 30) | (8 << 25) | (0x3a << 19) | (0 << 14)) >>> 0) |
      (1 << 13) | 0x20
    expect(() => step([word])).toThrow(/is not a system call/)
  })

  it('refuses a system call with no emulation layer behind it', () => {
    const word = (((2 << 30) | (8 << 25) | (0x3a << 19) | (0 << 14)) >>> 0) |
      (1 << 13) | 0x10
    expect(() => step([word])).toThrow(/no emulation layer/)
  })

  it('stops on unimp rather than treating it as a gap', () => {
    expect(() => step([0])).toThrow(/unimp/)
  })

  it('refuses a divide by zero rather than answering', () => {
    //   udiv %g0, 0, %g1  — the architecture traps, and the trap is not
    //   modelled, so this stops the run.
    const word = format3(2, 1, 0x0e, 0, 0) | (1 << 13)
    expect(() => step([word])).toThrow(/divide by zero/)
  })
})

describe('sparc: the register window', () => {
  it('starts with the entry window blocked', () => {
    // Otherwise `save` could wrap the whole way round and overwrite the
    // frame the process started in.
    const { cpu } = machine([0x01000000])
    expect(cpu.cwp).toBe(0)
    expect(cpu.wim).toBe(1)
  })

  it('rotates downwards on save and back on restore', () => {
    //   save %g0, 0, %g0   then   restore %g0, 0, %g0
    const save = format3(2, 0, 0x3c, 0, 0) | (1 << 13)
    const restore = format3(2, 0, 0x3d, 0, 0) | (1 << 13)
    const { cpu } = machine([save, restore])
    // Block a window neither of these two moves into, so this is a test
    // of the rotation alone. The spill and fill paths are covered by
    // the fixtures, which take thirty-eight real window traps between
    // them.
    cpu.wim = 1 << 1
    const chunk = createRetireChunk(1)
    cpu.run(chunk)
    expect(cpu.cwp).toBe(NWINDOWS - 1)
    cpu.run(chunk)
    expect(cpu.cwp).toBe(0)
  })

  it('makes the caller\'s outs the callee\'s ins', () => {
    // This overlap is how arguments are passed without touching memory,
    // and it is the property the physical register mapping exists to
    // get right.
    const save = format3(2, 0, 0x3c, 0, 0) | (1 << 13)
    const { cpu } = machine([save])
    cpu.setReg(8, 0x1234)      // %o0 before
    const chunk = createRetireChunk(1)
    cpu.run(chunk)
    expect(cpu.reg(24)).toBe(0x1234) // %i0 after
  })
})

describe('sparc: images that are not SPARC', () => {
  it('refuses another architecture', () => {
    const elf = new Uint8Array(64)
    elf.set([0x7f, 0x45, 0x4c, 0x46, 1, 2, 1])
    elf[18] = 0
    elf[19] = 243 // RISC-V, big endian
    expect(() => loadSparc(elf)).toThrow(ElfError)
  })

  it('refuses a little-endian object', () => {
    const elf = new Uint8Array(64)
    elf.set([0x7f, 0x45, 0x4c, 0x46, 1, 1, 1])
    elf[18] = 2
    elf[19] = 0
    expect(() => loadSparc(elf)).toThrow(ElfError)
  })
})

describe('sparc: running out of budget', () => {
  it('stops a guest that will not finish', () => {
    //   ba .  with a nop in the delay slot: the idiom for hanging.
    //   op 0, cond 8 (always), op2 2 (Bicc), displacement 0 -- which is
    //   this instruction's own address, so it branches to itself.
    const ba = (((0 << 30) | (8 << 25) | (2 << 22)) >>> 0)
    const { cpu } = machine([ba, 0x01000000], 5000)
    const chunk = createRetireChunk(64)
    expect(() => {
      let state: RunState = RunState.MORE
      while (state === RunState.MORE) state = cpu.run(chunk)
    }).toThrow(ExecutionBudgetExceeded)
  })
})
