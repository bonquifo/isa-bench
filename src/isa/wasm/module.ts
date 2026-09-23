/**
 * Reading a WebAssembly module.
 *
 * Every other target here loads an ELF file: a header, some program
 * headers, and bytes copied to the addresses they name. This one is not
 * like that. A module is a sequence of typed sections, code lives in
 * one of them as a length-prefixed body per function, and nothing has
 * an address until the runtime gives it one.
 *
 * Two consequences shape the rest of the backend.
 *
 * **The program counter is a byte offset into the module.** There is no
 * other candidate: functions are not laid out in an address space, and
 * the only stable name for an instruction is where its bytes are. That
 * turns out to be enough for the whole contract -- the image is
 * addressed by it, the retired trace carries it, and the disassembler
 * prints it -- but it means a `pc` here is not something a guest could
 * ever compute or observe.
 *
 * **Imports come first and shift everything after them.** Function
 * index 0 is the first *imported* function, not the first defined one,
 * so a module with three imports has its own first function at index 3.
 * Getting that wrong calls the wrong function and the mistake looks
 * like a semantic bug rather than an indexing one.
 */
import { IsaError } from '../common/errors.ts'

export const PAGE_BYTES = 65536

export const ValType = {
  I32: 0x7f,
  I64: 0x7e,
  F32: 0x7d,
  F64: 0x7c,
  V128: 0x7b,
  FUNCREF: 0x70,
  EXTERNREF: 0x6f,
} as const

export interface FuncType {
  params: number[]
  results: number[]
}

export interface FuncBody {
  /** Index in the combined import-then-defined space. */
  index: number
  typeIndex: number
  /** Byte offset of the first instruction. */
  start: number
  /** Byte offset one past the function's last byte. */
  end: number
  /** Types of the declared locals, parameters excluded. */
  locals: number[]
  /** Parameters plus locals, which is what `local.get` indexes. */
  localCount: number
}

export interface ImportedFunc {
  module: string
  name: string
  typeIndex: number
}

export interface GlobalDef {
  type: number
  mutable: boolean
  /** The initial value, as raw bits. */
  init: bigint
}

export interface ExportDef {
  name: string
  kind: number
  index: number
}

export interface DataSegment {
  offset: number
  bytes: Uint8Array
}

export interface ElementSegment {
  offset: number
  functions: number[]
}

export interface WasmModule {
  types: FuncType[]
  importedFuncs: ImportedFunc[]
  /** Type index per defined function, in definition order. */
  functionTypes: number[]
  bodies: FuncBody[]
  globals: GlobalDef[]
  exports: ExportDef[]
  data: DataSegment[]
  elements: ElementSegment[]
  memoryPages: number
  memoryMax: number
  tableSize: number
  startFunction: number
  bytes: Uint8Array
}

class Reader {
  readonly bytes: Uint8Array
  at = 0

  constructor(bytes: Uint8Array) {
    this.bytes = bytes
  }

  byte(): number {
    if (this.at >= this.bytes.length) {
      throw new IsaError('wasm: module ends in the middle of a section')
    }
    return this.bytes[this.at++]!
  }

  /** An unsigned LEB128, which is how every length and index is written. */
  u32(): number {
    let value = 0
    let shift = 0
    for (;;) {
      const byte = this.byte()
      value |= (byte & 0x7f) << shift
      if ((byte & 0x80) === 0) break
      shift += 7
      if (shift > 35) throw new IsaError('wasm: over-long unsigned integer')
    }
    return value >>> 0
  }

  i32(): number {
    let value = 0
    let shift = 0
    let byte = 0
    do {
      byte = this.byte()
      value |= (byte & 0x7f) << shift
      shift += 7
    } while ((byte & 0x80) !== 0)
    if (shift < 32 && (byte & 0x40) !== 0) value |= ~0 << shift
    return value | 0
  }

  i64(): bigint {
    let value = 0n
    let shift = 0n
    let byte = 0
    do {
      byte = this.byte()
      value |= BigInt(byte & 0x7f) << shift
      shift += 7n
    } while ((byte & 0x80) !== 0)
    if (shift < 64n && (byte & 0x40) !== 0) value |= ~0n << shift
    return BigInt.asIntN(64, value)
  }

  name(): string {
    const length = this.u32()
    const raw = this.bytes.subarray(this.at, this.at + length)
    this.at += length
    return new TextDecoder().decode(raw)
  }

  take(length: number): Uint8Array {
    const out = this.bytes.subarray(this.at, this.at + length)
    this.at += length
    return out
  }
}

/**
 * Evaluates a constant expression.
 *
 * These appear as global initialisers and as the offsets of data and
 * element segments, and the specification restricts them to a handful
 * of instructions ending in `end`. Anything outside that is refused
 * rather than guessed at.
 */
function constantExpression(reader: Reader, globals: readonly GlobalDef[]): bigint {
  let value = 0n
  for (;;) {
    const code = reader.byte()
    if (code === 0x0b) break
    switch (code) {
      case 0x41: value = BigInt.asUintN(64, BigInt(reader.i32())); break
      case 0x42: value = BigInt.asUintN(64, reader.i64()); break
      case 0x43: {
        let bits = 0
        for (let i = 0; i < 4; i++) bits |= reader.byte() << (i * 8)
        value = BigInt(bits >>> 0)
        break
      }
      case 0x44: {
        let bits = 0n
        for (let i = 0; i < 8; i++) bits |= BigInt(reader.byte()) << BigInt(i * 8)
        value = bits
        break
      }
      case 0x23: {
        const index = reader.u32()
        value = globals[index]?.init ?? 0n
        break
      }
      case 0xd2: reader.u32(); value = 0n; break  // ref.func
      case 0xd0: reader.byte(); value = 0n; break // ref.null
      default:
        throw new IsaError(
          `wasm: opcode 0x${code.toString(16)} in a constant expression`,
        )
    }
  }
  return value
}

export function parseModule(bytes: Uint8Array): WasmModule {
  const reader = new Reader(bytes)
  const magic = [reader.byte(), reader.byte(), reader.byte(), reader.byte()]
  if (magic[0] !== 0x00 || magic[1] !== 0x61 || magic[2] !== 0x73 || magic[3] !== 0x6d) {
    throw new IsaError('wasm: not a WebAssembly module')
  }
  const version = reader.byte() | (reader.byte() << 8) |
    (reader.byte() << 16) | (reader.byte() << 24)
  if (version !== 1) throw new IsaError(`wasm: module version ${version}`)

  const out: WasmModule = {
    types: [],
    importedFuncs: [],
    functionTypes: [],
    bodies: [],
    globals: [],
    exports: [],
    data: [],
    elements: [],
    memoryPages: 0,
    memoryMax: 0,
    tableSize: 0,
    startFunction: -1,
    bytes,
  }

  while (reader.at < bytes.length) {
    const id = reader.byte()
    const size = reader.u32()
    const sectionEnd = reader.at + size

    switch (id) {
      case 1: { // types
        const count = reader.u32()
        for (let i = 0; i < count; i++) {
          const form = reader.byte()
          if (form !== 0x60) throw new IsaError(`wasm: type form 0x${form.toString(16)}`)
          const params: number[] = []
          const paramCount = reader.u32()
          for (let p = 0; p < paramCount; p++) params.push(reader.byte())
          const results: number[] = []
          const resultCount = reader.u32()
          for (let r = 0; r < resultCount; r++) results.push(reader.byte())
          out.types.push({ params, results })
        }
        break
      }
      case 2: { // imports
        const count = reader.u32()
        for (let i = 0; i < count; i++) {
          const module = reader.name()
          const name = reader.name()
          const kind = reader.byte()
          if (kind === 0) {
            out.importedFuncs.push({ module, name, typeIndex: reader.u32() })
          } else if (kind === 1) {
            reader.byte()
            const limits = reader.byte()
            out.tableSize = reader.u32()
            if (limits === 1) reader.u32()
          } else if (kind === 2) {
            const limits = reader.byte()
            out.memoryPages = reader.u32()
            out.memoryMax = limits === 1 ? reader.u32() : 0
          } else if (kind === 3) {
            const type = reader.byte()
            const mutable = reader.byte() === 1
            out.globals.push({ type, mutable, init: 0n })
          }
        }
        break
      }
      case 3: { // functions
        const count = reader.u32()
        for (let i = 0; i < count; i++) out.functionTypes.push(reader.u32())
        break
      }
      case 4: { // tables
        const count = reader.u32()
        for (let i = 0; i < count; i++) {
          reader.byte()
          const limits = reader.byte()
          out.tableSize = Math.max(out.tableSize, reader.u32())
          if (limits === 1) reader.u32()
        }
        break
      }
      case 5: { // memory
        const count = reader.u32()
        for (let i = 0; i < count; i++) {
          const limits = reader.byte()
          out.memoryPages = reader.u32()
          out.memoryMax = limits === 1 ? reader.u32() : 0
        }
        break
      }
      case 6: { // globals
        const count = reader.u32()
        for (let i = 0; i < count; i++) {
          const type = reader.byte()
          const mutable = reader.byte() === 1
          const init = constantExpression(reader, out.globals)
          out.globals.push({ type, mutable, init })
        }
        break
      }
      case 7: { // exports
        const count = reader.u32()
        for (let i = 0; i < count; i++) {
          const name = reader.name()
          const kind = reader.byte()
          out.exports.push({ name, kind, index: reader.u32() })
        }
        break
      }
      case 8: // start
        out.startFunction = reader.u32()
        break
      case 9: { // elements
        const count = reader.u32()
        for (let i = 0; i < count; i++) {
          const flags = reader.u32()
          if (flags === 0) {
            const offset = Number(constantExpression(reader, out.globals))
            const functions: number[] = []
            const n = reader.u32()
            for (let f = 0; f < n; f++) functions.push(reader.u32())
            out.elements.push({ offset, functions })
          } else {
            // The other seven forms are declarative or passive; none of
            // them places a function in the table at load time, which is
            // the only thing `call_indirect` needs.
            reader.at = sectionEnd
          }
        }
        break
      }
      case 10: { // code
        const count = reader.u32()
        for (let i = 0; i < count; i++) {
          const size = reader.u32()
          const bodyEnd = reader.at + size
          const localGroups = reader.u32()
          const locals: number[] = []
          for (let g = 0; g < localGroups; g++) {
            const n = reader.u32()
            const type = reader.byte()
            for (let k = 0; k < n; k++) locals.push(type)
          }
          const typeIndex = out.functionTypes[i] ?? 0
          const params = out.types[typeIndex]?.params.length ?? 0
          out.bodies.push({
            index: out.importedFuncs.length + i,
            typeIndex,
            start: reader.at,
            end: bodyEnd,
            locals,
            localCount: params + locals.length,
          })
          reader.at = bodyEnd
        }
        break
      }
      case 11: { // data
        const count = reader.u32()
        for (let i = 0; i < count; i++) {
          const flags = reader.u32()
          if (flags === 0) {
            const offset = Number(constantExpression(reader, out.globals))
            const length = reader.u32()
            out.data.push({ offset, bytes: reader.take(length) })
          } else if (flags === 2) {
            reader.u32()
            const offset = Number(constantExpression(reader, out.globals))
            const length = reader.u32()
            out.data.push({ offset, bytes: reader.take(length) })
          } else {
            const length = reader.u32()
            reader.take(length)
          }
        }
        break
      }
      default:
        // Custom sections and anything else this backend does not read.
        reader.at = sectionEnd
        break
    }
    reader.at = sectionEnd
  }

  return out
}

/** The body containing a byte offset, or null when it is not code. */
export function bodyAt(module: WasmModule, offset: number): FuncBody | null {
  for (const body of module.bodies) {
    if (offset >= body.start && offset < body.end) return body
  }
  return null
}

/** The function at an index in the combined import-then-defined space. */
export function bodyOf(module: WasmModule, index: number): FuncBody | null {
  return module.bodies[index - module.importedFuncs.length] ?? null
}

export function typeOf(module: WasmModule, index: number): FuncType {
  const imported = module.importedFuncs[index]
  if (imported) return module.types[imported.typeIndex] ?? { params: [], results: [] }
  const body = bodyOf(module, index)
  return module.types[body?.typeIndex ?? 0] ?? { params: [], results: [] }
}
