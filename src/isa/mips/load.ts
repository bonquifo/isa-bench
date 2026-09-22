/**
 * Turns a MIPS32 ELF into something runnable.
 *
 * The first 32-bit target, and the place that shows: addresses are four
 * bytes wide, so the stack and the heap live in the low two gigabytes
 * rather than wherever a 64-bit layout would put them, and the shared
 * process-startup code writes a 32-bit auxiliary vector because the ELF
 * says the class is 32.
 */
import { ElfError, ElfMachine, imageEnd, loadElf, parseElf, type ElfImage } from '../common/elf.ts'
import { LinuxSyscalls, buildInitialStack, type ProcessLayout } from '../common/linux.ts'
import { GuestMemory, PAGE_SIZE, Prot } from '../common/memory.ts'
import { MipsInterpreter, type MipsOptions } from './exec.ts'
import { MipsImage } from './image.ts'

const PF_X = 1

export interface LoadedMips {
  elf: ElfImage
  memory: GuestMemory
  image: MipsImage
  interpreter: MipsInterpreter
  syscalls: LinuxSyscalls
}

export interface LoadMipsOptions extends MipsOptions {
  stackBytes?: number
  argv?: readonly string[]
  envp?: readonly string[]
  initialSp?: bigint
}

const DEFAULT_STACK_BYTES = 1024 * 1024
/** Just below the two-gigabyte line, which is where a 32-bit stack goes. */
const DEFAULT_STACK_TOP = 0x7fff_0000n
const HEAP_BYTES = 64n * 1024n * 1024n

export function loadMips(bytes: Uint8Array, options: LoadMipsOptions = {}): LoadedMips {
  const elf = parseElf(bytes)
  if (elf.machine !== ElfMachine.MIPS) {
    throw new ElfError(`not a MIPS object: e_machine is ${elf.machine}`)
  }
  if (elf.bits !== 32) throw new ElfError('not an ELF32 object')
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
    wordBytes: 4,
  }
  const syscalls = new LinuxSyscalls(memory, layout)

  let initialSp = options.initialSp
  if (initialSp === undefined) {
    initialSp = buildInitialStack(memory, layout, {
      entry: elf.entry,
      phdr: elf.phdrAddress,
      phent: elf.phentsize,
      phnum: elf.phnum,
    }, { argv: options.argv, envp: options.envp, wordBytes: 4 })
  }

  let codeBytes = 0
  for (const segment of elf.segments) {
    if ((segment.flags & PF_X) !== 0) codeBytes += segment.filesz
  }

  const image = new MipsImage(memory, elf.entry, codeBytes)
  const interpreter = new MipsInterpreter(image, memory, {
    instructionBudget: options.instructionBudget,
    syscalls,
  })
  // The stack pointer is register 29 rather than one of its own.
  interpreter.setGpr(29, initialSp)
  if (options.initialRegisters) {
    const initial = options.initialRegisters
    for (let r = 0; r < initial.length && r < 34; r++) interpreter.setGpr(r, initial[r]!)
  }
  return { elf, memory, image, interpreter, syscalls }
}
