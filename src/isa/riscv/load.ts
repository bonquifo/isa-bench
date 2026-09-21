/**
 * Turns an RV64 ELF into something runnable: an address space, a program
 * image and an interpreter positioned at the entry point.
 */
import { ElfError, ElfMachine, loadElf, parseElf, type ElfImage } from '../common/elf.ts'
import { GuestMemory, PAGE_SIZE, Prot } from '../common/memory.ts'
import { Rv64Image } from './image.ts'
import { Rv64Interpreter, type Rv64Options } from './exec.ts'

const PF_X = 1

export interface LoadedRv64 {
  elf: ElfImage
  memory: GuestMemory
  image: Rv64Image
  interpreter: Rv64Interpreter
}

export interface LoadRv64Options extends Rv64Options {
  /** Guest stack, mapped below `initialSp`. */
  stackBytes?: number
}

const DEFAULT_STACK_BYTES = 256 * 1024
/**
 * Where the stack goes when the caller does not say. Well clear of anything a
 * statically linked image maps, and inside the address range the page table
 * supports.
 */
const DEFAULT_STACK_TOP = 0x0000_7fff_0000_0000n

export function loadRv64(bytes: Uint8Array, options: LoadRv64Options = {}): LoadedRv64 {
  const elf = parseElf(bytes)
  if (elf.machine !== ElfMachine.RISCV) {
    throw new ElfError(`not a RISC-V object: e_machine is ${elf.machine}`)
  }
  if (elf.bits !== 64) throw new ElfError('not an ELF64 object: RV32 is not supported')
  const memory = new GuestMemory(elf.littleEndian)
  loadElf(elf, bytes, memory)

  const stackBytes = options.stackBytes ?? DEFAULT_STACK_BYTES
  const initialSp = options.initialSp ?? DEFAULT_STACK_TOP
  // The stack grows down from the pointer, and a page above it is mapped too
  // so that a reference-seeded pointer sitting mid-page stays addressable.
  const base = (initialSp - BigInt(stackBytes)) & ~BigInt(PAGE_SIZE - 1)
  memory.map(base, stackBytes + 2 * PAGE_SIZE, Prot.READ | Prot.WRITE)

  let codeBytes = 0
  for (const segment of elf.segments) {
    if ((segment.flags & PF_X) !== 0) codeBytes += segment.filesz
  }

  const image = new Rv64Image(memory, elf.entry, codeBytes)
  const interpreter = new Rv64Interpreter(image, memory, { ...options, initialSp })
  return { elf, memory, image, interpreter }
}
