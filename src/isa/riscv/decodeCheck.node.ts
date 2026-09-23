/**
 * What the shared decode tier needs to check this decoder against
 * `llvm-objdump`.
 *
 * RV64 had this tier before it was shared, and the alias table below is
 * the one it always used. What moved is the machinery around it, so that
 * the same check runs for every target rather than for this one.
 *
 * The compressed instructions are the part that is particular here: a
 * two-byte encoding expands into a full-length one before it is decoded,
 * and the length the decoder reports has to stay two. A decoder that
 * reported four would walk past the next instruction.
 */
import { Rv, decode32, decompress, type RvInst } from './decode.ts'
import type { DecodeCheck } from '../conformance.node.ts'

/**
 * objdump prints pseudo-instructions. Each maps onto one or more
 * canonical operations, and which one depends on the operands, so the
 * check is membership rather than equality.
 */
const ALIASES: Record<string, readonly number[]> = {
  li: [Rv.ADDI, Rv.LUI],
  mv: [Rv.ADDI, Rv.ADD],
  nop: [Rv.ADDI],
  j: [Rv.JAL],
  jr: [Rv.JALR],
  ret: [Rv.JALR],
  call: [Rv.JALR, Rv.AUIPC],
  tail: [Rv.JALR, Rv.AUIPC],
  neg: [Rv.SUB],
  negw: [Rv.SUBW],
  not: [Rv.XORI],
  seqz: [Rv.SLTIU],
  snez: [Rv.SLTU],
  sltz: [Rv.SLT],
  sgtz: [Rv.SLT],
  'sext.w': [Rv.ADDIW],
  'zext.w': [Rv.ADD],
  beqz: [Rv.BEQ],
  bnez: [Rv.BNE],
  blez: [Rv.BGE],
  bgez: [Rv.BGE],
  bltz: [Rv.BLT],
  bgtz: [Rv.BLT],
  bgt: [Rv.BLT],
  ble: [Rv.BGE],
  bgtu: [Rv.BLTU],
  bleu: [Rv.BGEU],
  frcsr: [Rv.CSRRS],
  fscsr: [Rv.CSRRW],
  frrm: [Rv.CSRRS],
  fsrm: [Rv.CSRRW],
  frflags: [Rv.CSRRS],
  csrr: [Rv.CSRRS],
  csrw: [Rv.CSRRW],
  'fmv.d': [Rv.FSGNJ_D],
  'fneg.d': [Rv.FSGNJN_D],
  'fabs.d': [Rv.FSGNJX_D],
  'fmv.s': [Rv.FSGNJ_S],
  'fneg.s': [Rv.FSGNJN_S],
  'fabs.s': [Rv.FSGNJX_S],
}

/**
 * The atomics with their ordering bits in the name: `lr.w.aqrl` is `lr.w`
 * with acquire and release set. Those bits order this hart's accesses as
 * another hart would observe them, and a single-hart interpreter has no
 * other observer, so the operation is the same one. musl's locks are where
 * these appear, which is why only the libc binaries have them.
 */
for (const [name, value] of Object.entries(Rv)) {
  if (!/^(LR|SC|AMO)/.test(name)) continue
  const base = name.toLowerCase().replace(/_/g, '.')
  for (const ordering of ['aq', 'rl', 'aqrl']) ALIASES[`${base}.${ordering}`] = [value]
}

function decodeBytes(bytes: Uint8Array, address: bigint): RvInst {
  const compressed = bytes.length === 2
  const word = compressed
    ? bytes[0]! | (bytes[1]! << 8)
    : (bytes[0]! | (bytes[1]! << 8) | (bytes[2]! << 16) | (bytes[3]! << 24)) >>> 0
  const expanded = compressed ? decompress(word, address) : word
  return decode32(expanded, compressed ? 2 : 4, address)
}

/**
 * The names the decoded operands imply.
 *
 * RISC-V's decoder already gives every width, precision and conversion its
 * own operation, so the membership check above is mostly harmless: `li` is
 * genuinely an `addi` from x0. What it cannot see is *which operand* made
 * it so. `bgez a0` and `blez a0` are the same `bge` with the zero register
 * on opposite sides, and a decoder that swapped rs1 and rs2 would pass;
 * `frrm`, `frflags` and `frcsr` are the same `csrrs` reading different
 * registers, and a decoder that misread the CSR number would pass too.
 * Here the operands decide the name.
 */
function signature(inst: RvInst): readonly string[] | undefined {
  const { rd, rs1, rs2, imm, csr } = inst
  const zero = (r: number): boolean => r === 0
  switch (inst.op) {
    case Rv.ADDI:
      if (zero(rd) && zero(rs1) && imm === 0n) return ['nop']
      if (zero(rs1)) return ['li']
      if (imm === 0n) return ['mv']
      return ['addi']
    case Rv.ADD:
      // The compressed move expands to an add from x0.
      if (zero(rs1) || zero(rs2)) return ['mv']
      return ['add']
    case Rv.ANDI: return imm === 255n ? ['zext.b'] : ['andi']
    case Rv.XORI: return imm === -1n ? ['not'] : ['xori']
    case Rv.SLTIU: return imm === 1n ? ['seqz'] : ['sltiu']
    case Rv.SLTU: return zero(rs1) ? ['snez'] : ['sltu']
    case Rv.SLT:
      if (zero(rs2)) return ['sltz']
      if (zero(rs1)) return ['sgtz']
      return ['slt']
    case Rv.SUB: return zero(rs1) ? ['neg'] : ['sub']
    case Rv.SUBW: return zero(rs1) ? ['negw'] : ['subw']
    case Rv.ADDIW: return imm === 0n ? ['sext.w'] : ['addiw']
    case Rv.BEQ: return zero(rs2) ? ['beqz'] : ['beq']
    case Rv.BNE: return zero(rs2) ? ['bnez'] : ['bne']
    case Rv.BGE:
      if (zero(rs2)) return ['bgez']
      if (zero(rs1)) return ['blez']
      return ['bge', 'ble']
    case Rv.BLT:
      if (zero(rs2)) return ['bltz']
      if (zero(rs1)) return ['bgtz']
      return ['blt', 'bgt']
    case Rv.BGEU: return ['bgeu', 'bleu']
    case Rv.BLTU: return ['bltu', 'bgtu']
    case Rv.JAL: return zero(rd) ? ['j'] : ['jal']
    case Rv.JALR:
      if (zero(rd) && rs1 === 1 && imm === 0n) return ['ret']
      if (zero(rd)) return ['jr', 'tail']
      return ['jalr', 'call']
    case Rv.CSRRS:
      if (zero(rs1)) {
        return [{ 1: 'frflags', 2: 'frrm', 3: 'frcsr' }[csr] ?? 'csrr']
      }
      return ['csrs', 'csrrs']
    case Rv.CSRRW:
      return [{ 1: 'fsflags', 2: 'fsrm', 3: 'fscsr' }[csr] ?? (zero(rd) ? 'csrw' : 'csrrw')]
    case Rv.CSRRSI: return zero(rd) ? ['csrsi'] : ['csrrsi']
    case Rv.CSRRCI: return zero(rd) ? ['csrci'] : ['csrrci']
    case Rv.CSRRWI:
      return [{ 1: 'fsflagsi', 2: 'fsrmi' }[csr] ?? (zero(rd) ? 'csrwi' : 'csrrwi')]
    case Rv.FSGNJ_S: return rs1 === rs2 ? ['fmv.s'] : ['fsgnj.s']
    case Rv.FSGNJN_S: return rs1 === rs2 ? ['fneg.s'] : ['fsgnjn.s']
    case Rv.FSGNJX_S: return rs1 === rs2 ? ['fabs.s'] : ['fsgnjx.s']
    case Rv.FSGNJ_D: return rs1 === rs2 ? ['fmv.d'] : ['fsgnj.d']
    case Rv.FSGNJN_D: return rs1 === rs2 ? ['fneg.d'] : ['fsgnjn.d']
    case Rv.FSGNJX_D: return rs1 === rs2 ? ['fabs.d'] : ['fsgnjx.d']
    default:
      return undefined
  }
}

export const rv64DecodeCheck: DecodeCheck = {
  decode(bytes, address) {
    const inst = decodeBytes(bytes, address)
    return { op: inst.op, length: inst.len }
  },
  signature(bytes, address) {
    return signature(decodeBytes(bytes, address))
  },
  name(op) {
    for (const [key, value] of Object.entries(Rv)) {
      if (value === op) return key.toLowerCase().replace(/_/g, '.')
    }
    return `?${op}`
  },
  aliases: ALIASES,
  // The canonical trap word, which a disassembler names but which is not
  // an instruction to execute.
  refused: ['unimp'],
}
