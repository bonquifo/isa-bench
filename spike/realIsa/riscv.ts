/**
 * Turns real llvm-objdump output for RV64 into the engine's MachInst stream.
 *
 * This is the piece that replaces a pseudo-backend. Everything the lowering
 * currently invents — instruction length, register pressure, which unit an
 * operation uses — is read off the real encoding instead:
 *
 *   - `bytes` comes from the distance to the next instruction address, so
 *     compressed (RVC) instructions count as the 2 bytes they really are
 *     rather than the flat 4 the model assumes.
 *   - registers are the architectural x0..x31, so RAW/WAW hazards and spill
 *     behaviour reflect RV64's real 32-register file.
 *   - the instruction class comes from the real opcode.
 */
import { InstClass, Opcode, NONE, type InstClass as InstClassT, type MachInst, type OpcodeT } from '../../src/engine/types.ts'
import { mach } from '../../src/engine/mach.ts'

export interface DisasmLine {
  address: number
  mnemonic: string
  operands: string[]
  bytes: number
}

/** RV64 ABI register names in architectural order, x0..x31. */
const ABI = [
  'zero', 'ra', 'sp', 'gp', 'tp', 't0', 't1', 't2',
  's0', 's1', 'a0', 'a1', 'a2', 'a3', 'a4', 'a5',
  'a6', 'a7', 's2', 's3', 's4', 's5', 's6', 's7',
  's8', 's9', 's10', 's11', 't3', 't4', 't5', 't6',
]
const ALIASES: Record<string, string> = { fp: 's0' }

export function registerIndex(token: string): number {
  const name = token.trim().replace(/^\$/, '')
  if (/^x(\d|[12]\d|3[01])$/.test(name)) return Number(name.slice(1))
  const canonical = ALIASES[name] ?? name
  const index = ABI.indexOf(canonical)
  if (index >= 0) return index
  // f0..f31 share the integer numbering here: the model tracks dependencies by
  // slot, and a float register is a distinct slot offset past the integer file.
  const float = /^f(?:a|s|t)?(\d+)$/.exec(name)
  if (float) return 32 + Number(float[1])
  return NONE
}

/**
 * Parses `llvm-objdump -d --no-show-raw-insn` output. Instruction length is
 * derived from consecutive addresses, which is the only way to get it right
 * for a variable-length encoding.
 */
export function parseDisasm(text: string): DisasmLine[] {
  const rows: Array<Omit<DisasmLine, 'bytes'>> = []
  for (const raw of text.split(/\r?\n/)) {
    const match = /^\s+([0-9a-f]+):\s+(.+)$/.exec(raw)
    if (!match) continue
    const body = match[2]!.replace(/\s*(<[^>]*>|#.*)$/, '').trim()
    if (!body) continue
    const [mnemonic, ...rest] = body.split(/\s+/)
    rows.push({
      address: parseInt(match[1]!, 16),
      mnemonic: mnemonic!.toLowerCase(),
      operands: rest.join(' ').split(',').map((item) => item.trim()).filter(Boolean),
    })
  }
  return rows.map((row, index) => {
    const next = rows[index + 1]
    // The final instruction has no successor; RVC is 2 bytes, everything else 4.
    const bytes = next ? next.address - row.address : (row.mnemonic.startsWith('c.') ? 2 : 4)
    return { ...row, bytes }
  })
}

interface Shape { op: OpcodeT; cls: InstClassT }

/** Real RV64 opcode -> the engine's operation class. */
export function classify(mnemonic: string): Shape {
  const m = mnemonic.replace(/^c\./, '')
  if (/^f/.test(m) && m !== 'fence') {
    if (/^fdiv|^fsqrt/.test(m)) return { op: Opcode.DIVF, cls: InstClass.FP }
    if (/^fmul|^fmadd|^fmsub|^fnmadd|^fnmsub/.test(m)) return { op: Opcode.MULF, cls: InstClass.FP }
    if (/^fl[wd]$/.test(m)) return { op: Opcode.LDD, cls: InstClass.LD }
    if (/^fs[wd]$/.test(m)) return { op: Opcode.STD, cls: InstClass.ST }
    return { op: Opcode.ADDF, cls: InstClass.FP }
  }
  if (/^(lb|lh|lw|ld|lbu|lhu|lwu)$/.test(m)) return { op: Opcode.LDW, cls: InstClass.LD }
  if (/^(sb|sh|sw|sd)$/.test(m)) return { op: Opcode.STW, cls: InstClass.ST }
  if (/^(mul|mulh|mulhu|mulhsu|mulw)$/.test(m)) return { op: Opcode.MUL, cls: InstClass.MUL }
  if (/^(div|divu|divw|divuw)$/.test(m)) return { op: Opcode.DIV, cls: InstClass.DIV }
  if (/^(rem|remu|remw|remuw)$/.test(m)) return { op: Opcode.REM, cls: InstClass.DIV }
  if (/^(beq|bne|blt|bge|bltu|bgeu|beqz|bnez|blez|bgez|bltz|bgtz|bgt|ble)$/.test(m)) {
    return { op: Opcode.BEQ, cls: InstClass.BR }
  }
  if (/^(j|jal|jr|jalr|ret|tail|call)$/.test(m)) return { op: Opcode.BR, cls: InstClass.BR }
  if (/^(sll|srl|sra|slli|srli|srai|sllw|srlw|sraw|slliw|srliw|sraiw)$/.test(m)) {
    return { op: m.includes('sra') ? Opcode.SAR : m.includes('srl') ? Opcode.SHR : Opcode.SHL, cls: InstClass.ALU }
  }
  if (/^(and|andi)$/.test(m)) return { op: Opcode.AND, cls: InstClass.ALU }
  if (/^(or|ori)$/.test(m)) return { op: Opcode.OR, cls: InstClass.ALU }
  if (/^(xor|xori)$/.test(m)) return { op: Opcode.XOR, cls: InstClass.ALU }
  if (/^(sub|subw|neg|negw)$/.test(m)) return { op: Opcode.SUB, cls: InstClass.ALU }
  if (/^(li|lui|auipc|mv)$/.test(m)) return { op: m === 'mv' ? Opcode.MOV : Opcode.LI, cls: InstClass.MOV }
  if (/^nop$/.test(m)) return { op: Opcode.NOP, cls: InstClass.NOP }
  // add/addi/addw/slt/sext/zext and the rest of the integer ALU.
  return { op: Opcode.ADD, cls: InstClass.ALU }
}

const STORES = /^(sb|sh|sw|sd|fsw|fsd)$/
const LOADS = /^(lb|lh|lw|ld|lbu|lhu|lwu|flw|fld)$/

/** `-8(sp)` style memory operand. */
function memoryOperand(token: string): { base: number; off: number } | null {
  const match = /^(-?\d+)?\(([^)]+)\)$/.exec(token.trim())
  if (!match) return null
  return { base: registerIndex(match[2]!), off: Number(match[1] ?? 0) }
}

export function toMachInsts(lines: readonly DisasmLine[]): MachInst[] {
  // The model follows branches by instruction index, while a real encoding
  // names a byte address. Objdump gives the resolved address as an operand,
  // so the two are reconciled here rather than guessed.
  const indexOfAddress = new Map<number, number>()
  lines.forEach((line, index) => indexOfAddress.set(line.address, index))

  return lines.map((line) => {
    const { op, cls } = classify(line.mnemonic)
    const bare = line.mnemonic.replace(/^c\./, '')
    const operands = line.operands
    const memory = operands.map(memoryOperand).find((item): item is { base: number; off: number } => item !== null)

    const isStore = STORES.test(bare)
    const isLoad = LOADS.test(bare)
    const isBranch = cls === InstClass.BR
    // A branch whose destination lies outside this object (a call to another
    // symbol) has no index to jump to; it falls through as a serializing op.
    const destination = isBranch
      ? operands.map((token) => /^0x([0-9a-f]+)$/i.exec(token.trim()))
        .filter((match): match is RegExpExecArray => match !== null)
        .map((match) => indexOfAddress.get(parseInt(match[1]!, 16)))
        .find((index): index is number => index !== undefined)
      : undefined
    // A store reads its value operand; every other form writes its first.
    const first = operands[0] ? registerIndex(operands[0]) : NONE
    const sources = operands.slice(isStore || isBranch ? 0 : 1)
      .map((token) => (memoryOperand(token) ? NONE : registerIndex(token)))
      .filter((index) => index !== NONE)

    const inst = mach({
      op,
      cls,
      mnemonic: `${line.mnemonic}${operands.length ? ` ${operands.join(', ')}` : ''}`,
      bytes: line.bytes,
      ...(isStore || isBranch || first === NONE ? {} : { dst: first }),
      ...(sources[0] !== undefined ? { srcA: sources[0] } : {}),
      ...(sources[1] !== undefined ? { srcB: sources[1] } : {}),
      ...(memory ? { memBase: memory.base, memOff: memory.off } : {}),
      ...(isLoad ? { readsMem: true } : {}),
      ...(isStore ? { writesMem: true } : {}),
    })
    // mach() does not take a target; the engine's own lowering assigns it in a
    // later label-resolution pass, so the same is done here.
    if (destination !== undefined) inst.target = destination
    return inst
  })
}
