/**
 * Linux process emulation: the initial stack a libc expects to be started
 * with, and the syscalls it makes.
 *
 * Shared across targets rather than written per ISA, because it genuinely is
 * shared: riscv64 and aarch64 use the same asm-generic syscall numbers, and
 * the semantics are identical everywhere. What differs per ISA is only which
 * registers carry the number and the arguments, which the interpreter passes
 * in.
 *
 * Two deliberate departures from a real kernel, both in the direction of
 * reproducibility. A simulator whose output depends on the wall clock or on
 * entropy cannot be differentially tested, so `clock_gettime` returns a fixed
 * instant and `getrandom` returns a fixed sequence. Both are documented where
 * they are implemented, and both are stated in the architecture note rather
 * than left for someone to discover.
 *
 * A syscall this layer does not implement throws. Returning -ENOSYS would let
 * a libc silently take a fallback path and produce a plausible wrong answer,
 * which is the outcome this project exists to avoid. Calls that are genuinely
 * *supposed* to fail -- ioctl on something that is not a terminal -- return
 * the real errno, because that is correct behaviour rather than a stub.
 */
import { u64 } from './bits64.ts'
import { UnsupportedSyscall } from './errors.ts'
import { GuestMemory, PAGE_SIZE, Prot } from './memory.ts'

/** asm-generic syscall numbers, shared by riscv64 and aarch64. */
export const Sys = {
  IOCTL: 29,
  FACCESSAT: 48,
  OPENAT: 56,
  CLOSE: 57,
  LSEEK: 62,
  READ: 63,
  WRITE: 64,
  WRITEV: 66,
  READLINKAT: 78,
  EXIT: 93,
  EXIT_GROUP: 94,
  SET_TID_ADDRESS: 96,
  SET_ROBUST_LIST: 99,
  CLOCK_GETTIME: 113,
  RT_SIGACTION: 134,
  RT_SIGPROCMASK: 135,
  GETPID: 172,
  GETUID: 174,
  GETEUID: 175,
  GETGID: 176,
  GETEGID: 177,
  GETTID: 178,
  BRK: 214,
  MUNMAP: 215,
  MMAP: 222,
  MPROTECT: 226,
  MADVISE: 233,
  PRLIMIT64: 261,
  GETRANDOM: 278,
  RSEQ: 293,
} as const

const EBADF = 9n
const ENOSYS = 38n
const ENOTTY = 25n
const EINVAL = 22n

const STDOUT = 1
const STDERR = 2

/** Auxiliary vector entries a libc reads at startup. */
const AT_NULL = 0n
const AT_PHDR = 3n
const AT_PHENT = 4n
const AT_PHNUM = 5n
const AT_PAGESZ = 6n
const AT_BASE = 7n
const AT_ENTRY = 9n
const AT_UID = 11n
const AT_EUID = 12n
const AT_GID = 13n
const AT_EGID = 14n
const AT_HWCAP = 16n
const AT_CLKTCK = 17n
const AT_RANDOM = 25n

export interface ProcessLayout {
  /** Where the initial stack pointer is placed. */
  stackPointer: bigint
  /** First address the heap may grow into. */
  brkStart: bigint
  /** First address anonymous mappings are placed at. */
  mmapStart: bigint
}

export interface ProcessImage {
  entry: bigint
  /** Program header table address, size and count, for AT_PHDR and friends. */
  phdr: bigint
  phent: number
  phnum: number
}

export interface StackSetup {
  argv?: readonly string[]
  envp?: readonly string[]
}

/**
 * Lays out the stack Linux hands a freshly executed program: argc, the argv
 * pointers, the envp pointers, and the auxiliary vector, with the strings
 * they point at above them.
 *
 * A libc reads all of this before main runs. Starting it on a zeroed stack
 * appears to work for a while and then fails somewhere unrelated, because
 * AT_PAGESZ of zero makes the allocator compute nonsense.
 */
export function buildInitialStack(
  memory: GuestMemory,
  layout: ProcessLayout,
  image: ProcessImage,
  setup: StackSetup = {},
): bigint {
  const argv = setup.argv ?? ['guest']
  const envp = setup.envp ?? []
  const encoder = new TextEncoder()

  // Strings sit at the top, below them the pointer arrays that reference them.
  let cursor = layout.stackPointer
  const write = (bytes: Uint8Array): bigint => {
    cursor -= BigInt(bytes.length)
    memory.writeBytes(cursor, bytes)
    return cursor
  }

  const argvAddrs = argv.map((s) => write(encoder.encode(`${s}\0`)))
  const envpAddrs = envp.map((s) => write(encoder.encode(`${s}\0`)))
  // AT_RANDOM points at sixteen bytes a libc uses to seed stack guards. Fixed
  // rather than random, for the same reason getrandom is.
  const randomAddr = write(Uint8Array.from(
    Array.from({ length: 16 }, (_, i) => (i * 37 + 11) & 0xff),
  ))

  const aux: [bigint, bigint][] = [
    [AT_PHDR, image.phdr],
    [AT_PHENT, BigInt(image.phent)],
    [AT_PHNUM, BigInt(image.phnum)],
    [AT_PAGESZ, BigInt(PAGE_SIZE)],
    [AT_BASE, 0n],
    [AT_ENTRY, image.entry],
    [AT_UID, 0n],
    [AT_EUID, 0n],
    [AT_GID, 0n],
    [AT_EGID, 0n],
    [AT_HWCAP, 0n],
    [AT_CLKTCK, 100n],
    [AT_RANDOM, randomAddr],
    [AT_NULL, 0n],
  ]

  // argc + argv + NULL + envp + NULL + 2 words per aux entry.
  const words = 1 + argv.length + 1 + envp.length + 1 + aux.length * 2
  let sp = (cursor - BigInt(words * 8)) & ~15n
  const base = sp
  const put = (value: bigint): void => {
    memory.store(sp, 8, value)
    sp += 8n
  }
  put(BigInt(argv.length))
  for (const address of argvAddrs) put(address)
  put(0n)
  for (const address of envpAddrs) put(address)
  put(0n)
  for (const [key, value] of aux) {
    put(key)
    put(value)
  }
  return base
}

export interface SyscallResult {
  /** Value for the result register. */
  value: bigint
  /** Set when the guest asked to terminate. */
  exited?: boolean
}

export class LinuxSyscalls {
  private readonly memory: GuestMemory
  private readonly out: number[] = []
  private readonly err: number[] = []
  private brk: bigint
  private readonly brkLimit: bigint
  private mmapNext: bigint
  /** Deterministic stand-in for kernel entropy; see the note at the top. */
  private randomState = 0x2545f4914f6cdd1dn
  exitCode = 0

  constructor(memory: GuestMemory, layout: ProcessLayout) {
    this.memory = memory
    this.brk = layout.brkStart
    this.brkLimit = layout.mmapStart
    this.mmapNext = layout.mmapStart
  }

  stdout(): Uint8Array {
    return Uint8Array.from(this.out)
  }

  stderr(): Uint8Array {
    return Uint8Array.from(this.err)
  }

  dispatch(isa: string, number: number, args: readonly bigint[]): SyscallResult {
    switch (number) {
      case Sys.EXIT:
      case Sys.EXIT_GROUP:
        this.exitCode = Number(BigInt.asIntN(32, args[0]!))
        return { value: 0n, exited: true }

      case Sys.WRITE:
        return { value: this.write(isa, Number(args[0]!), args[1]!, Number(args[2]!)) }

      case Sys.WRITEV: {
        const fd = Number(args[0]!)
        let total = 0n
        for (let i = 0; i < Number(args[2]!); i++) {
          const entry = args[1]! + BigInt(i * 16)
          const base = this.memory.load(entry, 8, false)
          const length = Number(this.memory.load(entry + 8n, 8, false))
          if (length > 0) total += this.write(isa, fd, base, length)
        }
        return { value: total }
      }

      case Sys.BRK: {
        // brk(0) reports the current break; anything else moves it, and the
        // pages have to exist before the guest touches them.
        const requested = args[0]!
        if (requested !== 0n && requested >= this.brk && requested < this.brkLimit) {
          const from = (this.brk + BigInt(PAGE_SIZE - 1)) & ~BigInt(PAGE_SIZE - 1)
          if (requested > from) {
            this.memory.map(from, Number(requested - from), Prot.READ | Prot.WRITE)
          }
          this.brk = requested
        }
        return { value: this.brk }
      }

      case Sys.MMAP: {
        // Anonymous mappings only. Everything else is a bump allocator over a
        // region reserved for the purpose, except MAP_FIXED, which musl's
        // allocator uses to place and to trim its own mappings and which has
        // to land exactly where it was asked to.
        const addr = args[0]!
        const length = Number(args[1]!)
        const flags = Number(args[3]!)
        const fd = Number(BigInt.asIntN(32, args[4]!))
        const MAP_FIXED = 0x10
        if (fd !== -1) throw new UnsupportedSyscall(isa, number, 'of a file')
        const rounded = BigInt((length + PAGE_SIZE - 1) & ~(PAGE_SIZE - 1))
        if ((flags & MAP_FIXED) !== 0) {
          // A fresh anonymous mapping reads as zero even where it replaces
          // something already mapped, so the range is cleared rather than
          // merely made present.
          this.memory.map(addr, Number(rounded), Prot.READ | Prot.WRITE)
          this.memory.writeBytes(addr, new Uint8Array(Number(rounded)))
          if (addr + rounded > this.mmapNext) this.mmapNext = addr + rounded
          return { value: addr }
        }
        // A non-fixed address is a hint, and a kernel is free to ignore it.
        const at = this.mmapNext
        this.memory.map(at, Number(rounded), Prot.READ | Prot.WRITE)
        this.mmapNext += rounded
        return { value: at }
      }

      case Sys.MUNMAP:
      case Sys.MPROTECT:
      case Sys.MADVISE:
        // Unmapping is a no-op: nothing here reuses addresses, and leaving a
        // page mapped can only turn a guest bug into a working program, never
        // the reverse.
        return { value: 0n }

      case Sys.IOCTL:
        // Everything here writes to a pipe, never a terminal. This is the
        // honest answer, not a stub: it is what the kernel returns.
        return { value: -ENOTTY }

      case Sys.READLINKAT:
        return { value: -EINVAL }

      case Sys.CLOCK_GETTIME: {
        // Frozen. A simulator that reported the wall clock could not be
        // differentially tested, because two runs would disagree.
        const out = args[1]!
        this.memory.store(out, 8, 1_700_000_000n)
        this.memory.store(out + 8n, 8, 0n)
        return { value: 0n }
      }

      case Sys.GETRANDOM: {
        const buffer = args[0]!
        const length = Number(args[1]!)
        for (let i = 0; i < length; i++) {
          this.randomState = u64(this.randomState * 6364136223846793005n + 1442695040888963407n)
          this.memory.store(buffer + BigInt(i), 1, (this.randomState >> 33n) & 0xffn)
        }
        return { value: BigInt(length) }
      }

      case Sys.SET_TID_ADDRESS:
      case Sys.GETTID:
      case Sys.GETPID:
        return { value: 1n }

      case Sys.GETUID:
      case Sys.GETEUID:
      case Sys.GETGID:
      case Sys.GETEGID:
        return { value: 0n }

      case Sys.SET_ROBUST_LIST:
      case Sys.RT_SIGACTION:
      case Sys.RT_SIGPROCMASK:
      case Sys.PRLIMIT64:
        return { value: 0n }

      case Sys.RSEQ:
        // Restartable sequences are optional; a libc that is told they are
        // unavailable simply does not use them.
        return { value: -ENOSYS }

      case Sys.READ:
      case Sys.CLOSE:
      case Sys.LSEEK:
      case Sys.FACCESSAT:
      case Sys.OPENAT:
        // There is no file system. A guest that reaches for one is doing
        // something outside what this models, and should say so.
        throw new UnsupportedSyscall(isa, number, 'there is no file system')

      default:
        throw new UnsupportedSyscall(isa, number)
    }
  }

  private write(isa: string, fd: number, buffer: bigint, length: number): bigint {
    if (fd !== STDOUT && fd !== STDERR) {
      if (fd < 0) return -EBADF
      throw new UnsupportedSyscall(isa, Sys.WRITE, `to file descriptor ${fd}`)
    }
    const bytes = this.memory.readBytes(buffer, length)
    const sink = fd === STDOUT ? this.out : this.err
    for (const byte of bytes) sink.push(byte)
    return BigInt(length)
  }
}
