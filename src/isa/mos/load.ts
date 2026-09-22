/**
 * Loading a 6502 program.
 *
 * The llvm-mos `sim` target emits two files from one link, and this
 * accepts either, because they are useful for different things and both
 * appear in this repository.
 *
 * The **image** is what the simulator runs: a sequence of chunks, each a
 * load address and a length followed by that many bytes, with the last
 * chunk being the six bytes of interrupt vectors at $FFFA. Loading it is
 * the same act the reference performs, which is what the whole-program
 * tier needs it to be.
 *
 * The **ELF** beside it carries the symbols and the section boundaries,
 * which is what `llvm-objdump` needs to disassemble, and so what the
 * decode tier is checked against.
 *
 * Neither is a translation of the other: the ELF has no vectors and the
 * image has no symbols. So both are read here rather than one being
 * derived from the other.
 */
import { ElfError, ElfMachine, parseElf } from '../common/elf.ts'
import { MosBus, Vector } from './bus.ts'
import { MosInterpreter, type MosOptions } from './exec.ts'
import { MosImage } from './image.ts'
import { simPlatform, type SimPlatformOptions } from './platform.ts'

const ELF_MAGIC = [0x7f, 0x45, 0x4c, 0x46]

export interface MosLoadOptions extends SimPlatformOptions {
  instructionBudget?: number
  /**
   * Override the entry point. The image carries one in its reset vector
   * and the ELF in its header, so this is for tests that place code by
   * hand rather than for anything the toolchain produces.
   */
  entry?: number
}

export interface LoadedMos {
  image: MosImage
  interpreter: MosInterpreter
  bus: MosBus
}

function isElf(bytes: Uint8Array): boolean {
  return bytes.length >= 4 && ELF_MAGIC.every((byte, i) => bytes[i] === byte)
}

/**
 * Reads the chunked image the `sim` linker script emits.
 *
 * Returns the bytes covered, which is the code-size metric: the ELF's
 * section headers would count the same bytes plus the ones that are only
 * described, and the image is what actually reaches memory.
 */
function loadSimImage(bytes: Uint8Array, bus: MosBus): number {
  let at = 0
  let covered = 0
  while (at < bytes.length) {
    if (at + 4 > bytes.length) {
      throw new ElfError(
        `mos: image ends mid-header, ${bytes.length - at} byte(s) after 0x${at.toString(16)}`,
      )
    }
    const address = bytes[at]! | (bytes[at + 1]! << 8)
    const length = bytes[at + 2]! | (bytes[at + 3]! << 8)
    at += 4
    if (at + length > bytes.length) {
      throw new ElfError(
        `mos: image chunk at $${address.toString(16)} claims ${length} bytes ` +
        `but only ${bytes.length - at} remain`,
      )
    }
    bus.loadBytes(address, bytes.subarray(at, at + length))
    at += length
    covered += length
  }
  if (covered === 0) throw new ElfError('mos: image is empty')
  return covered
}

function loadMosElf(bytes: Uint8Array, bus: MosBus): { entry: number; covered: number } {
  const elf = parseElf(bytes)
  if (elf.machine !== ElfMachine.MOS) {
    throw new ElfError(`mos: ELF machine ${elf.machine}, expected ${ElfMachine.MOS}`)
  }
  if (elf.bits !== 32 || !elf.littleEndian) {
    throw new ElfError('mos: expected a little-endian ELF32')
  }
  let covered = 0
  for (const segment of elf.segments) {
    const start = Number(segment.vaddr)
    if (start + segment.memsz > 0x10000) {
      throw new ElfError(
        `mos: segment at $${start.toString(16)} runs past the address space`,
      )
    }
    bus.loadBytes(start, bytes.subarray(segment.offset, segment.offset + segment.filesz))
    // Anything beyond the file is zero-filled, which the bus already is.
    covered += segment.filesz
  }
  return { entry: Number(elf.entry), covered }
}

export function loadMos(bytes: Uint8Array, options: MosLoadOptions = {}): LoadedMos {
  const bus = new MosBus()
  let entry: number
  let covered: number

  if (isElf(bytes)) {
    const loaded = loadMosElf(bytes, bus)
    entry = loaded.entry
    covered = loaded.covered
  } else {
    covered = loadSimImage(bytes, bus)
    entry = bus.readWord(Vector.RESET)
  }
  if (options.entry !== undefined) entry = options.entry
  if (entry === 0) {
    throw new ElfError(
      'mos: no entry point — the reset vector is zero and none was given',
    )
  }

  const image = new MosImage(bus, BigInt(entry), covered)
  const interpreterOptions: MosOptions = { entry }
  if (options.instructionBudget !== undefined) {
    interpreterOptions.instructionBudget = options.instructionBudget
  }
  const interpreter = new MosInterpreter(image, bus, interpreterOptions)
  bus.attach(simPlatform(
    interpreter.host,
    options.stdin !== undefined ? { stdin: options.stdin } : {},
  ))
  return { image, interpreter, bus }
}
