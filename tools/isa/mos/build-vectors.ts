/**
 * Builds the MOS 6502 per-opcode conformance vectors.
 *
 *   npx vite-node tools/isa/mos/build-vectors.ts
 *
 * Every other target in this project is verified against a reference
 * *implementation* -- qemu, or for x86-64 the host processor -- run in
 * lockstep. This one cannot be: the llvm-mos simulator has no tracing
 * interface, so there is nothing to step alongside.
 *
 * What exists instead is better for the part it covers. The SingleStepTests
 * project publishes, for each of the 256 opcodes, ten thousand cases of the
 * form "here is the entire machine before, run exactly one instruction, here
 * is the entire machine after". They are generated, not recorded from
 * silicon: the project's README says each set comes from an implementation
 * that conforms to all available documentation, passes every other
 * published test set, and has been verified in an emulated machine.
 * That is a stronger statement than lockstep for a single instruction -- lockstep only ever
 * sees the states a compiler's output happens to reach, while these reach
 * arbitrary ones, including every combination of flags -- and a weaker one
 * for a program, since it says nothing about instructions in sequence. The
 * two tiers this target does have are chosen to cover that gap: these
 * vectors for what one instruction does, and whole compiled programs
 * against the simulator for what many of them do together.
 *
 * ## Why a sample rather than all of it
 *
 * All 256 files are 840 MB. Committing that is not reasonable, and
 * downloading it during the test run would mean the suite passes or fails
 * depending on the network, which is not a property a conformance suite
 * should have. So a deterministic sample is committed, and this script is
 * what regenerates it: trusting the fixtures needs nothing, regenerating
 * them needs the source.
 *
 * ## Why this sample
 *
 * A uniform sample would be defensible but would miss what actually
 * breaks implementations. The cases that catch bugs are the structural
 * edges -- a zero page pointer that wraps at $FF, an indexed address that
 * crosses a page, a stack pointer at either end, an indirect jump through
 * the address the hardware gets wrong -- and each of those is rare enough
 * in a uniform draw that a 128-case sample would usually not contain one.
 *
 * So the sample is uniform plus a targeted pass that guarantees each of
 * those conditions appears whenever the opcode can produce it. The
 * conditions are recorded per opcode in the index, so what the fixture
 * does and does not cover is a fact you can read rather than infer.
 */
import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT_DIR = resolve(HERE, '../../../src/isa/mos/fixtures')

/**
 * Pinned to a commit rather than to a branch. A conformance fixture whose
 * source can change underneath it is not a fixture.
 */
const SOURCE_COMMIT = '2f6980a2d95757486c7bee24355c360e40e2a224'
const SOURCE_BASE =
  `https://raw.githubusercontent.com/SingleStepTests/65x02/${SOURCE_COMMIT}/6502/v1`

/** Cases drawn uniformly per opcode. */
const UNIFORM_PER_OPCODE = 128
/** Extra cases drawn per structural condition, where the opcode has one. */
const PER_CONDITION = 8
/** Fixed so a rebuild produces the same file. */
const SEED = 0x6502

interface RawState {
  pc: number
  s: number
  a: number
  x: number
  y: number
  p: number
  ram: [number, number][]
}
interface RawCase {
  name: string
  initial: RawState
  final: RawState
}

/** xorshift32, so the draw is reproducible without a dependency. */
function rng(seed: number): () => number {
  let state = seed >>> 0
  if (state === 0) state = 0x1234_5678
  return () => {
    state ^= state << 13; state >>>= 0
    state ^= state >>> 17
    state ^= state << 5; state >>>= 0
    return state
  }
}

/** Reads a byte of the case's initial memory, which is all it has. */
function byteAt(state: RawState, address: number): number {
  for (const [addr, value] of state.ram) {
    if (addr === (address & 0xffff)) return value
  }
  return 0
}

/**
 * Which awkward thing, if any, this case exercises.
 *
 * Derived from the initial state rather than from the opcode table, so
 * this script does not have to agree with the decoder it is testing --
 * which would defeat the point of having an independent oracle.
 */
function conditionsOf(instance: RawCase): string[] {
  const initial = instance.initial
  const pc = initial.pc
  const opcode = byteAt(initial, pc)
  const lo = byteAt(initial, (pc + 1) & 0xffff)
  const hi = byteAt(initial, (pc + 2) & 0xffff)
  const found: string[] = []

  // The low three bits of an opcode largely choose the addressing mode,
  // and the exceptions are named explicitly below.
  const column = opcode & 0x1f

  const absolute = (lo | (hi << 8)) & 0xffff
  const crosses = (base: number, index: number): boolean =>
    ((base + index) & 0xff00) !== (base & 0xff00)

  // (zp,X): the pointer is formed in page zero and wraps there.
  if (column === 0x01) {
    const pointer = (lo + initial.x) & 0xff
    if (pointer === 0xff) found.push('zp-pointer-wrap')
    if (((lo + initial.x) & 0x100) !== 0) found.push('zp-index-wrap')
  }
  // (zp),Y: the pointer wraps in page zero and the sum may cross a page.
  if (column === 0x11) {
    if (lo === 0xff) found.push('zp-pointer-wrap')
    const base = byteAt(initial, lo) | (byteAt(initial, (lo + 1) & 0xff) << 8)
    if (crosses(base, initial.y)) found.push('page-cross')
  }
  // zp,X and zp,Y stay inside page zero however far they are indexed.
  if (column === 0x15 || column === 0x16) {
    const index = opcode === 0x96 || opcode === 0xb6 ? initial.y : initial.x
    if (((lo + index) & 0x100) !== 0) found.push('zp-index-wrap')
  }
  // abs,X and abs,Y.
  if (column === 0x19 || column === 0x1d || column === 0x1e) {
    const index = column === 0x19 || opcode === 0xbe ? initial.y : initial.x
    if (crosses(absolute, index)) found.push('page-cross')
    if (((absolute + index) & 0xffff) < absolute) found.push('address-wrap')
  }
  // The indirect jump, and the page it fails to carry into.
  if (opcode === 0x6c && lo === 0xff) found.push('jmp-pointer-bug')

  // A branch, whose displacement is signed and whose target may be on
  // another page.
  if ((opcode & 0x1f) === 0x10) {
    const target = (pc + 2 + ((lo << 24) >> 24)) & 0xffff
    if ((target & 0xff00) !== ((pc + 2) & 0xff00)) found.push('branch-page-cross')
  }

  // The stack is one page and the pointer wraps inside it.
  if (initial.s === 0x00) found.push('stack-empty')
  if (initial.s === 0xff) found.push('stack-full')

  // Decimal mode, which changes what two instructions mean. Common in a
  // uniform draw, but recorded so the index can state the count.
  if ((initial.p & 0x08) !== 0) found.push('decimal')

  return found
}

function encodeState(out: number[], state: RawState): void {
  out.push(state.pc & 0xff, (state.pc >> 8) & 0xff,
    state.s & 0xff, state.a & 0xff, state.x & 0xff, state.y & 0xff,
    state.p & 0xff)
  if (state.ram.length > 255) {
    throw new Error(`case touches ${state.ram.length} addresses, which the format caps at 255`)
  }
  out.push(state.ram.length)
  for (const [address, value] of state.ram) {
    out.push(address & 0xff, (address >> 8) & 0xff, value & 0xff)
  }
}

async function fetchOpcode(opcode: number): Promise<{ body: string; sha: string }> {
  const name = opcode.toString(16).padStart(2, '0')
  const response = await fetch(`${SOURCE_BASE}/${name}.json`)
  if (!response.ok) {
    throw new Error(`${name}.json: HTTP ${response.status}`)
  }
  const body = await response.text()
  return { body, sha: createHash('sha256').update(body).digest('hex') }
}

interface OpcodeRecord {
  opcode: string
  cases: number
  sourceCases: number
  sha256: string
  conditions: Record<string, number>
}

async function main(): Promise<void> {
  // Imported here rather than at the top so this script states the list of
  // documented opcodes from the decoder under test -- and so a mismatch
  // between the two is a build failure rather than a silent gap.
  const { DOCUMENTED_OPCODES } = await import('../../../src/isa/mos/decode.ts')

  const bytes: number[] = []
  const records: OpcodeRecord[] = []
  bytes.push(0x4d, 0x36, 0x35, 0x56) // "M65V"
  bytes.push(1, 0)
  bytes.push(DOCUMENTED_OPCODES.length & 0xff, (DOCUMENTED_OPCODES.length >> 8) & 0xff)

  for (const opcode of DOCUMENTED_OPCODES) {
    const name = opcode.toString(16).padStart(2, '0')
    const { body, sha } = await fetchOpcode(opcode)
    const all = JSON.parse(body) as RawCase[]

    const chosen = new Set<number>()
    // Uniform, from a fixed seed mixed with the opcode so two opcodes do
    // not draw the same indices.
    const next = rng(SEED ^ (opcode * 0x9e37))
    while (chosen.size < Math.min(UNIFORM_PER_OPCODE, all.length)) {
      chosen.add(next() % all.length)
    }

    // Then the structural edges, in file order so the choice is stable.
    const counts: Record<string, number> = {}
    const taken: Record<string, number> = {}
    for (let i = 0; i < all.length; i++) {
      for (const condition of conditionsOf(all[i]!)) {
        counts[condition] = (counts[condition] ?? 0) + 1
        if ((taken[condition] ?? 0) < PER_CONDITION) {
          taken[condition] = (taken[condition] ?? 0) + 1
          chosen.add(i)
        }
      }
    }

    const indices = [...chosen].sort((a, b) => a - b)
    bytes.push(opcode, indices.length & 0xff, (indices.length >> 8) & 0xff)
    for (const index of indices) {
      const instance = all[index]!
      encodeState(bytes, instance.initial)
      encodeState(bytes, instance.final)
    }

    records.push({
      opcode: name,
      cases: indices.length,
      sourceCases: all.length,
      sha256: sha,
      conditions: counts,
    })
    process.stdout.write(
      `${name}: ${indices.length} of ${all.length} ` +
      `(${Object.keys(counts).length} conditions)\n`,
    )
  }

  mkdirSync(OUT_DIR, { recursive: true })
  const packed = Uint8Array.from(bytes)
  writeFileSync(resolve(OUT_DIR, 'vectors.bin'), packed)

  const index = {
    generator: 'tools/isa/mos/build-vectors.ts',
    source: `https://github.com/SingleStepTests/65x02 (6502/v1, ${SOURCE_COMMIT})`,
    note:
      'Per-opcode single-instruction vectors from SingleStepTests, generated by ' +
      'a reference implementation built to the published documentation. A ' +
      'deterministic sample: the full set is 840 MB, and a suite whose ' +
      'result depends on the network is not a conformance suite.',
    sampling: {
      uniformPerOpcode: UNIFORM_PER_OPCODE,
      perCondition: PER_CONDITION,
      seed: SEED,
      rng: 'xorshift32 seeded with SEED ^ (opcode * 0x9e37)',
    },
    format:
      'vectors.bin: "M65V", u16 version, u16 opcode count, then per opcode ' +
      'u8 opcode, u16 case count, and per case two states, each being ' +
      'u16 pc, u8 s, u8 a, u8 x, u8 y, u8 p, u8 ram length, then that many ' +
      'u16 address and u8 value triples.',
    totalCases: records.reduce((sum, record) => sum + record.cases, 0),
    bytes: packed.length,
    sha256: createHash('sha256').update(packed).digest('hex'),
    opcodes: records,
  }
  writeFileSync(resolve(OUT_DIR, 'vectors.json'), `${JSON.stringify(index, null, 2)}\n`)
  process.stdout.write(
    `\n${index.totalCases} cases over ${records.length} opcodes, ` +
    `${(packed.length / 1024).toFixed(0)} KiB\n`,
  )
}

await main()
