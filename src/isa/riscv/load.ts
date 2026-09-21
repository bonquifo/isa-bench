/**
 * Turns an RV64 ELF into something runnable: an address space, a program
 * image, a Linux process to run inside, and an interpreter at the entry point.
 */
import { ElfError, ElfMachine, imageEnd, loadElf, parseElf, type ElfImage } from '../common/elf.ts'
import { LinuxSyscalls, buildInitialStack, type ProcessLayout } from '../common/linux.ts'
import { GuestMemory, PAGE_SIZE, Prot } from '../common/memory.ts'
import { Rv64Image } from './image.ts'
import { Rv64Interpreter, type Rv64Options } from './exec.ts'

const PF_X = 1

export interface LoadedRv64 {
  elf: ElfImage
  memory: GuestMemory
  image: Rv64Image
  interpreter: Rv64Interpreter
  syscalls: LinuxSyscalls
}

export interface LoadRv64Options extends Rv64Options {
  /** Guest stack, mapped below the stack pointer. */
  stackBytes?: number
  /** Command line the guest sees. Ignored when `initialSp` is supplied. */
  argv?: readonly string[]
  envp?: readonly string[]
}

const DEFAULT_STACK_BYTES = 1024 * 1024
/**
 * Where the stack goes when the caller does not say. Well clear of anything a
 * statically linked image maps, and inside the address range the page table
 * supports.
 */
const DEFAULT_STACK_TOP = 0x0000_7fff_0000_0000n
/** Room between the end of the image and the mapping arena, for the heap. */
const HEAP_BYTES = 64n * 1024n * 1024n

export function loadRv64(bytes: Uint8Array, options: LoadRv64Options = {}): LoadedRv64 {
  const elf = parseElf(bytes)
  if (elf.machine !== ElfMachine.RISCV) {
    throw new ElfError(`not a RISC-V object: e_machine is ${elf.machine}`)
  }
  if (elf.bits !== 64) throw new ElfError('not an ELF64 object: RV32 is not supported')
  const memory = new GuestMemory(elf.littleEndian)
  loadElf(elf, bytes, memory)

  const stackBytes = options.stackBytes ?? DEFAULT_STACK_BYTES
  const stackTop = options.initialSp ?? DEFAULT_STACK_TOP
  // The stack grows down from the top, and a page above it is mapped too so
  // that a reference-seeded pointer sitting mid-page stays addressable.
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
    // No caller-supplied stack pointer means this is a real program start
    // rather than a differential run seeded from a reference, so it gets the
    // argc/argv/envp/auxv block a libc expects to find below sp.
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

  const image = new Rv64Image(memory, elf.entry, codeBytes)
  const interpreter = new Rv64Interpreter(image, memory, {
    instructionBudget: options.instructionBudget,
    initialSp,
    syscalls,
  })
  return { elf, memory, image, interpreter, syscalls }
}
