import {
  InstClass,
  NONE,
  Opcode,
  type InstClass as InstClassT,
  type MachInst,
  OperationOrigin,
  type OperationOrigin as OperationOriginT,
  type Opcode as OpcodeT,
} from './types.ts'

export function mach(partial: {
  op: OpcodeT
  mnemonic: string
  bytes: number
  cls: InstClassT
  dst?: number
  srcA?: number
  srcB?: number
  imm?: number
  memBase?: number
  memOff?: number
  memIndex?: number
  memScale?: number
  label?: string
  uops?: number
  readsMem?: boolean
  writesMem?: boolean
  saveRegs?: number[]
  saveSpills?: number[]
  resourceReads?: string[]
  resourceWrites?: string[]
  serializing?: boolean
  origin?: OperationOriginT
}): MachInst {
  return {
    op: partial.op,
    mnemonic: partial.mnemonic,
    bytes: partial.bytes,
    dst: partial.dst ?? NONE,
    srcA: partial.srcA ?? NONE,
    srcB: partial.srcB ?? NONE,
    imm: partial.imm ?? 0,
    memBase: partial.memBase ?? NONE,
    memOff: partial.memOff ?? 0,
    memIndex: partial.memIndex ?? NONE,
    memScale: partial.memScale ?? 1,
    target: NONE,
    label: partial.label ?? '',
    cls: partial.cls,
    uops: partial.uops ?? 1,
    readsMem: partial.readsMem ?? (partial.cls === InstClass.LD),
    writesMem: partial.writesMem ?? (partial.cls === InstClass.ST),
    addr: 0,
    saveRegs: partial.saveRegs,
    saveSpills: partial.saveSpills,
    resourceReads: partial.resourceReads ?? [],
    resourceWrites: partial.resourceWrites ?? [],
    serializing: partial.serializing ?? false,
    origin: partial.origin ?? OperationOrigin.SEMANTIC,
  }
}

export function resolveLabels(insts: MachInst[]): void {
  const labels = new Map<string, number>()
  insts.forEach((ins, i) => {
    if (ins.op === Opcode.NOP && ins.mnemonic.startsWith('.L')) {
      labels.set(ins.label, i)
    }
  })
  const filtered = insts.filter((ins) => !(ins.op === Opcode.NOP && ins.mnemonic.startsWith('.L')))
  const remap = new Map<number, number>()
  let j = 0
  insts.forEach((ins, i) => {
    if (!(ins.op === Opcode.NOP && ins.mnemonic.startsWith('.L'))) {
      remap.set(i, j)
      j += 1
    }
  })
  const nameToIndex = new Map<string, number>()
  labels.forEach((oldIdx, name) => {
    let k = oldIdx
    while (k < insts.length && insts[k].op === Opcode.NOP && insts[k].mnemonic.startsWith('.L')) {
      k += 1
    }
    nameToIndex.set(name, remap.get(k) ?? filtered.length)
  })

  insts.length = 0
  insts.push(...filtered)
  for (const ins of insts) {
    if (ins.label && (ins.cls === InstClass.BR || ins.op === Opcode.BR)) {
      const t = nameToIndex.get(ins.label)
      if (t === undefined) throw new Error(`Unresolved label ${ins.label}`)
      ins.target = t
    }
  }
}

export function assignAddresses(insts: MachInst[]): number {
  let addr = 0
  for (const ins of insts) {
    ins.addr = addr
    addr += ins.bytes
  }
  return addr
}

export function binClass(op: string): InstClassT {
  if (op === 'mul') return InstClass.MUL
  if (op === 'div' || op === 'rem') return InstClass.DIV
  if (op.endsWith('f')) return InstClass.FP
  return InstClass.ALU
}

export function binOpcode(op: string): OpcodeT {
  const map: Record<string, OpcodeT> = {
    add: Opcode.ADD,
    sub: Opcode.SUB,
    mul: Opcode.MUL,
    div: Opcode.DIV,
    rem: Opcode.REM,
    and: Opcode.AND,
    or: Opcode.OR,
    xor: Opcode.XOR,
    shl: Opcode.SHL,
    shr: Opcode.SHR,
    sar: Opcode.SAR,
    addf: Opcode.ADDF,
    subf: Opcode.SUBF,
    mulf: Opcode.MULF,
    divf: Opcode.DIVF,
    eqf: Opcode.EQF,
    nef: Opcode.NEF,
    ltf: Opcode.LTF,
    gef: Opcode.GEF,
  }
  const found = map[op]
  if (!found) throw new Error(`Unknown binop ${op}`)
  return found
}
