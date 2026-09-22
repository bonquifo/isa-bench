/**
 * The llvm-mos `sim` platform: ten addresses at the top of memory.
 *
 * This is the whole operating system. There are no syscalls on a 6502,
 * so where the other targets have a Linux emulation layer of several
 * hundred lines, this one has a device occupying $FFF0 to $FFF9. Every
 * address in the map below was read off the simulator by compiling code
 * that uses the facility and disassembling what the platform's libc
 * actually emits, then confirmed by running a probe program under
 * `mos-sim` and comparing; none of it is from documentation.
 *
 *   $FFF0..$FFF3  a 32-bit cycle counter, low byte first. Writing any
 *                 value to $FFF0 resets it.
 *   $FFF4         reads as zero.
 *   $FFF5         the next byte of input.
 *   $FFF6         non-zero when input is exhausted, in which case $FFF5
 *                 reads as $FF.
 *   $FFF7         reads as zero.
 *   $FFF8         written to exit, with the value as the status.
 *   $FFF9         written to emit one byte to standard output.
 *
 * ## The clock is refused
 *
 * Four of those addresses are a cycle counter, and this backend will not
 * answer them. It is not an oversight and it is not laziness.
 *
 * An interpreter here produces architectural state; the number of cycles
 * that state took is decided afterwards by a timing model against a
 * hardware profile. There is no cycle count inside this file that could
 * be returned, and the two candidates for inventing one are both worse
 * than failing: a retired-instruction count would be a fabricated number
 * wearing the units of a real one, and passing the timing model's answer
 * back into the guest would let the simulated program's *output* depend
 * on the profile it was simulated under.
 *
 * The rule this project runs on is that an unimplemented facility fails
 * loudly. A guest that reads the clock stops with an error naming the
 * address, which is a bug report; a guest that reads a plausible number
 * and prints a benchmark result is a wrong answer nobody notices.
 */
import { IsaError } from '../common/errors.ts'
import type { MosDevice } from './bus.ts'
import type { MosHost } from './exec.ts'

export const IO_FIRST = 0xfff0
export const IO_LAST = 0xfff9

export const Io = {
  CLOCK: 0xfff0,
  CLOCK_END: 0xfff3,
  INPUT: 0xfff5,
  INPUT_EOF: 0xfff6,
  EXIT: 0xfff8,
  OUTPUT: 0xfff9,
} as const

/** Raised for a platform facility this backend does not provide. */
export class UnsupportedPlatformAccess extends IsaError {
  readonly address: number

  constructor(address: number, detail: string) {
    super(`mos: $${address.toString(16)} — ${detail}`)
    this.name = 'UnsupportedPlatformAccess'
    this.address = address
  }
}

export interface SimPlatformOptions {
  /** Bytes the guest can read; exhausted input reports end of file. */
  stdin?: Uint8Array
}

export function simPlatform(host: MosHost, options: SimPlatformOptions = {}): MosDevice {
  const input = options.stdin ?? new Uint8Array()
  let position = 0

  return {
    first: IO_FIRST,
    last: IO_LAST,

    read(address: number): number | null {
      if (address >= Io.CLOCK && address <= Io.CLOCK_END) {
        throw new UnsupportedPlatformAccess(
          address,
          'the guest read the simulator clock. Execution here produces ' +
          'architectural state and cycles are the timing model\'s answer, ' +
          'so there is no count to return and one will not be invented',
        )
      }
      if (address === Io.INPUT) {
        // $FF at end of input, which is what the simulator reports.
        return position < input.length ? input[position++]! : 0xff
      }
      if (address === Io.INPUT_EOF) {
        return position < input.length ? 0 : 1
      }
      // $FFF4 and $FFF7 read as zero on the simulator, and $FFF8 and
      // $FFF9 are write-only and read as zero with them.
      return 0
    },

    write(address: number, value: number): void {
      if (address === Io.OUTPUT) {
        host.emit(1, value)
        return
      }
      if (address === Io.EXIT) {
        host.exit(value)
        return
      }
      if (address >= Io.CLOCK && address <= Io.CLOCK_END) {
        throw new UnsupportedPlatformAccess(
          address, 'the guest reset the simulator clock, which is not modelled',
        )
      }
      // The remaining addresses in the window are not storage on the
      // simulator either, so a write to one is discarded rather than
      // becoming memory that reads back.
    },
  }
}
