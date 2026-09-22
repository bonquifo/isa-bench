/**
 * Turns a SPARC V8 ELF into something runnable.
 *
 * Almost entirely the shared path, with two differences that come from
 * the architecture rather than from anything this backend chose.
 *
 * It is the **first big-endian target**. `GuestMemory` has taken
 * endianness as a constructor argument since the first backend, for
 * exactly this, and nothing else in the loader has to know.
 *
 * And the process starts with **one window already blocked**. A SPARC
 * program has eight register windows and no way to tell how deep it has
 * gone, so something must stop `save` wrapping all the way round and
 * silently overwriting the outermost frame. That something is the
 * window invalid mask, which the kernel sets before the first
 * instruction runs. Without it the first eight calls work and the ninth
 * quietly destroys the entry frame -- a failure that looks like a
 * miscompiled program rather than a missing initial value.
 */
import { ElfError, ElfMachine, imageEnd, loadElf, parseElf, type ElfImage } from '../common/elf.ts'
import { LinuxSyscalls, buildInitialStack, type ProcessLayout } from '../common/linux.ts'
import { GuestMemory, PAGE_SIZE, Prot } from '../common/memory.ts'
import { SparcInterpreter, type SparcOptions } from './exec.ts'
import { SparcImage } from './image.ts'

const PF_X = 1

export interface LoadedSparc {
  elf: ElfImage
  memory: GuestMemory
  image: SparcImage
  interpreter: SparcInterpreter
  syscalls: LinuxSyscalls
}

export interface LoadSparcOptions extends SparcOptions {
  stackBytes?: number
  argv?: readonly string[]
  envp?: readonly string[]
  initialSp?: bigint
  initialRegisters?: readonly bigint[]
}

const DEFAULT_STACK_BYTES = 1024 * 1024
/** Where qemu-user puts a 32-bit SPARC stack. */
const DEFAULT_STACK_TOP = 0x7080_0000n
const HEAP_BYTES = 64n * 1024n * 1024n

export function loadSparc(bytes: Uint8Array, options: LoadSparcOptions = {}): LoadedSparc {
  const elf = parseElf(bytes)
  if (elf.machine !== ElfMachine.SPARC) {
    throw new ElfError(`not a SPARC object: e_machine is ${elf.machine}`)
  }
  if (elf.bits !== 32) throw new ElfError('not an ELF32 object')
  if (elf.littleEndian) throw new ElfError('not a big-endian object')

  const memory = new GuestMemory(false)
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

  const image = new SparcImage(memory, elf.entry, codeBytes)
  const interpreter = new SparcInterpreter(image, memory, {
    ...(options.instructionBudget !== undefined
      ? { instructionBudget: options.instructionBudget }
      : {}),
    linux: syscalls,
  })
  // %o6 is the stack pointer, which is window-relative register 14.
  interpreter.setGpr(14, initialSp)
  if (options.initialRegisters) {
    const initial = options.initialRegisters
    for (let r = 0; r < initial.length && r < 36; r++) interpreter.setGpr(r, initial[r]!)
  }
  return { elf, memory, image, interpreter, syscalls }
}
