/**
 * Seeded generator for randomised POWER differential programs.
 *
 * Same shape as the other generators. What is worth generating here was
 * decided partly by what broke: the first bug this backend had was a
 * rotate whose mask boundary is encoded in two pieces with its *most*
 * significant bit alone in a field of its own, which is wrong only for
 * boundaries above 31 and therefore invisible in most code. So the
 * rotate family is generated across the whole range of both the shift
 * and the mask rather than at the values a compiler happens to pick.
 *
 * The other three:
 *
 * **Carry is a register.** `addc` writes it, `adde` reads and writes
 * it, and `add` does not touch it. Extended-precision arithmetic is a
 * chain through that one resource, so the generator builds 128-bit adds
 * and subtracts out of the pairs and reads the answer back.
 *
 * **The condition register is eight registers.** Two comparisons into
 * two fields with a logical operation between single bits of them is
 * the shape the design exists for, and an implementation with one
 * condition register gets the same answer through a dependence that is
 * not there.
 *
 * **The scalar floating-point unit is the vector unit.** Ordinary
 * `double` arithmetic compiles to the VSX forms, and the multiply-add
 * rounds once rather than twice -- which differs in the last bit often
 * enough to fail on the first program that uses it.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))

/** xorshift64*, so a seed reproduces a program exactly on any machine. */
function rng(seed: number): () => bigint {
  let state = BigInt.asUintN(64, BigInt(seed) * 0x9e3779b97f4a7c15n + 1n) || 1n
  return () => {
    state ^= state >> 12n
    state = BigInt.asUintN(64, state ^ (state << 25n))
    state ^= state >> 27n
    return BigInt.asUintN(64, state * 0x2545f4914f6cdd1dn)
  }
}

const BOUNDARY = [
  0n, 1n, 0xffffffffffffffffn, 2n, 0x7fffffffffffffffn, 0x8000000000000000n,
  0x8000000000000001n, 0xfffffffffffffffen, 0x5555555555555555n,
  0xaaaaaaaaaaaaaaaan, 0xffn, 0x100n, 0xffffffffn, 0x100000000n,
  0x7fffffffn, 0x80000000n,
]

/** The plain register-to-register forms, 64-bit and 32-bit. */
const RR = ['add', 'subf', 'and', 'or', 'xor', 'nand', 'nor', 'eqv', 'andc', 'orc']
const WIDE = ['mulld', 'mulhd', 'mulhdu', 'divd', 'divdu', 'sld', 'srd', 'srad']
const NARROW = ['mullw', 'mulhw', 'mulhwu', 'divw', 'divwu', 'slw', 'srw', 'sraw']
/** The condition-register logic, which operates on single bits. */
const CRLOGIC = ['crand', 'cror', 'crxor', 'crnand', 'crnor', 'creqv', 'crandc', 'crorc']
/** The carry-extending forms, whose second operand is carry alone. */
const CARRY_EXT = ['addze', 'addme', 'subfze', 'subfme']

const PRELUDE = readFileSync(join(HERE, 'prelude.c'), 'utf8')

/** A double literal, with the awkward values mixed in on purpose. */
function fpValue(next: () => bigint): string {
  const choice = Number(next() % 10n)
  if (choice === 0) return '0.0'
  if (choice === 1) return '-0.0'
  if (choice === 2) return '1.0'
  if (choice === 3) return '4503599627370497.0'  // just past exact integers
  const magnitude = Number(next() % 1000000n) / 1000
  const sign = next() % 2n === 0n ? '' : '-'
  return `${sign}${magnitude.toFixed(6)}`
}

export function generateRandomProgram(seed: number): { source: string } {
  const next = rng(seed)
  const pick = <T,>(list: readonly T[]): T => list[Number(next() % BigInt(list.length))]!
  const word = (): bigint =>
    next() % 4n === 0n ? pick(BOUNDARY) : BigInt.asUintN(64, next())

  const body: string[] = []
  let slot = 0
  const emit = (line: string): void => { body.push(`  ${line}`) }
  const out = (): string => `SLOT(${slot++})`

  emit('unsigned long a, b, lo, hi, c;')
  emit('volatile double fx, fy, fz, fr;')

  for (let i = 0; i < 40; i++) {
    emit(`a = ${word()}UL; b = ${word()}UL;`)
    switch (Number(next() % 10n)) {
      case 0:
        emit(`RR("${pick(RR)}", a, b, ${out()});`)
        break
      case 1:
        emit(`RRCC("${pick(RR)}", a, b, ${out()}, c); ${out()} = c;`)
        break
      case 2:
        // Both widths of multiply, divide and shift. The shift amount
        // has one more bit than the width needs, and a shift past the
        // width gives zero rather than wrapping.
        emit(`RR("${pick(next() % 2n === 0n ? WIDE : NARROW)}", a, b, ${out()});`)
        break
      case 3: {
        // The rotate family, across the whole range of both fields.
        const sh = Number(next() % 64n)
        const mb = Number(next() % 64n)
        const me = Number(next() % 64n)
        emit(`RLWINM(a, ${sh % 32}, ${mb % 32}, ${me % 32}, ${out()});`)
        emit(`RLWIMI(a, b, ${sh % 32}, ${mb % 32}, ${me % 32}, ${out()});`)
        emit(`RLDICL(a, ${sh}, ${mb}, ${out()});`)
        emit(`RLDICR(a, ${sh}, ${me}, ${out()});`)
        emit(`RLDIC(a, ${sh}, ${Math.min(mb, 63 - sh)}, ${out()});`)
        emit(`RLDIMI(a, b, ${sh}, ${Math.min(mb, 63 - sh)}, ${out()});`)
        break
      }
      case 4:
        emit(`ADD128(a, b, ${word()}UL, ${word()}UL, lo, hi);` +
          ` ${out()} = lo; ${out()} = hi;`)
        emit(`SUB128(a, b, ${word()}UL, ${word()}UL, lo, hi);` +
          ` ${out()} = lo; ${out()} = hi;`)
        emit(`CARRYEXT("${pick(CARRY_EXT)}", a, b, ${out()});`)
        break
      case 5:
        emit(`CRLOGIC("${pick(CRLOGIC)}", a, b, ${word()}UL, ${word()}UL, ${out()});`)
        emit(`ISEL(a, b, ${word()}UL, ${word()}UL, ${out()});`)
        break
      case 6:
        emit(`COUNTED(${1 + Number(next() % 8n)}, a, ${out()});`)
        break
      case 7: {
        const offset = Number(next() % 64n) & ~7
        emit(`ST("std", ${offset}, a);`)
        emit(`LD("${pick(['ld', 'lwz', 'lwa', 'lhz', 'lha', 'lbz'])}", ${offset}, ${out()});`)
        emit(`BREV("stdbrx", "ldbrx", ${offset}, b, ${out()});`)
        emit(`BREV("stwbrx", "lwbrx", ${offset}, b, ${out()});`)
        break
      }
      case 8: {
        const x = fpValue(next)
        const y = fpValue(next)
        emit(`fx = ${x}; fy = ${y}; fz = ${fpValue(next)};`)
        emit(`F2("${pick(['fadd', 'fsub', 'fmul', 'fdiv'])}", fx, fy, fr);` +
          ` ${out()} = *(volatile unsigned long *)&fr;`)
        emit(`F1("${pick(['fsqrt', 'fneg', 'fabs', 'fmr'])}", fx, fr);` +
          ` ${out()} = *(volatile unsigned long *)&fr;`)
        emit(`FMA("${pick(['fmadd', 'fmsub', 'fnmadd', 'fnmsub'])}", fx, fy, fz, fr);` +
          ` ${out()} = *(volatile unsigned long *)&fr;`)
        emit(`FCMP(fx, fy, ${out()});`)
        break
      }
      default:
        emit(`IMM("addi", a, ${Number(next() % 65535n) - 32768}, ${out()});`)
        emit(`IMM("addic", a, ${Number(next() % 65535n) - 32768}, ${out()});`)
        emit(`IMM("mulli", a, ${Number(next() % 65535n) - 32768}, ${out()});`)
        emit(`IMM("subfic", a, ${Number(next() % 65535n) - 32768}, ${out()});`)
        break
    }
  }

  emit(`${out()} = deep(${12 + Number(next() % 12n)}, ${word()}UL);`)
  emit('return 0;')

  return { source: `${PRELUDE}\nlong kernel(void) {\n${body.join('\n')}\n}\n` }
}
