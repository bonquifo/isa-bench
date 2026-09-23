/**
 * The host calls a WebAssembly program actually makes.
 *
 * Every other backend here reaches the outside world through a Linux
 * system call: a number in a register, arguments in the others, and a
 * negative return for an error. This target has no system calls at all.
 * A module names the functions it wants and the embedder supplies them,
 * so what a program can do is a property of the *link* rather than of
 * the machine -- which is the most genuinely different thing about this
 * architecture, and the reason it is in the comparison.
 *
 * What is striking is how little a real libc asks for. Every one of the
 * app's fourteen corpus programs -- `printf` with floats, `malloc`,
 * `strlen`, `qsort` -- imports the same five functions and no others:
 *
 *     fd_write         bytes out
 *     fd_seek          where am I in this file
 *     fd_fdstat_get    what kind of thing is this file
 *     fd_close         done with it
 *     proc_exit        stop
 *
 * There is no `brk` and no `mmap`, because the heap is `memory.grow`,
 * which is an instruction rather than a call. There is no
 * `set_tid_address`, no `rseq`, no auxiliary vector and no `AT_PAGESZ`
 * -- which between them account for a good deal of the awkwardness on
 * the other targets.
 *
 * A few more are implemented below than any of those programs import,
 * because they are what a libc reaches for when its environment is less
 * bare than this one: `fd_read`, and the argument and environment
 * queries. Each is a real answer -- end of file, and nothing there --
 * rather than a placeholder.
 *
 * ## What is modelled and what is refused
 *
 * The three standard streams, and nothing else. There is no filesystem
 * here, so `path_open` is not implemented and a program that calls it is
 * refused rather than told the file is missing -- "no such file" is an
 * answer, and answering is what this project does not do for things it
 * has not built.
 */

/**
 * WASI error numbers.
 *
 * Not errno values: this is its own enumeration, assigned
 * alphabetically, so `EINVAL` is 28 here and 22 on Linux. Reusing the
 * host's numbers would produce a program that mostly worked.
 */
export const Errno = {
  SUCCESS: 0,
  BADF: 8,
  INVAL: 28,
  NOSYS: 52,
  NOTSUP: 58,
  NOTTY: 59,
  /** Seeking a pipe, which is how a libc discovers it cannot. */
  SPIPE: 70,
} as const

const FILETYPE_CHARACTER_DEVICE = 2

/** What the implementation needs from the machine around it. */
export interface WasiHost {
  /** Guest bytes, or null when the range is outside linear memory. */
  read(pointer: number, length: number): Uint8Array | null
  readU32(pointer: number): number
  writeU8(pointer: number, value: number): void
  writeU16(pointer: number, value: number): void
  writeU32(pointer: number, value: number): void
  writeU64(pointer: number, value: bigint): void
  /** Accepts output on a descriptor; only 1 and 2 ever reach it. */
  emit(fd: number, bytes: Uint8Array): void
  exit(code: number): void
}

/** The three descriptors that exist. */
function isStandardStream(fd: number): boolean {
  return fd === 0 || fd === 1 || fd === 2
}

/**
 * Calls one WASI function, or reports that this backend does not have it.
 *
 * Returns the errno the guest should see, or null for `proc_exit`, which
 * does not return. A name this does not know yields `undefined`, which
 * the caller turns into a loud refusal -- never into a plausible zero,
 * because a libc that is told a call succeeded when nothing happened
 * carries on and produces a wrong answer much later.
 */
export function callWasi(
  name: string, args: readonly bigint[], host: WasiHost,
): number | null | undefined {
  const arg = (index: number): number => Number(BigInt.asIntN(32, args[index] ?? 0n))

  switch (name) {
    case 'fd_write': {
      const fd = arg(0)
      const iovs = arg(1) >>> 0
      const count = arg(2) >>> 0
      const written = arg(3) >>> 0
      if (!isStandardStream(fd) || fd === 0) return Errno.BADF
      let total = 0
      for (let i = 0; i < count; i++) {
        // An iovec is a pointer and a length, both 32 bits, packed.
        const pointer = host.readU32(iovs + i * 8)
        const length = host.readU32(iovs + i * 8 + 4)
        if (length === 0) continue
        const bytes = host.read(pointer, length)
        if (!bytes) return Errno.INVAL
        host.emit(fd, bytes)
        total += length
      }
      host.writeU32(written, total)
      return Errno.SUCCESS
    }

    case 'fd_read': {
      // Nothing is connected to standard input, so every read is an
      // immediate end of file. That is a real answer rather than a
      // guess: a program reading from a closed pipe sees exactly this.
      const fd = arg(0)
      const read = arg(3) >>> 0
      if (fd !== 0) return Errno.BADF
      host.writeU32(read, 0)
      return Errno.SUCCESS
    }

    case 'fd_fdstat_get': {
      const fd = arg(0)
      const buffer = arg(1) >>> 0
      if (!isStandardStream(fd)) return Errno.BADF
      // struct __wasi_fdstat_t: filetype, two bytes of padding, flags,
      // four more, then two 64-bit rights masks. Twenty-four bytes, and
      // the padding is why the rights start at eight rather than four.
      host.writeU8(buffer, FILETYPE_CHARACTER_DEVICE)
      host.writeU8(buffer + 1, 0)
      host.writeU16(buffer + 2, 0)
      host.writeU32(buffer + 4, 0)
      host.writeU64(buffer + 8, 0xffff_ffff_ffff_ffffn)
      host.writeU64(buffer + 16, 0xffff_ffff_ffff_ffffn)
      return Errno.SUCCESS
    }

    case 'fd_seek': {
      const fd = arg(0)
      if (!isStandardStream(fd)) return Errno.BADF
      // A standard stream here is a pipe. Saying so is what makes the
      // libc choose the buffering it would choose against a real pipe,
      // and a wrong answer here changes where the output appears rather
      // than whether it appears -- which is the hardest kind to notice.
      return Errno.SPIPE
    }

    case 'fd_close':
      return isStandardStream(arg(0)) ? Errno.SUCCESS : Errno.BADF

    case 'fd_fdstat_set_flags':
      return isStandardStream(arg(0)) ? Errno.SUCCESS : Errno.BADF

    case 'fd_prestat_get':
      // No preopened directories, so the enumeration ends at once. This
      // is what a libc uses to discover it has no filesystem.
      return Errno.BADF

    case 'environ_sizes_get':
    case 'args_sizes_get': {
      // An empty environment and no arguments, stated rather than left
      // to whatever happened to be in memory.
      host.writeU32(arg(0) >>> 0, 0)
      host.writeU32(arg(1) >>> 0, 0)
      return Errno.SUCCESS
    }

    case 'environ_get':
    case 'args_get':
      return Errno.SUCCESS

    case 'proc_exit':
      host.exit(arg(0) & 0xff)
      return null

    default:
      return undefined
  }
}
