/**
 * Turns an x86-64 ELF into something runnable.
 *
 * The one difference from the other loaders is where the stack pointer
 * starts. Every target's initial stack is synthetic, but here the reference
 * is a real Linux process with address-space randomisation turned off,
 * which puts the stack at a specific and reproducible address. Starting in
 * the same place keeps the two sides comparable for longer, and costs
 * nothing.
 */
import { ElfError, ElfMachine, imageEnd, loadElf, parseElf, type ElfImage } from '../common/elf.ts'
import { LinuxSyscalls, buildInitialStack, type ProcessLayout } from '../common/linux.ts'
import { GuestMemory, PAGE_SIZE, Prot } from '../common/memory.ts'
import { X86Interpreter, type X86Options } from './exec.ts'
import { X86Image } from './image.ts'

const PF_X = 1

export interface LoadedX86 {
  elf: ElfImage
  memory: GuestMemory
  image: X86Image
  interpreter: X86Interpreter
  syscalls: LinuxSyscalls
}

export interface LoadX86Options extends X86Options {
  stackBytes?: number
  argv?: readonly string[]
  envp?: readonly string[]
  /** Where the stack starts, when a reference run has already fixed it. */
  initialSp?: bigint
}

const DEFAULT_STACK_BYTES = 1024 * 1024
/** Where Linux puts a 64-bit stack with randomisation disabled. */
const DEFAULT_STACK_TOP = 0x0000_7fff_ffff_f000n
const HEAP_BYTES = 64n * 1024n * 1024n

export function loadX86(bytes: Uint8Array, options: LoadX86Options = {}): LoadedX86 {
  const elf = parseElf(bytes)
  if (elf.machine !== ElfMachine.X86_64) {
    throw new ElfError(`not an x86-64 object: e_machine is ${elf.machine}`)
  }
  if (elf.bits !== 64) throw new ElfError('not an ELF64 object')
  const memory = new GuestMemory(elf.littleEndian)
  loadElf(elf, bytes, memory)

  const stackBytes = options.stackBytes ?? DEFAULT_STACK_BYTES
  const stackTop = options.initialSp ?? DEFAULT_STACK_TOP
  const base = (stackTop - BigInt(stackBytes)) & ~BigInt(PAGE_SIZE - 1)
  memory.map(base, stackBytes + 2 * PAGE_SIZE, Prot.READ | Prot.WRITE)

  const heapStart = (imageEnd(elf) + BigInt(PAGE_SIZE - 1)) & ~BigInt(PAGE_SIZE - 1)
  const layout: ProcessLayout = {
    stackPointer: stackTop,
    brkStart: heapStart,
    mmapStart: heapStart + HEAP_BYTES,
  }
  const syscalls = new LinuxSyscalls(memory, layout)

  let initialSp = options.initialSp
  if (initialSp === undefined) {
    initialSp = buildInitialStack(memory, layout, {
      entry: elf.entry,
      phdr: elf.phdrAddress,
      phent: elf.phentsize,
      phnum: elf.phnum,
    }, { argv: options.argv, envp: options.envp })
  }

  let codeBytes = 0
  for (const segment of elf.segments) {
    if ((segment.flags & PF_X) !== 0) codeBytes += segment.filesz
  }

  const image = new X86Image(memory, elf.entry, codeBytes)
  const interpreter = new X86Interpreter(image, memory, {
    instructionBudget: options.instructionBudget,
    syscalls,
  })
  // The stack pointer is register 4 rather than a register of its own.
  interpreter.setGpr(4, initialSp)
  if (options.initialRegisters) {
    const initial = options.initialRegisters
    for (let r = 0; r < initial.length && r < 17; r++) interpreter.setGpr(r, initial[r]!)
  }
  return { elf, memory, image, interpreter, syscalls }
}
