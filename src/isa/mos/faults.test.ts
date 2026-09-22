/**
 * What this backend refuses, and that it refuses loudly.
 *
 * The rule the whole project runs on is that an instruction or a facility
 * this backend does not implement must stop the run with a message, never
 * fall through as a no-op or a plausible default. On this target there
 * are more things to refuse than on any other, because the architecture
 * has 105 undefined opcodes that real silicon nonetheless does something
 * for, and because the platform offers a cycle counter that an
 * interpreter separated from its timing model has no honest answer for.
 */
import { describe, expect, it } from 'vitest'
import { ElfError } from '../common/elf.ts'
import { ExecutionBudgetExceeded, UnimplementedInstruction } from '../common/errors.ts'
import { createRetireChunk, RunState } from '../common/trace.ts'
import { MosBus, Vector } from './bus.ts'
import { DOCUMENTED_OPCODES, decode } from './decode.ts'
import { MosInterpreter } from './exec.ts'
import { MosImage } from './image.ts'
import { loadMos } from './load.ts'
import { Io, UnsupportedPlatformAccess } from './platform.ts'

/** Builds a `sim` image: one chunk of code at $0200 and the vectors. */
function imageOf(code: number[], entry = 0x0200): Uint8Array {
  const bytes = [
    0x00, 0x02, code.length & 0xff, (code.length >> 8) & 0xff, ...code,
    0xfa, 0xff, 0x06, 0x00,
    0x00, 0x00,
    entry & 0xff, (entry >> 8) & 0xff,
    0x00, 0x00,
  ]
  return Uint8Array.from(bytes)
}

function runAll(bytes: Uint8Array, budget = 100_000): {
  stdout: string
  exit: number
  retired: number
} {
  const { interpreter } = loadMos(bytes, { instructionBudget: budget })
  const chunk = createRetireChunk(256)
  let state: RunState = RunState.MORE
  while (state === RunState.MORE) state = interpreter.run(chunk)
  return {
    stdout: new TextDecoder().decode(interpreter.stdout()),
    exit: interpreter.exitCode,
    retired: interpreter.retired,
  }
}

describe('mos 6502: encodings the architecture does not define', () => {
  it('stops the run rather than treating one as a no-op', () => {
    // $02 is one of the undefined encodings. On a real NMOS part it jams
    // the processor; here it is refused, because "jams" is behaviour
    // nothing in this project has verified.
    expect(() => runAll(imageOf([0xa9, 0x01, 0x02, 0xea])))
      .toThrow(UnimplementedInstruction)
  })

  it('names the opcode and where it was', () => {
    let message = ''
    try {
      runAll(imageOf([0xea, 0x1a]))
    } catch (error) {
      message = (error as Error).message
    }
    expect(message).toContain('undocumented opcode 1a')
    expect(message).toContain('0x201')
  })

  it('refuses one for every encoding outside the 151', () => {
    for (let opcode = 0; opcode < 256; opcode++) {
      if (DOCUMENTED_OPCODES.includes(opcode)) continue
      expect(() => decode(() => opcode, 0x1000n)).toThrow(UnimplementedInstruction)
    }
  })

  it('reports one found while speculating as unavailable, not as a throw', () => {
    // A timing model walks down mispredicted paths, which may run into
    // bytes that are not instructions. That has to be survivable.
    const bus = new MosBus()
    bus.loadBytes(0x0200, Uint8Array.from([0xea, 0x02]))
    const image = new MosImage(bus, 0x200n, 2)
    expect(image.speculativeAt(0x200n)).not.toBeNull()
    expect(image.speculativeAt(0x201n)).toBeNull()
    // And asked twice, because the answer is remembered.
    expect(image.speculativeAt(0x201n)).toBeNull()
    expect(() => image.at(0x201n)).toThrow(UnimplementedInstruction)
  })
})

describe('mos 6502: platform facilities this backend does not provide', () => {
  it('refuses to invent a cycle count for the guest', () => {
    // `lda $fff0` reads the simulator's cycle counter. Execution here
    // produces architectural state and cycles are the timing model's
    // answer, so there is nothing to return that would not be made up.
    expect(() => runAll(imageOf([0xad, 0xf0, 0xff])))
      .toThrow(UnsupportedPlatformAccess)
  })

  it('says which address and why', () => {
    let message = ''
    try {
      runAll(imageOf([0xad, 0xf2, 0xff]))
    } catch (error) {
      message = (error as Error).message
    }
    expect(message).toContain('fff2')
    expect(message).toContain('will not be invented')
  })

  it('refuses a reset of the clock too', () => {
    expect(() => runAll(imageOf([0xa9, 0x00, 0x8d, 0xf0, 0xff])))
      .toThrow(UnsupportedPlatformAccess)
  })

  it('does provide output and exit, which are the two it verified', () => {
    // sta $fff9 twice, then sta $fff8 to stop with a status.
    const result = runAll(imageOf([
      0xa9, 0x68, 0x8d, 0xf9, 0xff,
      0xa9, 0x69, 0x8d, 0xf9, 0xff,
      0xa9, 0x07, 0x8d, 0xf8, 0xff,
    ]))
    expect(result.stdout).toBe('hi')
    expect(result.exit).toBe(7)
  })

  it('reports end of input rather than blocking, which is what the reference does', () => {
    // lda $fff6 (the end-of-input flag), store it, exit with it.
    const result = runAll(imageOf([0xad, 0xf6, 0xff, 0x8d, 0xf8, 0xff]))
    expect(result.exit).toBe(1)
  })

  it('hands over stdin a byte at a time when there is some', () => {
    const { interpreter } = loadMos(
      imageOf([0xad, 0xf5, 0xff, 0x8d, 0xf9, 0xff, 0xad, 0xf5, 0xff, 0x8d, 0xf9, 0xff,
        0xa9, 0x00, 0x8d, 0xf8, 0xff]),
      { stdin: Uint8Array.from([0x41, 0x42]) },
    )
    const chunk = createRetireChunk(64)
    let state: RunState = RunState.MORE
    while (state === RunState.MORE) state = interpreter.run(chunk)
    expect(new TextDecoder().decode(interpreter.stdout())).toBe('AB')
  })
})

describe('mos 6502: images that are not images', () => {
  it('refuses a chunk header that runs off the end', () => {
    expect(() => loadMos(Uint8Array.from([0x00, 0x02, 0x10])))
      .toThrow(/ends mid-header/)
  })

  it('refuses a chunk that claims more bytes than it has', () => {
    expect(() => loadMos(Uint8Array.from([0x00, 0x02, 0x10, 0x00, 0xea])))
      .toThrow(/claims 16 bytes/)
  })

  it('refuses an empty image rather than running from address zero', () => {
    expect(() => loadMos(new Uint8Array())).toThrow(/image is empty/)
  })

  it('refuses an image whose reset vector is zero', () => {
    expect(() => loadMos(imageOf([0xea], 0x0000))).toThrow(/no entry point/)
  })

  it('refuses an ELF for another machine', () => {
    const elf = new Uint8Array(64)
    elf.set([0x7f, 0x45, 0x4c, 0x46, 1, 1, 1])
    // e_machine at offset 18: RISC-V rather than 6502.
    elf[18] = 243
    elf[19] = 0
    expect(() => loadMos(elf)).toThrow(ElfError)
  })
})

describe('mos 6502: running off the end of what the machine has', () => {
  it('stops a guest that will not finish', () => {
    // jmp to itself, which is how a 6502 program hangs.
    expect(() => runAll(imageOf([0x4c, 0x00, 0x02]), 5000))
      .toThrow(ExecutionBudgetExceeded)
  })

  it('wraps execution at the top of the address space rather than faulting', () => {
    // There is no memory protection on this machine and no address that
    // does not respond, so running past $FFFF wraps to $0000. Refusing it
    // would be modelling a fault the hardware does not have.
    const bus = new MosBus()
    bus.loadBytes(0xffff, Uint8Array.from([0xea]))
    bus.loadBytes(0x0000, Uint8Array.from([0xa9, 0x00]))
    bus.loadBytes(Vector.RESET, Uint8Array.from([0xff, 0xff]))
    const image = new MosImage(bus, 0xffffn, 1)
    const cpu = new MosInterpreter(image, bus)
    expect(cpu.pc).toBe(0xffff)
    cpu.step()
    expect(cpu.pc).toBe(0x0000)
  })
})

describe('mos 6502: code that rewrites itself', () => {
  it('notices a store that landed on an instruction already decoded', () => {
    // On a machine with three registers this is not a curiosity: writing
    // the operand of an instruction is an ordinary way to index. The
    // decode cache has to be invalidated or the second pass runs the
    // first pass's instruction.
    //
    //   0200 a9 41     lda #$41       the byte at $0203 is rewritten below
    //   0202 8d f9 ff  sta $fff9
    //   0205 a9 42     lda #$42
    //   0207 8d 01 02  sta $0201      now `lda #$42`
    //   020a 4c 00 02  jmp $0200
    const result = runAll(imageOf([
      0xa9, 0x41, 0x8d, 0xf9, 0xff,
      0xa9, 0x42, 0x8d, 0x01, 0x02,
      0xa9, 0x00, 0x8d, 0xf8, 0xff,
    ]))
    // Runs straight through the first time; the rewrite is proved by the
    // byte that a second pass would emit.
    expect(result.stdout).toBe('A')
    expect(result.exit).toBe(0)

    const again = runAll(imageOf([
      0xa9, 0x41, 0x8d, 0xf9, 0xff,
      0xa9, 0x42, 0x8d, 0x01, 0x02,
      0xad, 0x20, 0x00, 0xd0, 0x08,
      0xa9, 0x01, 0x8d, 0x20, 0x00,
      0x4c, 0x00, 0x02,
      0xa9, 0x00, 0x8d, 0xf8, 0xff,
    ]))
    // Second time round the first instruction is `lda #$42`, so the
    // output is "AB" rather than "AA".
    expect(again.stdout).toBe('AB')
  })
})

describe('mos 6502: the platform window is only ten addresses', () => {
  it('leaves the rest of the top page as ordinary memory', () => {
    // $FFEF is below the window and $FFFA is above it; both are memory,
    // and the vectors live in the second one.
    const bus = new MosBus()
    bus.write(0xffef, 0x5a)
    expect(bus.read(0xffef)).toBe(0x5a)
    expect(bus.read(Vector.IRQ)).toBe(0)
    expect(Io.OUTPUT - Io.CLOCK).toBe(9)
  })
})
