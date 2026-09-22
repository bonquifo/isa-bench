/**
 * Turns an AArch64 ELF into something runnable. Mirrors the RV64 loader;
 * everything that differs is in the backend and the interpreter.
 */
import { ElfError, ElfMachine, imageEnd, loadElf, parseElf, type ElfImage } from '../common/elf.ts'
import { LinuxSyscalls, buildInitialStack, type ProcessLayout } from '../common/linux.ts'
import { GuestMemory, PAGE_SIZE, Prot } from '../common/memory.ts'
import { A64Image } from './image.ts'
import { A64Interpreter, type A64Options } from './exec.ts'

const PF_X = 1

export interface LoadedA64 {
  elf: ElfImage
  memory: GuestMemory
  image: A64Image
  interpreter: A64Interpreter
  syscalls: LinuxSyscalls
}

export interface LoadA64Options extends A64Options {
  stackBytes?: number
  argv?: readonly string[]
  envp?: readonly string[]
}

const DEFAULT_STACK_BYTES = 1024 * 1024
const DEFAULT_STACK_TOP = 0x0000_7fff_0000_0000n
const HEAP_BYTES = 64n * 1024n * 1024n

export function loadA64(bytes: Uint8Array, options: LoadA64Options = {}): LoadedA64 {
  const elf = parseElf(bytes)
  if (elf.machine !== ElfMachine.AARCH64) {
    throw new ElfError(`not an AArch64 object: e_machine is ${elf.machine}`)
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

  const image = new A64Image(memory, elf.entry, codeBytes)
  const interpreter = new A64Interpreter(image, memory, {
    instructionBudget: options.instructionBudget,
    initialSp,
    syscalls,
  })
  return { elf, memory, image, interpreter, syscalls }
}
