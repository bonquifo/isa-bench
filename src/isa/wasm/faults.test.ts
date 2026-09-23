/**
 * What this backend refuses, and that it refuses loudly.
 *
 * The distinction this file exists to keep is particular to this target.
 * Everywhere else in the project there is one kind of bad outcome --
 * something not implemented -- and it throws. Here there are two, and
 * confusing them would lose the more useful one:
 *
 *   a **trap** is the right answer. The program is valid, the standard
 *   says it stops, and conformance.test.ts checks that the reference
 *   engine stops on exactly the same programs. It is not a fault.
 *
 *   an **unimplemented** operation is a gap in this backend. It throws
 *   with a message naming what is missing.
 *
 * The third category here is the resource limits. The image gives every
 * operand-stack slot, local and global its own resource id from a fixed
 * space, and a module needing more than that space holds is refused --
 * rather than wrapped around, which would silently make two independent
 * values look like a dependence and quietly change every timing number
 * downstream.
 */
import { describe, expect, it } from 'vitest'
import {
  ExecutionBudgetExceeded,
  IsaError,
  UnimplementedInstruction,
} from '../common/errors.ts'
import { ControlKind, createRetireChunk, RunState } from '../common/trace.ts'
import { IMPLEMENTED_OPCODES, decode, nameOf } from './decode.ts'
import { WasmTrap } from './exec.ts'
import { customModule, importingModule, Type } from './generate.node.ts'
import { GLOBAL_SLOTS, LOCAL_SLOTS, Res, STACK_SLOTS, WASM_NAMING } from './image.ts'
import { loadWasm } from './load.ts'
import { parseModule } from './module.ts'
import { Errno, callWasi, type WasiHost } from './wasi.ts'

/** Loads a module and runs its `probe` export to completion. */
function run(bytes: Uint8Array, budget = 5_000_000): void {
  const loaded = loadWasm(bytes, { instructionBudget: budget, entry: 'probe' })
  const chunk = createRetireChunk(1024)
  let state: RunState = RunState.MORE
  while (state === RunState.MORE) state = loaded.interpreter.run(chunk)
}

const END = [0x0b]

describe('wasm: operations this backend does not implement', () => {
  it('refuses the reference-type table accesses rather than guessing', () => {
    // `table.get` and `table.set` decode -- the table knows what they
    // are, so a disassembly is right about them -- and have no
    // semantics. Nothing a C toolchain emits uses them, so there is
    // nothing here that could have verified an implementation.
    const bytes = customModule({
      body: [0x41, 0x00, 0x25, 0x00, 0x1a, ...END],
      table: true,
    })
    expect(() => run(bytes)).toThrow(UnimplementedInstruction)
    expect(() => run(bytes)).toThrow(/table\.get/)
  })

  it('still decodes them, so a disassembly is not wrong about them', () => {
    const read = (offset: number): number => [0x25, 0x00][offset] ?? 0
    expect(nameOf(decode(read, 0n).op)).toBe('table.get')
    expect(IMPLEMENTED_OPCODES).toContain(0x25)
  })

  it('refuses an opcode that is not one', () => {
    // 0x06 sits in the control block and is not assigned.
    expect(() => decode((offset) => [0x06][offset] ?? 0, 0x10n))
      .toThrow(UnimplementedInstruction)
  })

  it('refuses an unassigned opcode in the prefix space', () => {
    // 0xfc 200: the prefix byte is real and the sub-opcode is not.
    expect(() => decode((offset) => [0xfc, 0xc8, 0x01][offset] ?? 0, 0x10n))
      .toThrow(/prefixed opcode/)
  })

  it('names what is missing rather than where', () => {
    let message = ''
    try {
      run(customModule({ body: [0x41, 0x00, 0x25, 0x00, 0x1a, ...END], table: true }))
    } catch (error) { message = (error as Error).message }
    expect(message).toContain('table.get')
    expect(message).toContain('no semantics in this backend')
  })
})

describe('wasm: host calls', () => {
  it('refuses an import from an interface it does not implement', () => {
    // A module may import from anywhere; this backend implements one
    // interface, and answering a call from another with a zero would let
    // a libc carry on believing something happened.
    const bytes = importingModule('env', 'read_the_clock',
      [0x41, 0x00, 0x41, 0x00, 0x41, 0x00, 0x41, 0x00, 0x10, 0x00, 0x1a, ...END])
    expect(() => run(bytes)).toThrow(UnimplementedInstruction)
    expect(() => run(bytes)).toThrow(/env\.read_the_clock/)
  })

  it('refuses a WASI call it has not built', () => {
    const bytes = importingModule('wasi_snapshot_preview1', 'path_open',
      [0x41, 0x00, 0x41, 0x00, 0x41, 0x00, 0x41, 0x00, 0x10, 0x00, 0x1a, ...END])
    // There is no filesystem here, and "no such file" is an answer.
    // Refusing is not.
    expect(() => run(bytes)).toThrow(/path_open/)
  })

  it('reports a bad descriptor rather than writing somewhere', () => {
    const written: number[] = []
    const host: WasiHost = {
      read: () => new Uint8Array(),
      readU32: () => 0,
      writeU8: () => {}, writeU16: () => {}, writeU32: () => {}, writeU64: () => {},
      emit: (fd) => { written.push(fd) },
      exit: () => {},
    }
    expect(callWasi('fd_write', [7n, 0n, 0n, 0n], host)).toBe(Errno.BADF)
    expect(callWasi('fd_write', [0n, 0n, 0n, 0n], host)).toBe(Errno.BADF)
    expect(written).toEqual([])
  })

  it('tells a libc that a standard stream cannot be seeked', () => {
    const host = stubHost()
    // Answering "fine, you are at offset zero" would make the libc
    // choose the buffering it uses for a file, and the output would come
    // out in a different order rather than not at all.
    expect(callWasi('fd_seek', [1n, 0n, 0n, 0n], host)).toBe(Errno.SPIPE)
    expect(callWasi('fd_seek', [9n, 0n, 0n, 0n], host)).toBe(Errno.BADF)
  })

  it('reports a name it does not know as unknown, not as success', () => {
    expect(callWasi('sock_accept', [0n], stubHost())).toBeUndefined()
  })
})

function stubHost(): WasiHost {
  return {
    read: () => new Uint8Array(),
    readU32: () => 0,
    writeU8: () => {}, writeU16: () => {}, writeU32: () => {}, writeU64: () => {},
    emit: () => {},
    exit: () => {},
  }
}

describe('wasm: modules whose shape this backend has no room for', () => {
  it('refuses more globals than it has resource ids for', () => {
    const bytes = customModule({ body: END, globalCount: GLOBAL_SLOTS + 1 })
    expect(() => loadWasm(bytes)).toThrow(IsaError)
    expect(() => loadWasm(bytes)).toThrow(/more than the 32/)
  })

  it('accepts exactly as many as it does', () => {
    // The counterfactual: one fewer must load, or the limit above could
    // be anything at all.
    expect(() => loadWasm(customModule({ body: END, globalCount: GLOBAL_SLOTS })))
      .not.toThrow()
  })

  it('refuses a local index outside its space', () => {
    // Reached through the image rather than the loader: the analysis is
    // what assigns resource ids, so that is where the limit lives.
    const body = [0x20, ...uleb(LOCAL_SLOTS + 4), 0x1a, ...END]
    const locals = Array.from({ length: LOCAL_SLOTS + 8 }, () => Type.I32)
    const bytes = customModule({ body, localTypes: locals })
    expect(() => loadWasm(bytes).image.at(BigInt(firstInstruction(bytes))))
      .toThrow(/local 260 .* outside the 256/)
  })

  it('refuses an operand stack deeper than its space', () => {
    // Pushing constants and never consuming them, which is valid wasm
    // and needs a slot for each.
    const body: number[] = []
    for (let i = 0; i < STACK_SLOTS + 4; i++) body.push(0x41, 0x00)
    for (let i = 0; i < STACK_SLOTS + 4; i++) body.push(0x1a)
    const bytes = customModule({ body: [...body, ...END] })
    expect(() => loadWasm(bytes).image.at(BigInt(firstInstruction(bytes))))
      .toThrow(/operand stack slot .* outside the 64/)
  })

  it('says why, so the message is a decision rather than a limit', () => {
    let message = ''
    try { loadWasm(customModule({ body: END, globalCount: 40 })) }
    catch (error) { message = (error as Error).message }
    expect(message).toContain('resource ids')
  })
})

/** Where a module's first function body starts. */
function firstInstruction(bytes: Uint8Array): number {
  return parseModule(bytes).bodies[0]!.start
}

function uleb(value: number): number[] {
  const out: number[] = []
  let v = value >>> 0
  do {
    let byte = v & 0x7f
    v >>>= 7
    if (v !== 0) byte |= 0x80
    out.push(byte)
  } while (v !== 0)
  return out
}

describe('wasm: containers that are not modules', () => {
  it('refuses a file that is not one', () => {
    expect(() => loadWasm(new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 1, 1, 1, 0])))
      .toThrow(/not a WebAssembly module/)
  })

  it('refuses a version it has not seen', () => {
    const bytes = customModule({ body: END })
    const altered = new Uint8Array(bytes)
    altered[4] = 2
    expect(() => loadWasm(altered)).toThrow(/module version 2/)
  })

  it('loads the module it is actually for', () => {
    // Or the two above would pass for the wrong reason.
    expect(() => loadWasm(customModule({ body: END }))).not.toThrow()
  })

  it('refuses to name an export that is not there', () => {
    expect(() => loadWasm(customModule({ body: END }), ))
      .not.toThrow()
    expect(() => loadWasm(customModule({ body: END }), { entry: 'nowhere' }))
      .toThrow(/exports no function named nowhere/)
  })
})

describe('wasm: fetching from somewhere that is not an instruction', () => {
  it('refuses an offset outside any function body', () => {
    const { image } = loadWasm(customModule({ body: END }))
    expect(() => image.at(0n)).toThrow(/not inside any function body/)
  })

  it('refuses an offset that is not an instruction boundary', () => {
    // The encoding is variable-length, so "half way through an
    // immediate" is a real place to land -- and nothing in the guest can
    // name an address at all, so reaching one means something computed
    // an offset wrongly.
    const bytes = customModule({ body: [0x41, 0x80, 0x80, 0x80, 0x00, 0x1a, ...END] })
    const { image } = loadWasm(bytes)
    const start = firstInstruction(bytes)
    expect(() => image.at(BigInt(start))).not.toThrow()
    expect(() => image.at(BigInt(start + 1))).toThrow(/not an instruction boundary/)
  })

  it('reports one found while speculating as unavailable, not as a throw', () => {
    // A timing model walks down paths that never retire, and running
    // into something that is not an instruction there is normal.
    const bytes = customModule({ body: [0x41, 0x00, 0x1a, ...END] })
    const { image } = loadWasm(bytes)
    const start = firstInstruction(bytes)
    expect(image.speculativeAt(BigInt(start))).not.toBeNull()
    expect(image.speculativeAt(0n)).toBeNull()
    // And again, from the cache of failures.
    expect(image.speculativeAt(0n)).toBeNull()
  })
})

describe('wasm: running out of budget', () => {
  it('stops a guest that will not finish', () => {
    //   loop  br 0  end   which is how a program hangs here.
    const bytes = customModule({ body: [0x03, 0x40, 0x0c, 0x00, 0x0b, ...END] })
    expect(() => run(bytes, 5000)).toThrow(ExecutionBudgetExceeded)
  })

  it('distinguishes a budget from a trap', () => {
    // Both stop the run, and only one of them means the program was
    // going to stop anyway.
    const hang = customModule({ body: [0x03, 0x40, 0x0c, 0x00, 0x0b, ...END] })
    const trap = customModule({ body: [0x00, ...END] })
    expect(() => run(hang, 5000)).not.toThrow(WasmTrap)
    expect(() => run(trap)).toThrow(WasmTrap)
  })
})

describe('wasm: what the timing model is told', () => {
  it('names an operand stack slot by its depth', () => {
    //   i32.const 1   i32.const 2   i32.add   drop
    const bytes = customModule({ body: [0x41, 0x01, 0x41, 0x02, 0x6a, 0x1a, ...END] })
    const { image } = loadWasm(bytes)
    const start = firstInstruction(bytes)
    const constants = image.at(BigInt(start))
    const add = image.at(BigInt(start + 4))

    // The first constant writes the bottom slot; the second writes the
    // one above it.
    expect(constants.writes).toContain(Res.STACK + 0)
    expect(add.depth).toBe(2)
    // The add takes both and leaves one where the first was, which is
    // what makes two adds at different depths independent.
    expect(add.reads).toContain(Res.STACK + 1)
    expect(add.reads).toContain(Res.STACK + 0)
    expect(add.writes).toEqual([Res.STACK + 0])
  })

  it('makes every slot and local depend on the activation', () => {
    // Slots and locals are frame-relative and the id space is not, so a
    // call is a dependence both sides carry. Without this, a callee's
    // slot 0 and its caller's would look like the same storage with
    // nothing between them.
    const bytes = customModule({ body: [0x41, 0x01, 0x1a, ...END] })
    const { image } = loadWasm(bytes)
    const first = image.at(BigInt(firstInstruction(bytes)))
    expect(first.reads).toContain(Res.FRAME)
  })

  it('gives a global its own resource, outside the frame-relative ones', () => {
    //   global.get 0   drop
    const bytes = customModule({ body: [0x23, 0x00, 0x1a, ...END], globalCount: 2 })
    const { image } = loadWasm(bytes)
    const get = image.at(BigInt(firstInstruction(bytes)))
    // The global is module-wide, so two functions reading global 0 name
    // the same storage -- unlike slot 0 or local 0, which are the same
    // id in different frames and are not the same storage.
    expect(get.reads).toContain(Res.GLOBAL + 0)
    // It lands in a stack slot, which is frame-relative, so this
    // instruction depends on the activation after all. Every value here
    // passes through the stack, which is why the frame dependence is
    // near-universal rather than selective.
    expect(get.writes).toContain(Res.STACK + 0)
    expect(get.reads).toContain(Res.FRAME)
  })

  it('leaves an instruction that names nothing out of it entirely', () => {
    // `nop` touches no storage, so it carries no dependence at all --
    // which is the counterfactual showing the frame read above comes
    // from the slot and not from being attached to everything.
    const bytes = customModule({ body: [0x01, ...END] })
    const { image } = loadWasm(bytes)
    const nop = image.at(BigInt(firstInstruction(bytes)))
    expect(nop.reads).toEqual([])
    expect(nop.writes).toEqual([])
  })

  it('resolves a branch to an offset rather than a depth', () => {
    //   block  br 0  end
    const bytes = customModule({ body: [0x02, 0x40, 0x0c, 0x00, 0x0b, ...END] })
    const { image } = loadWasm(bytes)
    const start = firstInstruction(bytes)
    const branch = image.at(BigInt(start + 2))
    expect(branch.control).toBe(ControlKind.JUMP)
    // Past the `end` that closes the block, which is the whole of what
    // "leave one block" means once it is resolved.
    expect(branch.branch?.target).toBe(start + 5)
    expect(branch.staticTarget).toBe(BigInt(start + 5))
  })

  it('names every resource it can report', () => {
    for (let id = 0; id < WASM_NAMING.count; id++) {
      expect(WASM_NAMING.name(id).length).toBeGreaterThan(0)
    }
    expect(WASM_NAMING.name(Res.FRAME)).toBe('frame')
    expect(WASM_NAMING.name(Res.MEMORY)).toBe('mem')
    // And an id it has no name for is reported as unknown rather than
    // as something plausible.
    expect(WASM_NAMING.name(WASM_NAMING.count + 1)).toMatch(/^\?/)
  })
})
