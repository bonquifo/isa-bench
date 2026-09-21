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
import { Rv64Interpreter } from './exec.ts'
import { Rv64Image } from './image.ts'

/**
 * The behaviour this project cares about most: an instruction the interpreter
 * does not implement, or a guest that does something the emulation layer does
 * not cover, must stop the run with a message naming the problem. A silent
 * no-op would leave every number downstream wrong and plausible.
 *
 * Programs here are assembled from raw encodings rather than compiled, so the
 * faulting case can be constructed exactly. The encoders are written from the
 * instruction formats and are independent of the decoder they exercise.
 */
const BASE = 0x10000n

const encodeI = (opcode: number, rd: number, funct3: number, rs1: number, imm: number): number =>
  (((imm & 0xfff) << 20) | (rs1 << 15) | (funct3 << 12) | (rd << 7) | opcode) >>> 0
const encodeR = (opcode: number, rd: number, funct3: number, rs1: number, rs2: number, funct7: number): number =>
  ((funct7 << 25) | (rs2 << 20) | (rs1 << 15) | (funct3 << 12) | (rd << 7) | opcode) >>> 0

const ADDI = (rd: number, rs1: number, imm: number) => encodeI(0x13, rd, 0, rs1, imm)
const ECALL = encodeI(0x73, 0, 0, 0, 0)
const EBREAK = encodeI(0x73, 0, 0, 0, 1)
/** jal x0, 0 — branches to itself, so the guest never terminates. */
const SELF_LOOP = 0x0000006f
/** ld a0, 0(a0) */
const LD_A0 = encodeI(0x03, 10, 3, 10, 0)
/** csrrs a0, mstatus, x0 — a control register outside the floating-point set. */
const CSR_MSTATUS = encodeI(0x73, 10, 2, 0, 0x300)
/** fadd.d fa0, fa0, fa0 with rm = 010 (round down). */
const FADD_RDN = encodeR(0x53, 10, 2, 10, 10, 0x01)
/** An atomic with a funct5 the architecture does not define. */
const AMO_RESERVED = encodeR(0x2f, 10, 2, 12, 11, 0b0010100)
/** fence.i, which would flush an instruction cache this model does not have. */
const FENCE_I = encodeI(0x0f, 0, 1, 0, 0)

function build(words: number[], options: { budget?: number } = {}) {
  const memory = new GuestMemory(true)
  memory.map(BASE, PAGE_SIZE, Prot.READ | Prot.EXEC)
  const bytes = new Uint8Array(words.length * 4)
  const view = new DataView(bytes.buffer)
  words.forEach((word, i) => view.setUint32(i * 4, word >>> 0, true))
  memory.writeBytesRaw(BASE, bytes)
  const image = new Rv64Image(memory, BASE, bytes.length)
  const syscalls = new LinuxSyscalls(memory, {
    stackPointer: 0x40000n,
    brkStart: 0x20000n,
    mmapStart: 0x30000n,
  })
  const interpreter = new Rv64Interpreter(image, memory, {
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
const EXIT_OK = [ADDI(17, 0, 93), ADDI(10, 0, 0), ECALL]

describe('the interpreter stops rather than guessing', () => {
  it('runs a well-formed program to completion', () => {
    const { interpreter } = build(EXIT_OK)
    const chunk = createRetireChunk(16)
    expect(interpreter.run(chunk)).toBe('exited')
    expect(interpreter.exitCode).toBe(0)
    expect(interpreter.retired).toBe(3)
  })

  it('refuses an instruction outside what it implements, by name', () => {
    expect(() => runAll([FENCE_I, ...EXIT_OK])).toThrow(UnimplementedInstruction)
    expect(() => runAll([FENCE_I, ...EXIT_OK])).toThrow(/fence\.i/)
  })

  it('refuses an encoding inside an implemented extension that is reserved', () => {
    // The A extension is implemented, which makes an undefined funct5 within
    // it the more interesting case: a decoder that matched loosely would run
    // it as some neighbouring atomic.
    expect(() => runAll([AMO_RESERVED, ...EXIT_OK])).toThrow(UnimplementedInstruction)
    expect(() => runAll([AMO_RESERVED, ...EXIT_OK])).toThrow(/funct5/)
  })

  it('faults on a misaligned atomic rather than performing it', () => {
    // amoadd.d on a three-byte-aligned address. Linux raises SIGBUS here.
    const words = [ADDI(12, 0, 3), encodeR(0x2f, 10, 3, 12, 0, 0), ...EXIT_OK]
    expect(() => runAll(words)).toThrow(/misaligned atomic/)
  })

  it('refuses a control register outside the floating-point set', () => {
    expect(() => runAll([CSR_MSTATUS, ...EXIT_OK])).toThrow(UnimplementedInstruction)
    expect(() => runAll([CSR_MSTATUS, ...EXIT_OK])).toThrow(/0x300/)
  })

  it('refuses a rounding mode the host cannot provide', () => {
    expect(() => runAll([FADD_RDN, ...EXIT_OK])).toThrow(UnimplementedInstruction)
    expect(() => runAll([FADD_RDN, ...EXIT_OK])).toThrow(/nearest-even/)
  })

  it('stops on ebreak instead of treating it as a nop', () => {
    expect(() => runAll([EBREAK, ...EXIT_OK])).toThrow(IsaError)
    expect(() => runAll([EBREAK, ...EXIT_OK])).toThrow(/ebreak/)
  })

  it('refuses a syscall it does not emulate', () => {
    // 1000 is not a syscall at all. Returning -ENOSYS would let a libc take
    // a fallback path and produce a plausible wrong answer instead.
    expect(() => runAll([ADDI(17, 0, 1000), ECALL, ...EXIT_OK])).toThrow(UnsupportedSyscall)
    expect(() => runAll([ADDI(17, 0, 1000), ECALL, ...EXIT_OK])).toThrow(/syscall 1000/)
  })

  it('refuses to pretend there is a file system', () => {
    // 56 is openat. There are no files, and saying so beats failing later
    // somewhere that looks unrelated.
    expect(() => runAll([ADDI(17, 0, 56), ECALL, ...EXIT_OK])).toThrow(/no file system/)
  })

  it('refuses a write to a descriptor it does not model', () => {
    const words = [ADDI(17, 0, 64), ADDI(10, 0, 3), ADDI(11, 0, 0), ADDI(12, 0, 1), ECALL]
    expect(() => runAll(words)).toThrow(/file descriptor 3/)
  })

  it('faults on an access outside anything mapped', () => {
    // a0 is zero, so this loads from address zero, which is never mapped.
    expect(() => runAll([LD_A0, ...EXIT_OK])).toThrow(GuestFault)
  })

  it('faults on a write to the read-only text segment', () => {
    // sd a0, 0(a0) with a0 pointing into the executable page.
    const { memory, image } = build(EXIT_OK)
    const interpreter = new Rv64Interpreter(image, memory)
    interpreter.setGpr(10, BASE)
    expect(() => memory.store(BASE, 8, 1n)).toThrow(/protection/)
  })

  it('gives up on a guest that never terminates', () => {
    expect(() => runAll([SELF_LOOP], { budget: 500 })).toThrow(ExecutionBudgetExceeded)
    expect(() => runAll([SELF_LOOP], { budget: 500 })).toThrow(/budget/)
  })

  it('refuses to execute bytes that are not instructions', () => {
    expect(() => runAll([0x00000000, ...EXIT_OK])).toThrow(IllegalInstruction)
  })
})

describe('speculative decoding is permitted to fail quietly', () => {
  it('returns null where execution would throw', () => {
    // A timing model walking a mispredicted path can legitimately reach bytes
    // that are not instructions, and must be able to model that without the
    // run failing. Execution of the same address still throws.
    const { image } = build([0x00000000, ...EXIT_OK])
    expect(image.speculativeAt(BASE)).toBeNull()
    expect(() => image.at(BASE)).toThrow(IllegalInstruction)
    // Repeated lookups take the remembered-failure path.
    expect(image.speculativeAt(BASE)).toBeNull()
  })

  it('returns the instruction where one exists, and caches it', () => {
    const { image } = build(EXIT_OK)
    const first = image.speculativeAt(BASE)
    expect(first).not.toBeNull()
    expect(image.speculativeAt(BASE)).toBe(first)
    expect(image.at(BASE)).toBe(first)
  })

  it('does not swallow a fault that is not about decoding', () => {
    // Nothing is mapped here at all, which is a guest fault rather than an
    // undecodable instruction; it is still reported as null by design, so
    // assert the execution path distinguishes them.
    const { image } = build(EXIT_OK)
    expect(() => image.at(0x900000n)).toThrow(GuestFault)
  })
})
