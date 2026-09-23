/**
 * What this backend refuses, and that it refuses loudly.
 *
 * Two of these are particular to POWER. The floating-point status
 * register is not modelled at all, and reading it is refused rather
 * than answered with a plausible zero -- it holds the rounding mode,
 * and this interpreter only rounds to nearest, so a program that set a
 * different mode and carried on would get quietly wrong answers. And
 * the vector operations are decoded but have no semantics yet, which is
 * a stated gap rather than a silent one: they stop the run.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ElfError } from '../common/elf.ts'
import { ExecutionBudgetExceeded, IsaError, UnimplementedInstruction } from '../common/errors.ts'
import { GuestMemory, Prot } from '../common/memory.ts'
import { createRetireChunk, RunState } from '../common/trace.ts'
import { PPC, decode } from './decode.ts'
import { PowerInterpreter } from './exec.ts'
import { PowerImage, Res } from './image.ts'
import { POWER_FIXTURE_DIR } from './fixtures.node.ts'
import { loadPower } from './load.ts'

const BASE = 0x1000

function machine(words: readonly number[], budget?: number): {
  cpu: PowerInterpreter
  memory: GuestMemory
} {
  const memory = new GuestMemory(true)
  memory.map(0n, 0x1000, Prot.READ | Prot.WRITE)
  memory.map(BigInt(BASE), 0x4000, Prot.READ | Prot.WRITE | Prot.EXEC)
  for (let i = 0; i < words.length; i++) {
    memory.store(BigInt(BASE + i * 4), 4, BigInt(words[i]! >>> 0))
  }
  const image = new PowerImage(memory, BigInt(BASE), words.length * 4)
  return {
    cpu: new PowerInterpreter(image, memory,
      budget === undefined ? {} : { instructionBudget: budget }),
    memory,
  }
}

function step(words: readonly number[]): PowerInterpreter {
  const { cpu } = machine(words)
  cpu.run(createRetireChunk(1))
  return cpu
}

/** An X-form instruction, in the manual's field order. */
function xForm(primary: number, rd: number, ra: number, rb: number, xo: number): number {
  return ((primary << 26) | (rd << 21) | (ra << 16) | (rb << 11) | (xo << 1)) >>> 0
}

describe('power: state this backend does not model', () => {
  it('refuses to read the floating-point status register', () => {
    // `mffs` would be answered with a zero that looks like an answer.
    // What it actually holds is the rounding mode and the sticky
    // exception bits, neither of which exists here.
    const mffs = xForm(63, 1, 0, 0, 583)
    expect(() => step([mffs])).toThrow(UnimplementedInstruction)
  })

  it('refuses to write it', () => {
    const mtfsf = xForm(63, 0, 0, 1, 711)
    expect(() => step([mtfsf])).toThrow(UnimplementedInstruction)
  })

  it('says why, so the message is a bug report rather than a symptom', () => {
    let message = ''
    try { step([xForm(63, 1, 0, 0, 583)]) } catch (error) { message = (error as Error).message }
    expect(message).toContain('rounds to nearest')
  })

  it('refuses the vector encodings nothing measured uses', () => {
    // The vector operations the libc and corpus binaries contain are
    // implemented; the rest of the space is refused rather than guessed.
    const vx = (xo: number): number =>
      ((4 << 26) | (2 << 21) | (3 << 16) | (4 << 11) | xo) >>> 0
    // `vspltish` and `vspltisb` splat halfwords and bytes. They used to
    // decode as `vspltisw`, which would have produced the right value in
    // the wrong element width.
    expect(() => decode(vx(844), 0x1000n)).toThrow(UnimplementedInstruction)
    expect(() => decode(vx(780), 0x1000n)).toThrow(UnimplementedInstruction)
    // A comparison with the record bit also writes a condition field,
    // which is not implemented.
    expect(() => decode(vx(134 + 1024), 0x1000n)).toThrow(UnimplementedInstruction)
    // And the word form itself still decodes, so the refusals above are
    // about those encodings and not the whole family.
    expect(decode(vx(908), 0x1000n).op).toBe(PPC.VSPLTISW)
  })

  it('refuses the word-order VSX loads rather than treating them as doubleword ones', () => {
    // `lxvw4x` places four words in a different order from `lxvd2x` on a
    // little-endian machine, and used to be decoded as it.
    expect(() => decode(xForm(31, 2, 3, 4, 780), 0x1000n)).toThrow(UnimplementedInstruction)
  })

  it('decodes the VSX arithmetic at the encodings LLVM assembles', () => {
    // Words from `clang --target=powerpc64le -c` on each instruction.
    // Before these were measured, xscmpudp decoded as a negated
    // multiply-add, and xsaddsp as a compare.
    expect(decode(0xf0821918, 0x1000n).op).toBe(PPC.XSCMP) // xscmpudp
    expect(decode(0xf0221d08, 0x1000n).op).toBe(PPC.XSNMADD) // xsnmaddadp
    expect(decode(0xf0221dc8, 0x1000n).op).toBe(PPC.XSNMSUB) // xsnmsubmdp
  })

  it('refuses the VSX arithmetic it has no semantics for', () => {
    // Single-precision scalar add, and the element-wise subtract and
    // divide, which used to decode as add and multiply.
    expect(() => decode(0xf0221800, 0x1000n)).toThrow(UnimplementedInstruction) // xsaddsp
    expect(() => decode(0xf0221a40, 0x1000n)).toThrow(UnimplementedInstruction) // xvsubsp
    expect(() => decode(0xf0221ac0, 0x1000n)).toThrow(UnimplementedInstruction) // xvdivsp
  })

  it('refuses a conditional trap rather than always taking it', () => {
    expect(() => decode(0x7c832008, 0x1000n)).toThrow(UnimplementedInstruction) // tweq 3, 4
    expect(decode(0x7fe00008, 0x1000n).op).toBe(PPC.TRAP) // trap
    expect(decode(0x7fe00088, 0x1000n).op).toBe(PPC.TRAP) // tdu 0, 0
  })

  it('writes only doubleword 0 for a scalar VSX store', () => {
    // `stxsdx` once wrote all sixteen bytes, overwriting the eight after
    // its operand. Those eight must survive.
    const stxsdx = xForm(31, 2, 0, 4, 716)
    const { cpu, memory } = machine([stxsdx])
    memory.store(0x108n, 8, 0x1111_2222_3333_4444n)
    cpu.vsrHi[2] = 0xaaaa_bbbb_cccc_ddddn
    cpu.vsrLo[2] = 0xeeee_ffff_0000_1111n
    cpu.setGpr(4, 0x100n)
    cpu.run(createRetireChunk(1))
    expect(memory.load(0x100n, 8, false)).toBe(0xaaaa_bbbb_cccc_ddddn)
    expect(memory.load(0x108n, 8, false)).toBe(0x1111_2222_3333_4444n)
  })
})

describe('power: encodings this backend does not implement', () => {
  it('refuses an unknown primary opcode', () => {
    expect(() => decode((1 << 26) >>> 0, 0x1000n)).toThrow(UnimplementedInstruction)
  })

  it('refuses an unknown extended opcode in the largest space', () => {
    expect(() => decode(xForm(31, 3, 4, 5, 1023), 0x1000n)).toThrow(UnimplementedInstruction)
  })

  it('reports one found while speculating as unavailable, not as a throw', () => {
    const memory = new GuestMemory(true)
    memory.map(BigInt(BASE), 0x1000, Prot.READ | Prot.WRITE | Prot.EXEC)
    // `nop`, then an opcode that is not an instruction.
    memory.store(BigInt(BASE), 4, BigInt(0x60000000))
    memory.store(BigInt(BASE + 4), 4, BigInt((1 << 26) >>> 0))
    const image = new PowerImage(memory, BigInt(BASE), 8)
    expect(image.speculativeAt(BigInt(BASE))).not.toBeNull()
    expect(image.speculativeAt(BigInt(BASE + 4))).toBeNull()
    expect(() => image.at(BigInt(BASE + 4))).toThrow(UnimplementedInstruction)
  })

  it('refuses to fetch an instruction from an unaligned address', () => {
    const { cpu } = machine([0x60000000])
    expect(() => cpu.image.at(BigInt(BASE + 2))).toThrow(IsaError)
  })
})

describe('power: the registers other architectures keep in flags', () => {
  it('gives each condition-register field its own resource', () => {
    // Eight independent conditions, which is the whole reason this
    // architecture has them: code routinely has two in flight.
    const { cpu } = machine([0x60000000])
    cpu.cr[3] = 0b0100
    cpu.cr[6] = 0b1000
    expect(cpu.gpr(Res.CR + 3)).toBe(4n)
    expect(cpu.gpr(Res.CR + 6)).toBe(8n)
    // And the packed form only exists where an instruction asks for it.
    expect(cpu.packedCr()).toBe(((4 << 16) | (8 << 4)) >>> 0)
  })

  it('keeps carry out of the ordinary arithmetic', () => {
    //   add r3, r4, r5   with operands that would carry
    const add = ((31 << 26) | (3 << 21) | (4 << 16) | (5 << 11) | (266 << 1)) >>> 0
    const { cpu } = machine([add])
    cpu.setGpr(4, 0xffff_ffff_ffff_ffffn)
    cpu.setGpr(5, 1n)
    cpu.run(createRetireChunk(1))
    expect(cpu.gpr(3)).toBe(0n)
    // `add` does not touch carry; only `addc` and its relatives do.
    expect(cpu.ca).toBe(false)
  })

  it('sets carry for `addc`, which is what makes the chain a chain', () => {
    const addc = ((31 << 26) | (3 << 21) | (4 << 16) | (5 << 11) | (10 << 1)) >>> 0
    const { cpu } = machine([addc])
    cpu.setGpr(4, 0xffff_ffff_ffff_ffffn)
    cpu.setGpr(5, 1n)
    cpu.run(createRetireChunk(1))
    expect(cpu.gpr(3)).toBe(0n)
    expect(cpu.ca).toBe(true)
    // And the 32-bit carry alongside it, which the reference reports
    // and an implementation that ignored would differ on immediately.
    expect(cpu.ca32).toBe(true)
  })
})

describe('power: images that are not powerpc64le', () => {
  /**
   * A real fixture with one field altered.
   *
   * Building a header by hand does not reach these checks: the shared
   * ELF reader validates the program headers first and refuses an
   * object with no loadable segments before the machine is ever looked
   * at. Patching a real object exercises the path a real mistake would
   * take.
   */
  function patched(change: (elf: Uint8Array) => void): Uint8Array {
    const elf = new Uint8Array(readFileSync(join(POWER_FIXTURE_DIR, 'alu.elf')))
    change(elf)
    return elf
  }

  it('refuses another architecture', () => {
    // e_machine is a halfword at offset 18, little-endian here.
    expect(() => loadPower(patched((elf) => { elf[18] = 243; elf[19] = 0 })))
      .toThrow(/e_machine is 243/)
  })

  it('refuses an object that says it is big-endian', () => {
    // Big-endian PowerPC is a different calling convention entirely --
    // function descriptors rather than a table of contents computed
    // from the entry address -- so accepting it would be claiming
    // something nothing here has tested. The backend checks for it, and
    // this file never reaches that check: changing the byte-order byte
    // alone changes how every other field reads, so the shared ELF
    // reader refuses the header before the machine is examined. Both
    // refusals are correct; what matters is that neither loads.
    expect(() => loadPower(patched((elf) => { elf[5] = 2 }))).toThrow(ElfError)
  })

  it('loads the object it is actually for', () => {
    // The counterfactual: the same file unaltered must load, or the two
    // tests above would pass for the wrong reason.
    expect(() => loadPower(patched(() => {}))).not.toThrow()
  })
})

describe('power: running out of budget', () => {
  it('stops a guest that will not finish', () => {
    //   b .  which is how a program hangs on this architecture.
    const b = ((18 << 26) | 0) >>> 0
    const { cpu } = machine([b], 5000)
    expect(() => {
      let state: RunState = RunState.MORE
      while (state === RunState.MORE) state = cpu.run(createRetireChunk(64))
    }).toThrow(ExecutionBudgetExceeded)
  })
})
