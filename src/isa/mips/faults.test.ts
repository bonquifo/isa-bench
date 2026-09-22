import { describe, expect, it } from 'vitest'
import {
  ExecutionBudgetExceeded,
  GuestFault,
  IsaError,
  UnimplementedInstruction,
  UnsupportedSyscall,
} from '../common/errors.ts'
import { LinuxSyscalls } from '../common/linux.ts'
import { GuestMemory, PAGE_SIZE, Prot } from '../common/memory.ts'
import { createRetireChunk } from '../common/trace.ts'
import { decode } from './decode.ts'
import { MipsInterpreter } from './exec.ts'
import { MipsImage } from './image.ts'

/**
 * An instruction this interpreter does not implement must stop the run
 * with a message naming it. A silent no-op would leave every number
 * downstream wrong and plausible.
 *
 * The delay slot gets a section of its own at the end, because it is the
 * one thing here that an implementation can get wrong while still
 * producing the right answer for most programs.
 */
const BASE = 0x10000n

const encodeI = (opcode: number, rs: number, rt: number, imm: number): number =>
  (((opcode & 0x3f) << 26) | ((rs & 31) << 21) | ((rt & 31) << 16) | (imm & 0xffff)) >>> 0
const encodeR = (rs: number, rt: number, rd: number, sa: number, funct: number): number =>
  (((rs & 31) << 21) | ((rt & 31) << 16) | ((rd & 31) << 11) |
   ((sa & 31) << 6) | (funct & 0x3f)) >>> 0

/** addiu rt, rs, imm */
const ADDIU = (rt: number, rs: number, imm: number) => encodeI(9, rs, rt, imm)
const SYSCALL = encodeR(0, 0, 0, 0, 0x0c)
const BREAK = encodeR(0, 0, 0, 0, 0x0d)
const NOP = 0
/** b . — a branch to itself, which never terminates. */
const SELF_LOOP = encodeI(4, 0, 0, 0xffff)
/** lw v0, 0(v0) with v0 zero, which is never mapped. */
const LOAD_FROM_ZERO = encodeI(0x23, 2, 2, 0)
/** add, the trapping form the compiler never emits. */
const TRAPPING_ADD = encodeR(2, 3, 4, 0, 0x20)
/** teq v0, v0 — always true, so always a trap. */
const TEQ = encodeR(2, 2, 0, 0, 0x34)

function build(words: number[], options: { budget?: number } = {}) {
  const memory = new GuestMemory(true)
  memory.map(BASE, PAGE_SIZE, Prot.READ | Prot.EXEC)
  const bytes = new Uint8Array(words.length * 4)
  const view = new DataView(bytes.buffer)
  words.forEach((word, i) => view.setUint32(i * 4, word >>> 0, true))
  memory.writeBytesRaw(BASE, bytes)
  const image = new MipsImage(memory, BASE, bytes.length)
  const syscalls = new LinuxSyscalls(memory, {
    stackPointer: 0x40000n,
    brkStart: 0x20000n,
    mmapStart: 0x30000n,
    wordBytes: 4,
  })
  const interpreter = new MipsInterpreter(image, memory, {
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

/** A well-formed exit(0). The syscall number is 4001 in this ABI. */
const EXIT_OK = [ADDIU(2, 0, 4001), ADDIU(4, 0, 0), SYSCALL]

describe('the MIPS interpreter stops rather than guessing', () => {
  it('runs a well-formed program to completion', () => {
    const { interpreter } = build(EXIT_OK)
    const chunk = createRetireChunk(16)
    expect(interpreter.run(chunk)).toBe('exited')
    expect(interpreter.exitCode).toBe(0)
    expect(interpreter.retired).toBe(3)
  })

  it('refuses the trapping arithmetic a compiler never emits', () => {
    // add and addu differ only in whether overflow traps, so a decoder
    // that matched loosely would run one as the other and silently lose
    // the trap.
    expect(() => runAll([TRAPPING_ADD, ...EXIT_OK])).toThrow(UnimplementedInstruction)
    expect(() => runAll([TRAPPING_ADD, ...EXIT_OK])).toThrow(/traps on overflow/)
  })

  it('takes a conditional trap rather than ignoring it', () => {
    // A compiler puts one of these in front of a divide, because
    // dividing by zero here is unpredictable rather than a fault.
    expect(() => runAll([TEQ, ...EXIT_OK])).toThrow(IsaError)
    expect(() => runAll([TEQ, ...EXIT_OK])).toThrow(/trap/)
  })

  it('stops on break instead of treating it as a nop', () => {
    expect(() => runAll([BREAK, ...EXIT_OK])).toThrow(/break/)
  })

  it('refuses a syscall it does not emulate, by its o32 number', () => {
    const program = [ADDIU(2, 0, 4999), SYSCALL, ...EXIT_OK]
    expect(() => runAll(program)).toThrow(UnsupportedSyscall)
    expect(() => runAll(program)).toThrow(/syscall 4999/)
  })

  it('faults on an access outside anything mapped', () => {
    expect(() => runAll([LOAD_FROM_ZERO, ...EXIT_OK])).toThrow(GuestFault)
  })

  it('faults on a misaligned word rather than splitting it', () => {
    // This architecture has instructions for unaligned access precisely
    // because the ordinary ones do not do it.
    const program = [ADDIU(2, 0, 3), encodeI(0x23, 2, 3, 0), ...EXIT_OK]
    expect(() => runAll(program)).toThrow(/misaligned/)
  })

  it('gives up on a guest that never terminates', () => {
    expect(() => runAll([SELF_LOOP, NOP], { budget: 500 }))
      .toThrow(ExecutionBudgetExceeded)
  })

  it('refuses an instruction outside what it implements, by name', () => {
    // Coprocessor 2 is a place an implementation may put anything, so
    // there is nothing to fall back on.
    expect(() => decode(encodeI(0x12, 0, 0, 0), BASE)).toThrow(UnimplementedInstruction)
    expect(() => decode(encodeI(0x12, 0, 0, 0), BASE)).toThrow(/coprocessor 2/)
  })
})

describe('the delay slot', () => {
  /**
   * A branch that is taken, with an instruction after it that must run
   * anyway. Getting this wrong is the one mistake on this architecture
   * that still produces a plausible answer most of the time.
   */
  it('runs the instruction after a taken branch before the branch takes effect', () => {
    const { interpreter } = build([
      encodeI(4, 0, 0, 2),     // beq zero, zero, +2 instructions
      ADDIU(3, 0, 7),          // delay slot: v1 = 7, and it runs
      ADDIU(4, 0, 9),          // skipped
      ADDIU(5, 0, 11),         // landed on
      ...EXIT_OK,
    ])
    const chunk = createRetireChunk(64)
    while (interpreter.run(chunk) === 'more') { /* to completion */ }
    // The slot ran even though the branch was taken.
    expect(interpreter.gpr(3)).toBe(7n)
    // The instruction after the slot did not.
    expect(interpreter.gpr(4)).toBe(0n)
    expect(interpreter.gpr(5)).toBe(11n)
  })

  it('reports the branch and its slot as separate retired instructions', () => {
    // The timing model reads the trace rather than the encoding, so the
    // order and the successors in it are the whole interface.
    const { interpreter } = build([
      encodeI(4, 0, 0, 1),     // beq zero, zero, +1
      ADDIU(3, 0, 7),          // delay slot
      ...EXIT_OK,
    ])
    const chunk = createRetireChunk(4)
    interpreter.run(chunk)
    expect(chunk.pc[0]).toBe(BASE)
    // The branch's successor is the slot, not the target.
    expect(chunk.nextPc[0]).toBe(BASE + 4n)
    expect(chunk.pc[1]).toBe(BASE + 4n)
    // The slot's successor is where the branch went.
    expect(chunk.nextPc[1]).toBe(BASE + 8n)
  })

  it('refuses a branch inside a delay slot rather than inventing a meaning', () => {
    const program = [
      encodeI(4, 0, 0, 1),
      encodeI(4, 0, 0, 1),     // a branch in the slot, which is undefined
      ...EXIT_OK,
    ]
    expect(() => runAll(program)).toThrow(/delay slot/)
  })

  it('links before the slot runs, so the slot sees the new return address', () => {
    // jal to the instruction after the slot, whose delay slot copies the
    // return address the jal has already written.
    const jal = ((3 << 26) | (Number(BASE + 8n) >>> 2)) >>> 0
    const { interpreter } = build([
      jal,
      encodeR(31, 0, 3, 0, 0x21), // delay slot: addu v1, ra, zero
      ...EXIT_OK,
    ])
    const chunk = createRetireChunk(64)
    while (interpreter.run(chunk) === 'more') { /* to completion */ }
    expect(interpreter.gpr(31)).toBe(BASE + 8n)
    // The slot saw the new value rather than the old one.
    expect(interpreter.gpr(3)).toBe(BASE + 8n)
  })
})
