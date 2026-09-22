import { describe, expect, it } from 'vitest'
import {
  ExecutionBudgetExceeded,
  GuestFault,
  IllegalInstruction,
  IsaError,
  UnimplementedInstruction,
  UnsupportedSyscall,
} from '../common/errors.ts'
import { LinuxSyscalls } from '../common/linux.ts'
import { GuestMemory, PAGE_SIZE, Prot } from '../common/memory.ts'
import { createRetireChunk } from '../common/trace.ts'
import { decode } from './decode.ts'
import { A64Interpreter } from './exec.ts'
import { A64Image } from './image.ts'

/**
 * An instruction this interpreter does not implement must stop the run with
 * a message naming it. A silent no-op, or a loose match that ran some
 * neighbouring instruction instead, would leave every number downstream
 * wrong and plausible.
 *
 * The encodings below are written out as words rather than assembled,
 * because the cases worth testing are the ones next to something that *is*
 * implemented, and those are easier to state exactly than to coax a compiler
 * into emitting.
 */
const BASE = 0x10000n

/** movz x<rd>, #imm16 */
const MOVZ = (rd: number, imm: number): number =>
  (0xd2800000 | ((imm & 0xffff) << 5) | rd) >>> 0
const SVC0 = 0xd4000001
/** brk #0 */
const BRK0 = 0xd4200000
/** b . — branches to itself, so the guest never terminates. */
const SELF_LOOP = 0x14000000
/** ldr x0, [x0] */
const LDR_X0_X0 = 0xf9400000
/** mrs x0, midr_el1 — a system register outside the handful implemented. */
const MRS_MIDR = 0xd5380000
/** dc civac, x0 — a cache operation that is not the one implemented. */
const DC_CIVAC = 0xd50b7e20

function build(words: number[], options: { budget?: number } = {}) {
  const memory = new GuestMemory(true)
  memory.map(BASE, PAGE_SIZE, Prot.READ | Prot.EXEC)
  const bytes = new Uint8Array(words.length * 4)
  const view = new DataView(bytes.buffer)
  words.forEach((word, i) => view.setUint32(i * 4, word >>> 0, true))
  memory.writeBytesRaw(BASE, bytes)
  const image = new A64Image(memory, BASE, bytes.length)
  const syscalls = new LinuxSyscalls(memory, {
    stackPointer: 0x40000n,
    brkStart: 0x20000n,
    mmapStart: 0x30000n,
  })
  const interpreter = new A64Interpreter(image, memory, {
    instructionBudget: options.budget,
    syscalls,
  })
  return { memory, image, interpreter }
}

function runAll(words: number[], options: { budget?: number } = {}): void {
  const { interpreter } = build(words, options)
  const chunk = createRetireChunk(64)
  for (let i = 0; i < 1000; i++) {
    if (interpreter.run(chunk) !== 'more') return
  }
  throw new Error('program did not finish within the test limit')
}

/** A well-formed exit(0), so a test program can end without faulting. */
const EXIT_OK = [MOVZ(8, 93), MOVZ(0, 0), SVC0]

describe('the AArch64 interpreter stops rather than guessing', () => {
  it('runs a well-formed program to completion', () => {
    const { interpreter } = build(EXIT_OK)
    const chunk = createRetireChunk(16)
    expect(interpreter.run(chunk)).toBe('exited')
    expect(interpreter.exitCode).toBe(0)
    expect(interpreter.retired).toBe(3)
  })

  it('refuses a system register it does not model, naming the encoding', () => {
    expect(() => runAll([MRS_MIDR, ...EXIT_OK])).toThrow(UnimplementedInstruction)
    expect(() => runAll([MRS_MIDR, ...EXIT_OK])).toThrow(/system register/)
  })

  it('refuses a cache operation next to the one it implements', () => {
    // `dc zva` is implemented and `dc civac` is one field away from it, so a
    // decoder that matched the group rather than the operation would run a
    // clean-and-invalidate as a 512-byte zeroing.
    expect(() => runAll([DC_CIVAC, ...EXIT_OK])).toThrow(UnimplementedInstruction)
    expect(() => runAll([DC_CIVAC, ...EXIT_OK])).toThrow(/system instruction/)
  })

  it('stops on brk instead of treating it as a nop', () => {
    expect(() => runAll([BRK0, ...EXIT_OK])).toThrow(IsaError)
    expect(() => runAll([BRK0, ...EXIT_OK])).toThrow(/brk/)
  })

  it('refuses a syscall it does not emulate', () => {
    expect(() => runAll([MOVZ(8, 1000), SVC0, ...EXIT_OK])).toThrow(UnsupportedSyscall)
    expect(() => runAll([MOVZ(8, 1000), SVC0, ...EXIT_OK])).toThrow(/syscall 1000/)
  })

  it('faults on an access outside anything mapped', () => {
    expect(() => runAll([LDR_X0_X0, ...EXIT_OK])).toThrow(GuestFault)
  })

  it('gives up on a guest that never terminates', () => {
    expect(() => runAll([SELF_LOOP], { budget: 500 })).toThrow(ExecutionBudgetExceeded)
    expect(() => runAll([SELF_LOOP], { budget: 500 })).toThrow(/budget/)
  })

  it('refuses to execute bytes that are not instructions', () => {
    expect(() => runAll([0x00000000, ...EXIT_OK])).toThrow(IllegalInstruction)
  })
})

/**
 * Advanced SIMD is implemented as a subset: the forms the corpus and a real
 * libc actually reach, and nothing else. That is only safe if the boundary
 * is sharp, so each case below is an instruction sitting immediately beside
 * an implemented one in the encoding space.
 */
describe('the implemented SIMD subset has a sharp edge', () => {
  const neighbours: [string, number][] = [
    ['ld1 {v0.16b}, [x0] — the multi-structure load', 0x4c407000],
    ['st1 {v0.s}[1], [x0] — the single-lane store', 0x0d009000],
    ['ld1r {v0.4s}, [x0] — load and replicate', 0x4d40c800],
    ['sub v0.4s, v1.4s, v2.4s — beside the implemented add', 0x6ea28420],
    ['fadd v0.4s, v1.4s, v2.4s — vector floating point', 0x4e22d420],
    ['cmeq v0.4s, v1.4s, v2.4s — a vector compare', 0x6ea28c20],
    ['sqadd v0.4s, v1.4s, v2.4s — the saturating add', 0x4ea20c20],
    ['smax v0.4s, v1.4s, v2.4s', 0x4ea26420],
    ['uaddl v0.2d, v1.2s, v2.2s — beside the implemented saddl', 0x2ea20020],
    ['ins v0.s[1], v1.s[0] — insert from an element, not a register', 0x6e0c0420],
    ['tbl v0.16b, {v1.16b}, v2.16b', 0x4e020020],
    ['fmov v0.2d, #1.0 — the floating-point modified immediate', 0x6f01f400],
  ]

  for (const [name, word] of neighbours) {
    it(`refuses ${name}`, () => {
      expect(() => decode(word, BASE)).toThrow(UnimplementedInstruction)
    })
  }

  it('still decodes the forms it does implement', () => {
    // The same guards, exercised from the other side: if one of these ever
    // stops decoding, the list above is passing for the wrong reason.
    const implemented = [
      0x4e010c20, // dup v0.16b, w1
      0x4e0c1d20, // mov v0.s[1], w9
      0x4e083c01, // umov x1, v0.d[0]
      0x5e180401, // mov d1, v0.d[1]
      0x4ea19c00, // mul v0.4s, v0.4s, v1.4s
      0x0fa08000, // mul v0.2s, v0.2s, v0.s[1]
      0x4ea50065, // saddl2 v5.2d, v3.4s, v5.4s
      0x0ea71000, // saddw v0.2d, v0.2d, v7.2s
      0x6ea14400, // ushl v0.4s, v0.4s, v1.4s
      0x0e612800, // xtn v0.4h, v0.4s
      0x0e001800, // uzp1 v0.8b, v0.8b, v0.8b
      0x4eb1b800, // addv s0, v0.4s
      0x5ef1b800, // addp d0, v0.2d
      0x0d4091e0, // ld1 { v0.s }[1], [x15]
      0x0ddf9201, // ld1 { v1.s }[1], [x16], #4
      0x4f030481, // movi v1.4s, #0x34, lsl #24
      0xd53b00e5, // mrs x5, dczid_el0
      0xd50b7423, // dc zva, x3
    ]
    for (const word of implemented) {
      expect(() => decode(word, BASE)).not.toThrow()
    }
  })
})
