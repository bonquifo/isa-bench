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
import { X86Interpreter } from './exec.ts'
import { X86Image } from './image.ts'

/**
 * An instruction this interpreter does not implement must stop the run
 * with a message naming it. A silent no-op, or a loose match that ran some
 * neighbouring instruction instead, would leave every number downstream
 * wrong and plausible.
 *
 * The encodings are written out as bytes rather than assembled. On a
 * variable-length architecture that is the only way to state the case
 * exactly: which instruction a byte sequence is depends on the prefixes
 * before it and the ModRM byte after it, and the cases worth testing are
 * the ones a byte away from something implemented.
 */
const BASE = 0x10000n

/** mov rax, imm32 (sign-extended) */
const MOV_RAX = (value: number): number[] => [
  0x48, 0xc7, 0xc0, value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff, (value >> 24) & 0xff,
]
/** mov rdi, imm32 */
const MOV_RDI = (value: number): number[] => [
  0x48, 0xc7, 0xc7, value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff, (value >> 24) & 0xff,
]
const SYSCALL = [0x0f, 0x05]
const UD2 = [0x0f, 0x0b]
const INT3 = [0xcc]
/** jmp . — branches to itself, so the guest never terminates. */
const SELF_LOOP = [0xeb, 0xfe]
/** mov rax, [rax] with rax zero, which is never mapped. */
const LOAD_FROM_ZERO = [0x48, 0x8b, 0x00]

function build(bytes: number[], options: { budget?: number } = {}) {
  const memory = new GuestMemory(true)
  memory.map(BASE, PAGE_SIZE, Prot.READ | Prot.EXEC)
  memory.writeBytesRaw(BASE, Uint8Array.from(bytes))
  const image = new X86Image(memory, BASE, bytes.length)
  const syscalls = new LinuxSyscalls(memory, {
    stackPointer: 0x40000n,
    brkStart: 0x20000n,
    mmapStart: 0x30000n,
  })
  const interpreter = new X86Interpreter(image, memory, {
    instructionBudget: options.budget,
    syscalls,
  })
  // The stack lives below the code, and everything here that touches it
  // needs somewhere real to touch.
  memory.map(0x3f000n, PAGE_SIZE * 2, Prot.READ | Prot.WRITE)
  interpreter.setGpr(4, 0x40000n)
  return { memory, image, interpreter }
}

function runAll(bytes: number[], options: { budget?: number } = {}): void {
  const { interpreter } = build(bytes, options)
  const chunk = createRetireChunk(64)
  for (let i = 0; i < 1000; i++) {
    if (interpreter.run(chunk) !== 'more') return
  }
  throw new Error('program did not finish within the test limit')
}

/** A well-formed exit(0), so a test program can end without faulting. */
const EXIT_OK = [...MOV_RAX(60), ...MOV_RDI(0), ...SYSCALL]

describe('the x86-64 interpreter stops rather than guessing', () => {
  it('runs a well-formed program to completion', () => {
    const { interpreter } = build(EXIT_OK)
    const chunk = createRetireChunk(16)
    expect(interpreter.run(chunk)).toBe('exited')
    expect(interpreter.exitCode).toBe(0)
    expect(interpreter.retired).toBe(3)
  })

  it('stops on ud2 and int3 instead of treating them as nops', () => {
    expect(() => runAll([...UD2, ...EXIT_OK])).toThrow(IsaError)
    expect(() => runAll([...UD2, ...EXIT_OK])).toThrow(/ud2/)
    expect(() => runAll([...INT3, ...EXIT_OK])).toThrow(/int3/)
  })

  it('refuses a syscall it does not emulate, by its x86 number', () => {
    // 999 is not a syscall at all. Returning -ENOSYS would let a libc take
    // a fallback path and produce a plausible wrong answer instead.
    const program = [...MOV_RAX(999), ...SYSCALL, ...EXIT_OK]
    expect(() => runAll(program)).toThrow(UnsupportedSyscall)
    expect(() => runAll(program)).toThrow(/syscall 999/)
  })

  it('refuses an arch_prctl code other than the one it implements', () => {
    // Setting the thread pointer is implemented; reading it back is not,
    // and the difference is one operand.
    const program = [...MOV_RAX(158), ...MOV_RDI(0x1003), ...SYSCALL, ...EXIT_OK]
    expect(() => runAll(program)).toThrow(/arch_prctl code/)
  })

  it('faults on an access outside anything mapped', () => {
    expect(() => runAll([...MOV_RAX(0), ...LOAD_FROM_ZERO, ...EXIT_OK])).toThrow(GuestFault)
  })

  it('faults on a divide by zero rather than producing a number', () => {
    // xor edx, edx; xor ecx, ecx; div rcx
    const program = [
      0x31, 0xd2, 0x31, 0xc9, 0x48, 0xf7, 0xf1, ...EXIT_OK,
    ]
    expect(() => runAll(program)).toThrow(/divide by zero/)
  })

  it('gives up on a guest that never terminates', () => {
    expect(() => runAll(SELF_LOOP, { budget: 500 })).toThrow(ExecutionBudgetExceeded)
  })
})

/**
 * The implemented set is what the corpus and a real libc execute, measured
 * rather than guessed. That is only safe if the boundary is sharp, so each
 * case below is a byte or a prefix away from something that works.
 */
describe('the implemented instruction set has a sharp edge', () => {
  const refused: [string, number[]][] = [
    ['pushfq, whose value holds bits no interpreter should model', [0x9c]],
    ['popfq', [0x9d]],
    ['sahf, the other half of the flag transfer', [0x9e]],
    ['into a segment register', [0x8e, 0xc0]],
    ['cpuid', [0x0f, 0xa2]],
    ['rdtsc', [0x0f, 0x31]],
    ['xgetbv', [0x0f, 0x01, 0xd0]],
    ['the 32-bit address-size prefix', [0x67, 0x8b, 0x00]],
    ['a gs-relative access', [0x65, 0x48, 0x8b, 0x04, 0x25, 0, 0, 0, 0]],
    ['pmaddwd, one opcode from an implemented multiply', [0x66, 0x0f, 0xf5, 0xc1]],
    ['psllq, which has no implemented shift beside it', [0x66, 0x0f, 0xf3, 0xc1]],
    ['addps, the packed form of an implemented scalar add', [0x0f, 0x58, 0xc1]],
    ['fsqrt, an x87 operation outside the subset', [0xd9, 0xfa]],
    ['fpatan', [0xd9, 0xf3]],
    ['fnstsw, which reports a status word this does not keep', [0xdf, 0xe0]],
  ]

  for (const [name, bytes] of refused) {
    it(`refuses ${name}`, () => {
      expect(() => decode((i) => bytes[i] ?? 0, BASE)).toThrow(UnimplementedInstruction)
    })
  }

  it('still decodes the forms it does implement', () => {
    // The same guards from the other side: if one of these stopped
    // decoding, the list above would be passing for the wrong reason.
    const implemented: [string, number[]][] = [
      ['add rax, rcx', [0x48, 0x01, 0xc8]],
      ['movzx eax, byte [rcx]', [0x0f, 0xb6, 0x01]],
      ['imul rax, rcx, 7', [0x48, 0x6b, 0xc1, 0x07]],
      ['shld rax, rcx, 9', [0x48, 0x0f, 0xa4, 0xc8, 0x09]],
      ['bt rax, 4', [0x48, 0x0f, 0xba, 0xe0, 0x04]],
      ['tzcnt eax, ecx', [0xf3, 0x0f, 0xbc, 0xc1]],
      ['lock cmpxchg [rdx], ecx', [0xf0, 0x0f, 0xb1, 0x0a]],
      ['rep movsq', [0xf3, 0x48, 0xa5]],
      ['lahf', [0x9f]],
      ['movd xmm0, ecx', [0x66, 0x0f, 0x6e, 0xc1]],
      ['pshufd xmm0, xmm1, 0x1b', [0x66, 0x0f, 0x70, 0xc1, 0x1b]],
      ['movlhps xmm0, xmm1', [0x0f, 0x16, 0xc1]],
      ['fld qword [rax]', [0xdd, 0x00]],
      ['fdivrp st(1), st', [0xde, 0xf1]],
      ['fldcw [rax]', [0xd9, 0x28]],
      ['fucomip st, st(1)', [0xdf, 0xe9]],
      ['mov rax, fs:[0x10]', [0x64, 0x48, 0x8b, 0x04, 0x25, 0x10, 0, 0, 0]],
    ]
    for (const [name, bytes] of implemented) {
      expect(() => decode((i) => bytes[i] ?? 0, BASE), name).not.toThrow()
    }
  })
})
