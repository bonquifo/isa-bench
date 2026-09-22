/**
 * Turns a powerpc64le ELF into something runnable.
 *
 * Mostly the shared path. Two things are particular to this ABI and
 * both are about a register the kernel has to have already set.
 *
 * **r12 holds the entry point.** The ELFv2 calling convention has no
 * function-descriptor table; instead every global entry point computes
 * its own table-of-contents pointer from its own address, which it
 * expects to find in r12. The first two instructions of `_start` are
 * exactly that computation, so a process started with r12 at zero
 * builds a TOC pointer of zero and every access to a global goes to the
 * bottom of memory.
 *
 * **r1 is the stack pointer, and it points at a back-chain word.** The
 * ABI requires the word at the stack pointer to be the previous frame's
 * pointer, with zero terminating the chain. A libc that walks it on
 * startup follows whatever happens to be there otherwise.
 */
import { ElfError, ElfMachine, imageEnd, loadElf, parseElf, type ElfImage } from '../common/elf.ts'
import { LinuxSyscalls, buildInitialStack, type ProcessLayout } from '../common/linux.ts'
import { GuestMemory, PAGE_SIZE, Prot } from '../common/memory.ts'
import { PowerInterpreter, type PowerOptions } from './exec.ts'
import { PowerImage } from './image.ts'

const PF_X = 1

export interface LoadedPower {
  elf: ElfImage
  memory: GuestMemory
  image: PowerImage
  interpreter: PowerInterpreter
  syscalls: LinuxSyscalls
}

export interface LoadPowerOptions extends PowerOptions {
  stackBytes?: number
  argv?: readonly string[]
  envp?: readonly string[]
  initialSp?: bigint
  initialRegisters?: readonly bigint[]
}

const DEFAULT_STACK_BYTES = 1024 * 1024
/** Where qemu-user puts a 64-bit PowerPC stack. */
const DEFAULT_STACK_TOP = 0x4000_0000_0000n
const HEAP_BYTES = 64n * 1024n * 1024n

export function loadPower(bytes: Uint8Array, options: LoadPowerOptions = {}): LoadedPower {
  const elf = parseElf(bytes)
  if (elf.machine !== ElfMachine.PPC64) {
    throw new ElfError(`not a PowerPC64 object: e_machine is ${elf.machine}`)
  }
  if (elf.bits !== 64) throw new ElfError('not an ELF64 object')
  if (!elf.littleEndian) {
    // Big-endian PowerPC is a different ABI with function descriptors
    // rather than a computed TOC, so accepting it here would be
    // claiming something untested.
    throw new ElfError('big-endian PowerPC is not supported; this backend is powerpc64le')
  }

  const memory = new GuestMemory(true)
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
    wordBytes: 8,
  }
  const syscalls = new LinuxSyscalls(memory, layout)

  let initialSp = options.initialSp
  if (initialSp === undefined) {
    initialSp = buildInitialStack(memory, layout, {
      entry: elf.entry,
      phdr: elf.phdrAddress,
      phent: elf.phentsize,
      phnum: elf.phnum,
    }, { argv: options.argv, envp: options.envp, wordBytes: 8 })
  }

  let codeBytes = 0
  for (const segment of elf.segments) {
    if ((segment.flags & PF_X) !== 0) codeBytes += segment.filesz
  }

  const image = new PowerImage(memory, elf.entry, codeBytes)
  const interpreter = new PowerInterpreter(image, memory, {
    ...(options.instructionBudget !== undefined
      ? { instructionBudget: options.instructionBudget }
      : {}),
    linux: syscalls,
  })
  interpreter.setGpr(1, initialSp)
  // The back chain terminates here, and the ABI says so rather than
  // leaving it to whatever the stack page happened to contain.
  memory.store(initialSp, 8, 0n)
  // And the entry point, which every global entry point needs in order
  // to find its own table of contents.
  interpreter.setGpr(12, elf.entry)

  if (options.initialRegisters) {
    const initial = options.initialRegisters
    for (let r = 0; r < initial.length && r < 36; r++) interpreter.setGpr(r, initial[r]!)
  }
  return { elf, memory, image, interpreter, syscalls }
}
